import { describe, expect, it } from "vitest";
import type { UpstoxWSTick } from "../providers/upstox/types.js";
import { SnapshotBook, nextSnapshotMark } from "./live-snapshots.js";

const t = (o: Partial<UpstoxWSTick>): UpstoxWSTick => ({ instrument_token: "K", ...o });
const T1 = new Date("2026-10-23T09:20:00+05:30");
const T2 = new Date("2026-10-23T09:25:00+05:30");
const T3 = new Date("2026-10-23T09:30:00+05:30");

describe("SnapshotBook", () => {
  it("first take writes every instrument; later takes only the changed ones", () => {
    const b = new SnapshotBook();
    b.update(1, t({ last_price: 100, market_data: { oi: 5000, ltt: "2026-10-23T03:49:00.000Z" }, bid: 99.5, ask: 100.5, bid_qty: 65, ask_qty: 130, iv: 14.2, greeks: { delta: 0.42, gamma: 0.001, theta: -9.1, vega: 12.3 } }));
    b.update(2, t({ bid: 1.05, ask: 1.2 })); // never traded: quotes only
    expect(b.take(T1).map((r) => r.sid)).toEqual([1, 2]);
    expect(b.take(T2)).toEqual([]); // nothing changed
    b.update(1, t({ market_data: { oi: 6500 } })); // OI-only change, no trade
    const rows = b.take(T3);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sid: 1, ts: T3, ltp: 100, oi: 6500, bid: 99.5, iv: 14.2, delta: 0.42 });
  });

  it("keeps fields a tick does not carry", () => {
    const b = new SnapshotBook();
    b.update(1, t({ last_price: 10, volume: 1300 }));
    b.update(1, t({ bid: 9.9 }));
    expect(b.take(T1)[0]).toMatchObject({ ltp: 10, volume: 1300, bid: 9.9, ask: null, oi: null });
  });
});

describe("nextSnapshotMark", () => {
  it("returns the next IST 5-minute mark", () => {
    expect(new Date(nextSnapshotMark(Date.parse("2026-10-23T09:21:13+05:30"))).toISOString()).toBe(
      new Date("2026-10-23T09:25:00+05:30").toISOString(),
    );
    expect(nextSnapshotMark(T2.getTime())).toBe(T3.getTime()); // exactly on a mark → the next one
  });
});
