/**
 * Integration test against a REAL Postgres with infra/db/migrations applied.
 * Skipped unless TEST_DATABASE_URL is set (point it at a throwaway DB, as the app role):
 *   TEST_DATABASE_URL=postgresql://stock_app:<pw>@127.0.0.1:5432/stock_test npm run test:run
 * Every row it writes uses the "ZZTEST|" key prefix and is deleted afterwards.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createDb, upsertRows, type ClosableDb } from "./db.js";
import { CandleAggregator } from "../services/candle-aggregator.js";
import { HealthMonitor } from "../services/health-monitor.js";

const url = process.env.TEST_DATABASE_URL;
const KEY = "ZZTEST|SPOT";

async function cleanup(db: ClosableDb): Promise<void> {
  await db.query("delete from market_candles where instrument_key like 'ZZTEST|%'");
  await db.query("delete from instrument_status where instrument_key like 'ZZTEST|%'");
  await db.query("delete from backfill_state where instrument_key like 'ZZTEST|%'");
  await db.query("delete from underlying_expiries where underlying_key like 'ZZTEST|%'");
  await db.query("delete from instruments where provider_instrument_key like 'ZZTEST|%'");
}

describe.skipIf(!url)("Postgres integration", () => {
  let db: ClosableDb;

  beforeAll(async () => {
    db = createDb(url!, { max: 2 });
    await cleanup(db);
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup(db);
    await db.close();
  });

  it("upserts instruments with jsonb metadata and updates in place", async () => {
    const row = {
      provider: "upstox",
      provider_instrument_key: KEY,
      exchange: "NSE",
      segment: "NSE_INDEX",
      trading_symbol: "ZZTEST",
      name: "Test Index",
      expiry: null,
      metadata: { short_name: "zz", tags: ["a", "b"] },
    };
    await upsertRows(db, "instruments", [row], { conflict: ["provider", "provider_instrument_key"] });
    await upsertRows(db, "instruments", [{ ...row, name: "Renamed" }], {
      conflict: ["provider", "provider_instrument_key"],
    });
    const { rows } = await db.query<{ n: number; name: string; tags: string[] }>(
      "select count(*) over () as n, name, metadata->'tags' as tags from instruments where provider_instrument_key = $1",
      [KEY],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Renamed");
    expect(rows[0].tags).toEqual(["a", "b"]);
  });

  it("CandleAggregator persists candles through the real unique constraint", async () => {
    const t0 = Date.UTC(2026, 9, 9, 4, 0, 0);
    let clock = t0;
    const agg = new CandleAggregator(db, { activeIntervals: ["1m"], now: () => clock });
    expect(await agg.preloadInstrumentIds([KEY])).toEqual([]);

    await agg.processTick(KEY, 100, 5, new Date(t0 + 1_000));
    await agg.processTick(KEY, 105, 3, new Date(t0 + 30_000));
    clock = t0 + 61_000;
    await agg.processTick(KEY, 99, 1, new Date(clock)); // closes the first minute
    await agg.flushAllBuckets(); // closes the second
    await agg.flushAllBuckets(); // re-flushing must not duplicate

    const { rows } = await db.query<{ open: string; high: string; close: string; volume: string; source: string }>(
      "select open, high, close, volume, source from market_candles where instrument_key = $1 order by bucket_start",
      [KEY],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ open: "100", high: "105", close: "105", volume: "8", source: "ws" });
  });

  it("HealthMonitor writes statuses and last-tick timestamps", async () => {
    const hm = new HealthMonitor({ db, upstoxClient: {} as never, healthCheckInterval: 60_000 });
    hm.addInstruments([KEY]);
    hm.onTickReceived(KEY);
    await hm.flushWsTimestamps();
    const { rows } = await db.query<{ ws_status: string; last_ws_ts: Date | null }>(
      "select ws_status, last_ws_ts from instrument_status where instrument_key = $1",
      [KEY],
    );
    expect(rows[0].ws_status).toBe("online");
    expect(rows[0].last_ws_ts).toBeInstanceOf(Date);
    hm.stop();
  });

  it("returns DATE columns as YYYY-MM-DD strings and keeps omitted columns on update", async () => {
    await upsertRows(
      db,
      "backfill_state",
      [{ instrument_key: KEY, interval: "1d", first_date: "2024-10-03", last_date: "2026-10-08", rows_written: 7 }],
      { conflict: ["instrument_key", "interval"] },
    );
    await upsertRows(db, "backfill_state", [{ instrument_key: KEY, interval: "1d", is_final: true }], {
      conflict: ["instrument_key", "interval"],
    });
    const { rows } = await db.query<{ last_date: string; rows_written: number; is_final: boolean }>(
      "select last_date, rows_written, is_final from backfill_state where instrument_key = $1",
      [KEY],
    );
    expect(rows[0]).toEqual({ last_date: "2026-10-08", rows_written: 7, is_final: true });
  });

  it("ignoreDuplicates leaves existing rows untouched", async () => {
    const rowsOf = () =>
      db.query<{ option_count: number }>("select option_count from underlying_expiries where underlying_key = $1", [KEY]);
    await upsertRows(db, "underlying_expiries", [{ underlying_key: KEY, expiry: "2026-10-30", option_count: 40 }], {
      conflict: ["underlying_key", "expiry"],
    });
    await upsertRows(db, "underlying_expiries", [{ underlying_key: KEY, expiry: "2026-10-30" }], {
      conflict: ["underlying_key", "expiry"],
      ignoreDuplicates: true,
    });
    expect((await rowsOf()).rows[0].option_count).toBe(40);
  });
});
