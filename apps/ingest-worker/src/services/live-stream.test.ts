import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { UpstoxWebSocketLike, UpstoxWSTick } from "../providers/upstox/websocket-client.js";
import { CandleAggregator, type CandleData } from "./candle-aggregator.js";
import { LiveStream, TickFilter } from "./live-stream.js";
import type { LiveInstrument } from "./live-universe.js";

const tick = (key: string, price: number, ltt: string, volume?: number, oi?: number): UpstoxWSTick => ({
  instrument_token: key,
  last_price: price,
  volume,
  timestamp: ltt,
  market_data: { ltt, oi },
});

describe("TickFilter", () => {
  it("uses the first tick only as a baseline", () => {
    const f = new TickFilter();
    expect(f.accept(tick("K", 100, "2026-10-16T15:29:00Z", 5000))).toBeNull(); // yesterday's last trade
    const t = f.accept(tick("K", 101, "2026-10-19T03:46:00Z", 5010));
    expect(t).toEqual({ price: 101, volumeDelta: 10, timestamp: new Date("2026-10-19T03:46:00Z"), oi: undefined });
  });

  it("ignores re-sends of the same trade (depth/OI-only updates) but keeps their OI", () => {
    const f = new TickFilter();
    f.accept(tick("K", 100, "2026-10-19T03:46:00Z", 10, 500));
    expect(f.accept(tick("K", 100, "2026-10-19T03:46:00Z", 10, 650))).toBeNull();
    expect(f.duplicates).toBe(1);
    const t = f.accept(tick("K", 100, "2026-10-19T03:46:05Z", 12));
    expect(t).toMatchObject({ volumeDelta: 2, oi: 650 }); // same price, new trade → counted
  });

  it("never moves time backwards", () => {
    const f = new TickFilter();
    f.accept(tick("K", 100, "2026-10-19T03:46:00Z"));
    f.accept(tick("K", 101, "2026-10-19T03:47:00Z"));
    expect(f.accept(tick("K", 99, "2026-10-19T03:46:30Z"))).toBeNull();
  });

  it("rejects ticks without a price or time", () => {
    const f = new TickFilter();
    expect(f.accept({ instrument_token: "K" })).toBeNull();
    expect(f.size()).toBe(0);
  });
});

class FakeSocket extends EventEmitter implements UpstoxWebSocketLike {
  readyState = 0;
  readonly sent: Buffer[] = [];
  ping = vi.fn();
  send(data: Buffer, cb?: (e?: Error) => void) { this.sent.push(data); cb?.(); }
  close() { this.readyState = 3; this.emit("close", 1000, Buffer.from("")); }
  open() { this.readyState = 1; this.emit("open"); }
  drop() { this.readyState = 3; this.emit("close", 1006, Buffer.from("")); }
}

const inst = (feedKey: string, storeKey: string): LiveInstrument => ({
  feedKey, storeKey, sid: 1, kind: "option", underlyingKey: "U", expiry: "2026-10-20",
});

describe("LiveStream", () => {
  afterEach(() => vi.useRealTimers());

  it("subscribes each account to its shard, and feeds trades under the permanent key", async () => {
    const sockets: FakeSocket[] = [];
    const saved: CandleData[] = [];
    let now = Date.parse("2026-10-19T03:46:10Z");
    const aggregator = new CandleAggregator({} as never, {
      activeIntervals: ["1m"],
      now: () => now,
      sink: { persist: async (c) => void saved.push(...c) },
    });
    const stream = new LiveStream({
      shards: [
        { alias: "a1", upstoxClient: { authorizeMarketDataFeed: async () => "wss://x/1" }, instruments: [inst("NSE_FO|1", "NSE_FO|1|20-10-2026")] },
        { alias: "a2", upstoxClient: { authorizeMarketDataFeed: async () => "wss://x/2" }, instruments: [inst("NSE_FO|2", "NSE_FO|2|20-10-2026")] },
      ],
      aggregator,
      socketFactory: () => { const s = new FakeSocket(); sockets.push(s); return s; },
      now: () => now,
    });
    stream.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets.forEach((s) => s.open());
    expect(sockets.every((s) => s.sent.length === 1)).toBe(true);
    expect(stream.getStatus().connected).toBe("2/2");

    stream.handleTick(tick("NSE_FO|1", 100, "2026-10-19T03:46:00Z", 10)); // baseline
    stream.handleTick(tick("NSE_FO|1", 102, "2026-10-19T03:46:05Z", 15));
    stream.handleTick(tick("NSE_FO|9", 1, "2026-10-19T03:46:05Z")); // not ours
    now = Date.parse("2026-10-19T03:47:00Z");
    await stream.stop();
    expect(saved).toEqual([
      expect.objectContaining({ instrument_key: "NSE_FO|1|20-10-2026", open: 102, close: 102, volume: 5 }),
    ]);
    expect(stream.unknownTicks).toBe(1);
  });

  it("calls onAllDown once every connection has been down for the limit", async () => {
    let now = 0;
    const sockets: FakeSocket[] = [];
    const onAllDown = vi.fn();
    const stream = new LiveStream({
      shards: [{ alias: "a1", upstoxClient: { authorizeMarketDataFeed: async () => "wss://x" }, instruments: [] }],
      aggregator: new CandleAggregator({} as never, { sink: { persist: async () => {} } }),
      socketFactory: () => { const s = new FakeSocket(); sockets.push(s); return s; },
      now: () => now,
      allDownLimitMs: 600_000,
      onAllDown,
    });
    stream.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].open();
    now = 1_000;
    sockets[0].drop(); // reconnect timer starts; stays down
    now = 500_000;
    stream.checkWatchdog();
    expect(onAllDown).not.toHaveBeenCalled();
    now = 601_000;
    stream.checkWatchdog();
    stream.checkWatchdog();
    expect(onAllDown).toHaveBeenCalledTimes(1);
    await stream.stop();
  });
});
