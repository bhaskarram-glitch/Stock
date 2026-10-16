/**
 * backfillActive against a REAL Postgres with infra/db/migrations applied (skipped unless
 * TEST_DATABASE_URL is set). Upstox is replaced by a fake pool. Rows use the ZZTEST prefix/tokens
 * 990001.. and are removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createDb, type ClosableDb } from "../lib/db.js";
import { UpstoxApiError, type UpstoxHistoricalClientPool, type HistoricalCandle } from "../providers/upstox/historical.js";
import type { ResolvedUnderlying } from "../providers/upstox/indices.js";
import { backfillActive, type BackfillArgs } from "./backfill-history.js";

const url = process.env.TEST_DATABASE_URL;
const UNDERLYING = "ZZTEST_INDEX|ZZ";
const ACTIVE_KEY = "NSE_FO|990001"; // trading key
const CANON_KEY = "NSE_FO|990001|30-12-2099"; // permanent key
const EXPIRING_ACTIVE = "BSE_FO|990002";
const EXPIRING_CANON = "BSE_FO|990002|30-12-2099";
const UNSUPPORTED_ACTIVE = "NSE_FO|990003";
const UNSUPPORTED_CANON = "NSE_FO|990003|30-12-2099";

const day = (d: string, close: number): HistoricalCandle => ({
  ts: `${d}T09:15:00+05:30`, open: close, high: close + 1, low: close - 1, close, volume: 10, oi: 5,
});

function fakePool(byKey: Record<string, HistoricalCandle[]>, calls: string[]): UpstoxHistoricalClientPool {
  return {
    getHistoricalCandles: async (key: string, _u: string, _i: number, from: string, to: string) => {
      calls.push(`${key} ${from}..${to}`);
      if (key === UNSUPPORTED_ACTIVE) {
        throw new UpstoxApiError("Instrument key is of invalid format", 400, "UDAPI1021", null);
      }
      return (byKey[key] ?? []).filter((c) => c.ts.slice(0, 10) >= from && c.ts.slice(0, 10) <= to);
    },
    usage: () => ({ lastThirtyMinutes: 0, budgetThirtyMinutes: 0, perAccount: {} }),
  } as unknown as UpstoxHistoricalClientPool;
}

const args: BackfillArgs = { target: "active", symbols: null, from: "2026-01-01", limit: 0, dryRun: false };
const underlyings = [{ symbol: "ZZ", instrumentKey: UNDERLYING, instrumentId: "x" }] as unknown as ResolvedUnderlying[];

async function cleanup(db: ClosableDb) {
  await db.query("delete from market_candles where instrument_key like any(array['NSE_FO|99000%','BSE_FO|99000%'])");
  await db.query("delete from backfill_state where instrument_key like any(array['NSE_FO|99000%','BSE_FO|99000%'])");
  await db.query("delete from instruments where provider_instrument_key like any(array['NSE_FO|99000%','BSE_FO|99000%'])");
}

describe.skipIf(!url)("backfillActive (Postgres)", () => {
  let db: ClosableDb;

  beforeAll(async () => {
    db = createDb(url!, { max: 2 });
    await cleanup(db);
    // Two still-trading contracts as the instrument sync stores them (trading keys)…
    await db.query(
      `insert into instruments (provider, provider_instrument_key, exchange, segment, trading_symbol, name,
         instrument_type, exchange_token, underlying_key, expiry, strike, option_type)
       values ('upstox', $1, 'NSE', 'NSE_FO', 'ZZ 100 CE', 'ZZ', 'CE', '990001', $3, '2099-12-30', 100, 'CE'),
              ('upstox', $2, 'BSE', 'BSE_FO', 'ZZ 100 PE', 'ZZ', 'PE', '990002', $3, '2099-12-30', 100, 'PE'),
              ('upstox', $4, 'NSE', 'NSE_FO', 'ZZ 200 CE', 'ZZ', 'CE', '990003', $3, '2099-12-30', 200, 'CE')`,
      [ACTIVE_KEY, EXPIRING_ACTIVE, UNDERLYING, UNSUPPORTED_ACTIVE],
    );
    // …and the second one already registered by an expired run (must stay is_expired = true).
    await db.query(
      `insert into instruments (provider, provider_instrument_key, exchange, segment, trading_symbol, name,
         exchange_token, underlying_key, expiry, strike, option_type, is_expired, is_active)
       values ('upstox', $1, 'BSE', 'BSE_FO', 'ZZ 100 PE', 'ZZ', '990002', $2, '2099-12-30', 100, 'PE', true, false)`,
      [EXPIRING_CANON, UNDERLYING],
    );
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup(db);
    await db.close();
  });

  it("stores candles under the permanent key, then resumes from the watermark", async () => {
    const calls: string[] = [];
    const data = { [ACTIVE_KEY]: [day("2026-03-02", 10), day("2026-03-03", 11)] };
    await backfillActive(db, fakePool(data, calls), underlyings, args);

    const { rows } = await db.query<{ instrument_key: string; n: number; source: string }>(
      "select instrument_key, count(*)::int as n, min(source::text) as source from market_candles where instrument_key like 'NSE_FO|990001%' group by 1",
    );
    expect(rows).toEqual([{ instrument_key: CANON_KEY, n: 2, source: "hist" }]);

    const state = await db.query<{ last_date: string; is_final: boolean }>(
      "select last_date, is_final from backfill_state where instrument_key = $1", [CANON_KEY]);
    expect(state.rows[0]).toEqual({ last_date: "2026-03-03", is_final: false });

    // Second run asks only for what is missing, and writes nothing twice.
    calls.length = 0;
    await backfillActive(db, fakePool(data, calls), underlyings, args);
    expect(calls.find((c) => c.startsWith(ACTIVE_KEY))).toMatch(/^NSE_FO\|990001 2026-03-04\.\./);
    const again = await db.query<{ n: number }>("select count(*)::int as n from market_candles where instrument_key = $1", [CANON_KEY]);
    expect(again.rows[0].n).toBe(2);
  });

  it("never flips a contract the expired run already registered back to active", async () => {
    const { rows } = await db.query<{ is_expired: boolean; n: number }>(
      "select bool_and(is_expired) as is_expired, count(*)::int as n from instruments where provider_instrument_key = $1",
      [EXPIRING_CANON],
    );
    expect(rows[0]).toEqual({ is_expired: true, n: 1 });
  });

  it("records a key Upstox rejects (UDAPI1021) once, without an error, and never asks again", async () => {
    const st = await db.query<{ is_final: boolean; last_error: string | null; skip_reason: string | null }>(
      "select is_final, last_error, skip_reason from backfill_state where instrument_key = $1", [UNSUPPORTED_CANON]);
    expect(st.rows[0]).toEqual({ is_final: true, last_error: null, skip_reason: "Instrument key is of invalid format" });

    const calls: string[] = [];
    await backfillActive(db, fakePool({}, calls), underlyings, args);
    expect(calls.some((c) => c.startsWith(UNSUPPORTED_ACTIVE))).toBe(false);
  });
});
