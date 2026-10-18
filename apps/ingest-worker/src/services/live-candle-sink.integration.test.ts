/**
 * LiveCandleSink against a REAL Postgres with infra/db/migrations applied (skipped unless
 * TEST_DATABASE_URL is set). Writes as the app role when TEST_APP_DATABASE_URL is set, which proves
 * stock_app can create the day/month partitions through ensure_live_partitions(). Uses sids
 * 2000000001.. and the far-future day 2099-12-30; all removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createDb, type ClosableDb } from "../lib/db.js";
import type { CandleData } from "./candle-aggregator.js";
import { LiveCandleSink } from "./live-candle-sink.js";

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL ?? ownerUrl;
const SID = 2_000_000_001;
const DAY = "2099-12-30";

const candle = (interval: CandleData["interval"], ist: string, o: Partial<CandleData> = {}): CandleData => ({
  instrument_key: "ZZ|LIVE|1",
  interval,
  bucket_start: new Date(`${DAY}T${ist}:00+05:30`),
  open: 100, high: 105, low: 95, close: 101, volume: 10, tick_count: 3, oi: 500,
  ...o,
});

async function dropTestPartitions(db: ClosableDb) {
  await db.query("drop table if exists live_candles_fine_20991230, live_candles_209912");
}

describe.skipIf(!ownerUrl)("LiveCandleSink (Postgres)", () => {
  let owner: ClosableDb;
  let app: ClosableDb;

  beforeAll(async () => {
    owner = createDb(ownerUrl!, { max: 1 });
    app = createDb(appUrl!, { max: 1 });
    await dropTestPartitions(owner);
  });

  afterAll(async () => {
    await dropTestPartitions(owner);
    await app.close();
    await owner.close();
  });

  it("creates partitions, splits fine/coarse, and merges a bucket written twice", async () => {
    const sink = new LiveCandleSink(app, new Map([["ZZ|LIVE|1", SID]]), []);
    await sink.persist([
      candle("1m", "09:15"),
      candle("5m", "09:15"),
      candle("15m", "09:15"),
      candle("1h", "09:15"),
      candle("1d", "00:00"), // not a live interval → dropped
      { ...candle("1m", "09:16"), instrument_key: "UNKNOWN" }, // unknown key → dropped
    ]);
    // worker restarted inside the 09:15 bucket: second half of the same minute
    await sink.persist([candle("1m", "09:15", { open: 999, high: 110, low: 99, close: 108, volume: 4, oi: undefined })]);

    const { rows } = await owner.query<Record<string, unknown>>(
      `select tableoid::regclass::text as part, interval_min, open, high, low, close, volume::int, oi::int
         from (select tableoid, * from live_candles_fine union all select tableoid, * from live_candles) x
        where sid = $1 order by interval_min`,
      [SID],
    );
    expect(rows).toEqual([
      { part: "live_candles_fine_20991230", interval_min: 1, open: 100, high: 110, low: 95, close: 108, volume: 14, oi: 500 },
      { part: "live_candles_fine_20991230", interval_min: 5, open: 100, high: 105, low: 95, close: 101, volume: 10, oi: 500 },
      { part: "live_candles_209912", interval_min: 15, open: 100, high: 105, low: 95, close: 101, volume: 10, oi: 500 },
      { part: "live_candles_209912", interval_min: 60, open: 100, high: 105, low: 95, close: 101, volume: 10, oi: 500 },
    ]);
    expect(sink.getStats()).toEqual({ written: 5, droppedUnknown: 2, failedBatches: 0 });
  });

  it("stores index spots with volume NULL", async () => {
    const sink = new LiveCandleSink(app, new Map([["ZZ|LIVE|1", SID]]), [], new Set(["ZZ|LIVE|1"]));
    await sink.persist([candle("1m", "11:00", { volume: 0, oi: undefined })]);
    const { rows } = await owner.query(
      "select volume, oi from live_candles_fine where sid = $1 and bucket_start = $2",
      [SID, `${DAY}T11:00:00+05:30`],
    );
    expect(rows).toEqual([{ volume: null, oi: null }]);
  });

  it("merges duplicates inside one batch", async () => {
    const sink = new LiveCandleSink(app, new Map([["ZZ|LIVE|1", SID]]), []);
    await sink.persist([
      candle("1m", "10:00", { high: 101, low: 100, close: 100.5, volume: 1 }),
      candle("1m", "10:00", { high: 103, low: 99, close: 102, volume: 2 }),
    ]);
    const { rows } = await owner.query(
      "select high, low, close, volume::int from live_candles_fine where sid = $1 and bucket_start = $2",
      [SID, `${DAY}T10:00:00+05:30`],
    );
    expect(rows).toEqual([{ high: 103, low: 99, close: 102, volume: 3 }]);
  });
});
