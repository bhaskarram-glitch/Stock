/**
 * Job: verify every configured Upstox account before a long run.
 *
 * Run: npm run accounts:check
 *
 * For each account: one cheap historical-candle call (NIFTY spot, one day). Upstox Plus is then
 * checked on the first hist account via one expired-expiries call. Costs ~N+1 requests in total.
 * Tokens are never printed — only alias, roles and a 6-char fingerprint.
 *
 * Exit codes: 0 all accounts OK · 1 at least one account failed · 2 no accounts configured
 */
import "dotenv/config.js";
import { describeAccount, loadConfig } from "../config.js";
import { logger } from "../lib/logger.js";
import {
  UpstoxApiError,
  UpstoxHistoricalClient,
} from "../providers/upstox/historical.js";

const PROBE_KEY = "NSE_INDEX|Nifty 50";

function lastWeekday(): string {
  const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6)
    d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function reason(error: unknown): string {
  if (error instanceof UpstoxApiError) {
    if (error.status === 401)
      return "401 — token invalid or expired (regenerate the Analytics Token)";
    if (error.isPlusRequired)
      return "UDAPI1149 — Upstox Plus not active on this account";
    if (error.isRateLimit)
      return "429 — rate limited right now; retry in a few minutes";
    return `${error.status} ${error.code ?? ""} ${error.message}`.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const accounts = config.upstoxAccounts.all;
  if (accounts.length === 0) {
    logger.error("No Upstox accounts configured", {
      hint: "Set UPSTOX_ACCOUNT_1_TOKEN (see .env.example)",
    });
    process.exit(2);
  }

  const day = lastWeekday();
  let failures = 0;
  let firstHistOk: UpstoxHistoricalClient | null = null;

  for (const account of accounts) {
    const client = new UpstoxHistoricalClient(account.token, {
      baseUrl: config.upstoxBaseUrl,
      alias: account.alias,
    });
    try {
      const candles = await client.getHistoricalCandles(
        PROBE_KEY,
        "days",
        1,
        day,
        day,
      );
      logger.info("ACCOUNT OK", {
        ...describeAccount(account),
        probeDay: day,
        candles: candles.length,
      });
      if (!firstHistOk && account.roles.includes("hist")) firstHistOk = client;
    } catch (error) {
      failures += 1;
      logger.error("ACCOUNT FAIL", {
        ...describeAccount(account),
        reason: reason(error),
      });
    }
  }

  // Plus is required for expired-contract history; check it once on a working hist account.
  if (firstHistOk) {
    try {
      const expiries = await firstHistOk.getExpiries(PROBE_KEY);
      logger.info("PLUS OK", {
        account: firstHistOk.alias,
        expiries: expiries.length,
      });
    } catch (error) {
      failures += 1;
      logger.error("PLUS FAIL", {
        account: firstHistOk.alias,
        reason: reason(error),
      });
    }
  }

  const hist = config.upstoxAccounts.forRole("hist").length;
  const ws = config.upstoxAccounts.forRole("ws").length;
  logger.info("Account check finished", {
    accounts: accounts.length,
    failed: failures,
    histAccounts: hist,
    wsAccounts: ws,
    candleRequestsPerHour: hist * 1800,
  });
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error) => {
  logger.error("Account check crashed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
