import { describe, expect, it, vi } from "vitest";
import { CandleAggregator } from "./candle-aggregator.js";
import { CumulativeVolumeTracker } from "./volume-tracker.js";
import { fakeDb } from "../test-utils/fake-db.js";

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function mockDb(instrumentIds: Record<string, string>) {
  let instrumentQueries = 0;
  const db = fakeDb((text, values) => {
    if (!text.includes("from instruments")) return [];
    instrumentQueries += 1;
    return (values[0] as string[])
      .filter((k) => instrumentIds[k])
      .map((k) => ({ id: instrumentIds[k], provider_instrument_key: k }));
  });
  return {
    client: db,
    /** one entry per INSERT statement, holding that statement's rows */
    get upserts(): Row[][] {
      const per: Row[][] = [];
      let offset = 0;
      const all = db.inserted("market_candles");
      for (const st of db.statements.filter((x) => x.text.startsWith('insert into "market_candles"'))) {
        const n = st.values.length / 10;
        per.push(all.slice(offset, offset + n));
        offset += n;
      }
      return per;
    },
    rows: () => db.inserted("market_candles"),
    instrumentQueries: () => instrumentQueries,
  };
}

const KEY = "NSE_EQ|INE002A01018";
const T0 = Date.UTC(2026, 8, 11, 4, 0, 0); // 09:30 IST, on a 1h boundary

function makeAggregator(ids: Record<string, string> = { [KEY]: "uuid-1" }) {
  let clock = T0;
  const db = mockDb(ids);
  const agg = new CandleAggregator(db.client, {
    activeIntervals: ["1m"],
    now: () => clock,
  });
  const tick = (
    offsetMs: number,
    price: number,
    vol: number,
    advanceClock = true,
  ) => {
    if (advanceClock) clock = T0 + offsetMs;
    return agg.processTick(KEY, price, vol, new Date(T0 + offsetMs));
  };
  const setClock = (offsetMs: number) => {
    clock = T0 + offsetMs;
  };
  return { agg, db, tick, setClock };
}

// ---------------------------------------------------------------------------
// CumulativeVolumeTracker
// ---------------------------------------------------------------------------

describe("CumulativeVolumeTracker", () => {
  it("returns 0 on first observation and deltas afterwards", () => {
    const t = new CumulativeVolumeTracker();
    expect(t.delta(KEY, 1000)).toBe(0);
    expect(t.delta(KEY, 1250)).toBe(250);
    expect(t.delta(KEY, 1250)).toBe(0);
    expect(t.delta(KEY, 1300)).toBe(50);
  });

  it("treats a decrease as a day rollover", () => {
    const t = new CumulativeVolumeTracker();
    t.delta(KEY, 5_000_000);
    expect(t.delta(KEY, 120)).toBe(120);
    expect(t.delta(KEY, 200)).toBe(80);
  });

  it("ignores missing or invalid volume without touching state", () => {
    const t = new CumulativeVolumeTracker();
    t.delta(KEY, 100);
    expect(t.delta(KEY, undefined)).toBe(0);
    expect(t.delta(KEY, Number.NaN)).toBe(0);
    expect(t.delta(KEY, -5)).toBe(0);
    expect(t.delta(KEY, 150)).toBe(50);
  });

  it("tracks instruments independently and supports reset", () => {
    const t = new CumulativeVolumeTracker();
    t.delta("A", 100);
    t.delta("B", 10);
    expect(t.delta("A", 130)).toBe(30);
    expect(t.delta("B", 15)).toBe(5);
    t.reset("A");
    expect(t.delta("A", 200)).toBe(0);
    expect(t.delta("B", 20)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// CandleAggregator
// ---------------------------------------------------------------------------

describe("CandleAggregator", () => {
  it("sums volume deltas (not cumulative totals) into a candle", async () => {
    const { agg, db, tick } = makeAggregator();
    await tick(0, 100, 0);
    await tick(10_000, 101, 40);
    await tick(20_000, 99, 60);
    await tick(60_000, 102, 5); // next bucket → closes the first
    await agg.drain();

    const rows = db.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      instrument_id: "uuid-1",
      instrument_key: KEY,
      interval: "1m",
      bucket_start: new Date(T0).toISOString(),
      open: 100,
      high: 101,
      low: 99,
      close: 99,
      volume: 100,
      source: "ws",
    });
  });

  it("closes a bucket on wall-clock expiry without needing a later tick", async () => {
    const { agg, db, tick, setClock } = makeAggregator();
    await tick(5_000, 100, 10);
    await agg.flushExpiredBuckets();
    expect(db.rows()).toHaveLength(0); // still inside the minute

    setClock(61_000);
    await agg.flushExpiredBuckets();
    expect(db.rows()).toHaveLength(1);
    expect(agg.getStats().activeBuckets).toBe(0);
  });

  it("drops a late tick for an already-closed bucket instead of overwriting open", async () => {
    const { agg, db, tick } = makeAggregator();
    await tick(0, 100, 0);
    await tick(60_000, 110, 10); // closes bucket T0
    await tick(30_000, 50, 5, false); // late tick for bucket T0
    await agg.drain();

    const t0Rows = db
      .rows()
      .filter((r) => r.bucket_start === new Date(T0).toISOString());
    expect(t0Rows).toHaveLength(1);
    expect(t0Rows[0].open).toBe(100);
    expect(agg.getStats().droppedLateTicks).toBe(1);
  });

  it("flushAllBuckets persists every open bucket and waits for the write", async () => {
    const { agg, db, tick } = makeAggregator();
    await tick(0, 100, 0);
    await agg.flushAllBuckets();
    expect(db.rows()).toHaveLength(1);
    expect(agg.getStats().activeBuckets).toBe(0);
    expect(agg.getStats().pendingPersist).toBe(0);
  });

  it("resolves instrument ids once and batches multi-row upserts", async () => {
    const { agg, db, tick } = makeAggregator();
    agg.setActiveIntervals(["1m", "5m"]);
    await tick(0, 100, 0);
    await tick(5 * 60_000, 101, 1); // closes both 1m and 5m buckets
    await agg.drain();

    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0]).toHaveLength(2);
    expect(db.instrumentQueries()).toBe(1);
  });

  it("preloadInstrumentIds reports missing keys and persistence drops them", async () => {
    const { agg, db, tick } = makeAggregator({ [KEY]: "uuid-1" });
    const missing = await agg.preloadInstrumentIds([KEY, "NSE_EQ|UNKNOWN"]);
    expect(missing).toEqual(["NSE_EQ|UNKNOWN"]);

    await agg.processTick("NSE_EQ|UNKNOWN", 10, 0, new Date(T0));
    await tick(0, 100, 0);
    await agg.flushAllBuckets();
    expect(db.rows().map((r) => r.instrument_key)).toEqual([KEY]);
  });

  it("aligns 1d buckets to IST midnight", async () => {
    const db = mockDb({ [KEY]: "uuid-1" });
    const agg = new CandleAggregator(db.client, {
      activeIntervals: ["1d"],
      now: () => T0,
    });
    await agg.processTick(KEY, 100, 0, new Date(T0));
    await agg.flushAllBuckets();
    // 2026-09-11 00:00 IST == 2026-09-10 18:30 UTC
    expect(db.rows()[0].bucket_start).toBe("2026-09-10T18:30:00.000Z");
  });
});
