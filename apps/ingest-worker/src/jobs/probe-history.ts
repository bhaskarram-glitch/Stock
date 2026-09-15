/**
 * Job: probe the Upstox history APIs (Phase 2.0 decision gate).
 * Run: npm run probe:history
 * Env: UPSTOX_ANALYTICS_TOKEN (or UPSTOX_ACCOUNTS with a "hist" role)
 *
 * Round 1 (2026-09-13) established: index spot daily reaches 2010; expiries cover
 * 2024-10 → today; contracts for 2022 return 0 rows. Round 2 measures what a
 * backfill actually costs: candles per contract, and the share of dead rows.
 */
import "dotenv/config.js";
import { loadConfig } from "../config.js";
import { logger } from "../lib/logger.js";
import {
  UpstoxApiError,
  UpstoxHistoricalClient,
  type ExpiredContract,
} from "../providers/upstox/historical.js";

const NIFTY = "NSE_INDEX|Nifty 50";
const SENSEX = "BSE_INDEX|SENSEX";

async function step<T>(
  name: string,
  fn: () => Promise<T>,
  summarize: (r: T) => Record<string, unknown>,
): Promise<T | null> {
  try {
    const result = await fn();
    logger.info(`PROBE OK  ${name}`, summarize(result));
    return result;
  } catch (error) {
    const detail =
      error instanceof UpstoxApiError
        ? {
            status: error.status,
            code: error.code,
            plusRequired: error.isPlusRequired,
            message: error.message,
          }
        : { message: error instanceof Error ? error.message : String(error) };
    logger.error(`PROBE FAIL ${name}`, detail);
    return null;
  }
}

/** Trading-day span we ask for: contracts list ~2 months before expiry for weeklies, longer for monthlies. */
function windowStart(expiry: string, days: number): string {
  const d = new Date(`${expiry}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const account = config.upstoxAccounts.require("hist");
  const client = new UpstoxHistoricalClient(account.token, {
    baseUrl: config.upstoxBaseUrl,
  });
  logger.info("Probing Upstox history APIs", { account: account.alias });

  // ---- 1. How far back does index spot daily go? --------------------------
  for (const [name, key, from, to] of [
    ["NIFTY 2015", NIFTY, "2015-01-01", "2015-01-31"],
    ["NIFTY 2000", NIFTY, "2000-01-01", "2000-01-31"],
    ["SENSEX 2015", SENSEX, "2015-01-01", "2015-01-31"],
  ] as const) {
    await step(
      `spot daily ${name}`,
      () => client.getHistoricalCandles(key, "days", 1, from, to),
      (c) => ({ candles: c.length, first: c.at(-1)?.ts }),
    );
  }

  // ---- 2. Expiry coverage --------------------------------------------------
  const expiries =
    (await step(
      "NIFTY expiries",
      () => client.getExpiries(NIFTY),
      (e) => ({
        count: e.length,
        earliest: e[0],
        latest: e.at(-1),
      }),
    )) ?? [];
  if (expiries.length === 0) {
    logger.error("No expiries returned — cannot continue");
    return;
  }
  const earliest = expiries[0];
  const recent = expiries[expiries.length - 1];

  // ---- 3. Contracts + futures at the earliest available expiry -------------
  const contracts =
    (await step(
      `option contracts ${earliest}`,
      () => client.getExpiredOptionContracts(NIFTY, earliest),
      (c) => ({
        contracts: c.length,
        strikes: new Set(c.map((x) => x.strike_price)).size,
        sampleKey: c[0]?.instrument_key,
        weekly: c[0]?.weekly,
      }),
    )) ?? [];
  await step(
    `future contracts ${earliest}`,
    () => client.getExpiredFutureContracts(NIFTY, earliest),
    (c) => ({
      contracts: c.length,
      sampleKey: c[0]?.instrument_key,
    }),
  );
  await step(
    `option contracts ${recent} (latest)`,
    () => client.getExpiredOptionContracts(NIFTY, recent),
    (c) => ({ contracts: c.length }),
  );

  // ---- 4. Do expired-contract candles work at all? -------------------------
  const atm =
    [...contracts].sort((a, b) => (b.lot_size ?? 0) - (a.lot_size ?? 0))[0] ??
    contracts[0];
  if (atm) {
    await step(
      `expired daily candles ${atm.trading_symbol}`,
      () =>
        client.getExpiredHistoricalCandles(
          atm.instrument_key,
          "day",
          windowStart(atm.expiry, 120),
          atm.expiry,
        ),
      (c) => ({
        candles: c.length,
        first: c.at(-1)?.ts,
        last: c[0]?.ts,
        lastRow: c[0],
      }),
    );
  }

  // ---- 5. Cost model: sample 60 contracts across the strike range ----------
  const sample = pickSpread(contracts, 60);
  let rows = 0,
    dead = 0,
    empty = 0,
    withOi = 0,
    failed = 0;
  const t0 = Date.now();
  for (const c of sample) {
    try {
      const candles = await client.getExpiredHistoricalCandles(
        c.instrument_key,
        "day",
        windowStart(c.expiry, 120),
        c.expiry,
      );
      if (candles.length === 0) empty += 1;
      rows += candles.length;
      dead += candles.filter((k) => k.volume === 0 && (k.oi ?? 0) === 0).length;
      withOi += candles.filter((k) => k.oi !== null).length;
    } catch {
      failed += 1;
    }
  }
  const elapsedMs = Date.now() - t0;
  logger.info("PROBE COST MODEL", {
    sampledContracts: sample.length,
    contractsWithNoCandles: empty,
    failedRequests: failed,
    totalRows: rows,
    rowsPerContract: sample.length ? +(rows / sample.length).toFixed(1) : null,
    deadRowsPct: rows ? Math.round((dead / rows) * 100) : null,
    rowsWithOiPct: rows ? Math.round((withOi / rows) * 100) : null,
    msPerRequest: sample.length ? Math.round(elapsedMs / sample.length) : null,
    projectedContractsAllExpiries: contracts.length * expiries.length,
    projectedRowsAllExpiries: sample.length
      ? Math.round((rows / sample.length) * contracts.length * expiries.length)
      : null,
    projectedHoursAllExpiries: sample.length
      ? +(
          ((elapsedMs / sample.length) * contracts.length * expiries.length) /
          3_600_000
        ).toFixed(1)
      : null,
  });

  logger.info("Probe finished");
}

/** Evenly spaced sample across the contract list (covers deep OTM through ATM). */
function pickSpread(
  contracts: ExpiredContract[],
  n: number,
): ExpiredContract[] {
  if (contracts.length <= n) return contracts;
  const stride = contracts.length / n;
  return Array.from({ length: n }, (_, i) => contracts[Math.floor(i * stride)]);
}

main().catch((error) => {
  logger.error("Probe crashed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
