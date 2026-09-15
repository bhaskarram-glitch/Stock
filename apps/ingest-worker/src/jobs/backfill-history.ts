/**
 * Job: backfill daily OHLC history into `market_candles`.
 *
 * Run: npm run backfill -- <target> [options]
 *   target: spot | options | futures | all
 *   --symbols NIFTY,SENSEX   limit to these underlyings (default: all 9 F&O indices)
 *   --from 2024-10-03        earliest date to request (default: HISTORY_FLOOR)
 *   --limit 500              max instruments to process this run (default: unlimited)
 *   --dry-run                fetch nothing, just report what would run
 *
 * Incremental behaviour (`backfill_state` watermarks):
 *   - An expired contract's candles never change. Once loaded through its expiry it is marked
 *     `is_final` and skipped on every later run — this is where nearly all the saving is.
 *   - Everything else resumes from `last_date + 1`, so a second run today fetches nothing and a
 *     run next week fetches only the days since.
 *   - `underlying_expiries` remembers which expiries have had their contracts enumerated, so
 *     contract listing isn't repeated either.
 *
 * Daily candles are stored at IST midnight to match the live aggregator's 1d buckets; Upstox
 * returns them stamped at the 09:15 IST open.
 */
import "dotenv/config.js";
import { loadConfig } from "../config.js";
import { logger } from "../lib/logger.js";
import { getSupabaseClient } from "../lib/supabase.js";
import type { Database, Json } from "../lib/database.types.js";
import {
  UpstoxApiError,
  UpstoxHistoricalClient,
  type ExpiredContract,
  type HistoricalCandle,
} from "../providers/upstox/historical.js";
import {
  FNO_INDEX_UNDERLYINGS,
  resolveUnderlyings,
  type IndexInstrumentRow,
  type ResolvedUnderlying,
} from "../providers/upstox/indices.js";

type SupabaseDb = ReturnType<typeof getSupabaseClient>;
type CandleRow = Database["public"]["Tables"]["market_candles"]["Insert"];
type InstrumentRow = Database["public"]["Tables"]["instruments"]["Insert"];

/** Options/futures contract history does not exist before this date (probe, 2026-09-14). */
const HISTORY_FLOOR = "2024-10-03";
const CONTRACT_LOOKBACK_DAYS = 1250;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const CANDLE_BATCH = 500;
const MAX_RETRIES = 3;

type Target = "spot" | "options" | "futures" | "all";

interface Args {
  target: Target;
  symbols: string[] | null;
  from: string;
  limit: number;
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

function todayIst(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function earlier(a: string, b: string): string {
  return a <= b ? a : b;
}

/** Upstox stamps daily candles at 09:15 IST; normalise to IST midnight (the 1d bucket start). */
function toDailyBucketStart(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime()))
    throw new Error(`Unparseable candle timestamp: ${ts}`);
  const istDate = new Date(date.getTime() + IST_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
  return new Date(`${istDate}T00:00:00+05:30`).toISOString();
}

// ---------------------------------------------------------------------------
// backfill_state
// ---------------------------------------------------------------------------

interface BackfillState {
  instrument_key: string;
  first_date: string | null;
  last_date: string | null;
  is_final: boolean;
  rows_written: number;
}

async function loadStates(
  db: SupabaseDb,
  keys: string[],
): Promise<Map<string, BackfillState>> {
  const states = new Map<string, BackfillState>();
  for (let i = 0; i < keys.length; i += 500) {
    const { data, error } = await db
      .from("backfill_state")
      .select("instrument_key, first_date, last_date, is_final, rows_written")
      .eq("interval", "1d")
      .in("instrument_key", keys.slice(i, i + 500));
    if (error)
      throw new Error(`Failed to load backfill_state: ${error.message}`);
    for (const row of data ?? [])
      states.set(row.instrument_key, row as BackfillState);
  }
  return states;
}

async function saveState(
  db: SupabaseDb,
  key: string,
  patch: {
    first_date?: string | null;
    last_date?: string | null;
    is_final?: boolean;
    rows_written?: number;
    last_error?: string | null;
  },
): Promise<void> {
  const { error } = await db.from("backfill_state").upsert(
    {
      instrument_key: key,
      interval: "1d",
      last_run_at: new Date().toISOString(),
      ...patch,
    },
    { onConflict: "instrument_key,interval" },
  );
  if (error)
    logger.error("Failed to save backfill_state", {
      instrumentKey: key,
      error: error.message,
    });
}

// ---------------------------------------------------------------------------
// Candle persistence
// ---------------------------------------------------------------------------

async function writeCandles(
  db: SupabaseDb,
  instrumentId: string,
  instrumentKey: string,
  candles: HistoricalCandle[],
  source: "hist" | "hist_expired",
): Promise<number> {
  if (candles.length === 0) return 0;
  const rows: CandleRow[] = candles.map((c) => ({
    instrument_id: instrumentId,
    instrument_key: instrumentKey,
    interval: "1d",
    bucket_start: toDailyBucketStart(c.ts),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    oi: source === "hist" && (c.oi === 0 || c.oi === null) ? null : c.oi,
    source,
  }));

  let written = 0;
  for (let i = 0; i < rows.length; i += CANDLE_BATCH) {
    const batch = rows.slice(i, i + CANDLE_BATCH);
    const { error } = await db
      .from("market_candles")
      .upsert(batch, { onConflict: "instrument_key,interval,bucket_start" });
    if (error) throw new Error(`Candle upsert failed: ${error.message}`);
    written += batch.length;
  }
  return written;
}

/** Retries transient failures; honours Retry-After on 429. Plus/permission errors fail immediately. */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (error instanceof UpstoxApiError) {
        if (
          error.isPlusRequired ||
          error.status === 401 ||
          error.status === 403
        )
          throw error;
        if (error.isRateLimit) {
          const wait = error.retryAfterMs ?? 2000 * attempt;
          logger.warn("Rate limited, backing off", {
            label,
            waitMs: wait,
            attempt,
          });
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
      }
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/** Index spot daily candles for the resolved underlyings. */
async function backfillSpot(
  db: SupabaseDb,
  client: UpstoxHistoricalClient,
  underlyings: ResolvedUnderlying[],
  args: Args,
): Promise<void> {
  const today = todayIst();
  const states = await loadStates(
    db,
    underlyings.map((u) => u.instrumentKey),
  );

  for (const u of underlyings) {
    const state = states.get(u.instrumentKey);
    const from = state?.last_date ? addDays(state.last_date, 1) : args.from;
    if (from > today) {
      logger.info("Spot up to date", {
        symbol: u.symbol,
        through: state?.last_date,
      });
      continue;
    }
    if (args.dryRun) {
      logger.info("DRY RUN spot", { symbol: u.symbol, from, to: today });
      continue;
    }
    try {
      const candles = await withRetry(`spot ${u.symbol}`, () =>
        client.getHistoricalCandles(u.instrumentKey, "days", 1, from, today),
      );
      const written = await writeCandles(
        db,
        u.instrumentId,
        u.instrumentKey,
        candles,
        "hist",
      );
      await saveState(db, u.instrumentKey, {
        first_date: state?.first_date ?? args.from,
        last_date: today,
        rows_written: (state?.rows_written ?? 0) + written,
        last_error: null,
      });
      logger.info("Spot backfilled", {
        symbol: u.symbol,
        from,
        to: today,
        candles: written,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await saveState(db, u.instrumentKey, { last_error: message });
      logger.error("Spot backfill failed", {
        symbol: u.symbol,
        error: message,
      });
    }
  }
}

/** Enumerates expiries for an underlying and records which still need contract listing. */
async function syncExpiries(
  db: SupabaseDb,
  client: UpstoxHistoricalClient,
  u: ResolvedUnderlying,
  fromDate: string,
): Promise<string[]> {
  const expiries = (
    await withRetry(`expiries ${u.symbol}`, () =>
      client.getExpiries(u.instrumentKey),
    )
  )
    .filter((e) => e >= fromDate)
    .sort();

  if (expiries.length > 0) {
    const { error } = await db.from("underlying_expiries").upsert(
      expiries.map((expiry) => ({ underlying_key: u.instrumentKey, expiry })),
      { onConflict: "underlying_key,expiry", ignoreDuplicates: true },
    );
    if (error)
      logger.error("Failed to record expiries", {
        symbol: u.symbol,
        error: error.message,
      });
  }
  logger.info("Expiries synced", {
    symbol: u.symbol,
    count: expiries.length,
    earliest: expiries[0],
    latest: expiries.at(-1),
  });
  return expiries;
}

function contractToInstrumentRow(c: ExpiredContract): InstrumentRow {
  return {
    provider: "upstox",
    provider_instrument_key: c.instrument_key,
    exchange: c.exchange,
    segment: c.segment,
    trading_symbol: c.trading_symbol,
    name: c.name ?? c.trading_symbol,
    isin: null,
    instrument_type: c.instrument_type,
    exchange_token: c.exchange_token ? String(c.exchange_token) : null,
    tick_size: c.tick_size ?? null,
    lot_size: c.lot_size ?? null,
    underlying_key: c.underlying_key ?? null,
    underlying_symbol: c.underlying_symbol ?? null,
    expiry: c.expiry,
    strike: c.strike_price ?? null,
    option_type:
      c.instrument_type === "CE" || c.instrument_type === "PE"
        ? c.instrument_type
        : null,
    weekly: c.weekly ?? null,
    is_expired: true,
    is_active: false,
    metadata: <Json>{
      underlying_type: c.underlying_type ?? null,
      freeze_quantity: c.freeze_quantity ?? null,
      minimum_lot: c.minimum_lot ?? null,
    },
  };
}

/** Contracts + their daily candles for every expiry of every underlying. */
async function backfillContracts(
  db: SupabaseDb,
  client: UpstoxHistoricalClient,
  underlyings: ResolvedUnderlying[],
  kind: "options" | "futures",
  args: Args,
): Promise<void> {
  let processed = 0;

  for (const u of underlyings) {
    const expiries = await syncExpiries(db, client, u, args.from);

    for (const expiry of expiries) {
      if (args.limit && processed >= args.limit) {
        logger.info("Reached --limit, stopping", { processed });
        return;
      }

      // Contracts for one expiry
      let contracts: ExpiredContract[];
      try {
        contracts = await withRetry(
          `${kind} contracts ${u.symbol} ${expiry}`,
          () =>
            kind === "options"
              ? client.getExpiredOptionContracts(u.instrumentKey, expiry)
              : client.getExpiredFutureContracts(u.instrumentKey, expiry),
        );
      } catch (error) {
        logger.error("Contract listing failed", {
          symbol: u.symbol,
          expiry,
          kind,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (contracts.length === 0) continue;

      if (args.dryRun) {
        logger.info("DRY RUN contracts", {
          symbol: u.symbol,
          expiry,
          kind,
          contracts: contracts.length,
        });
        processed += contracts.length;
        continue;
      }

      // Register the contracts so market_candles has a valid instrument_id to point at
      const { error: instError } = await db
        .from("instruments")
        .upsert(contracts.map(contractToInstrumentRow), {
          onConflict: "provider,provider_instrument_key",
        });
      if (instError) {
        logger.error("Contract instrument upsert failed", {
          symbol: u.symbol,
          expiry,
          error: instError.message,
        });
        continue;
      }
      const { data: idRows, error: idError } = await db
        .from("instruments")
        .select("id, provider_instrument_key")
        .in(
          "provider_instrument_key",
          contracts.map((c) => c.instrument_key),
        );
      if (idError) {
        logger.error("Contract id lookup failed", {
          symbol: u.symbol,
          expiry,
          error: idError.message,
        });
        continue;
      }
      const idByKey = new Map(
        (idRows ?? []).map((r) => [r.provider_instrument_key, r.id]),
      );

      const states = await loadStates(
        db,
        contracts.map((c) => c.instrument_key),
      );
      let loaded = 0;
      let skipped = 0;
      let rows = 0;

      for (const c of contracts) {
        const state = states.get(c.instrument_key);
        // Expired contract already loaded through expiry — its candles can never change.
        if (state?.is_final) {
          skipped += 1;
          continue;
        }
        const instrumentId = idByKey.get(c.instrument_key);
        if (!instrumentId) {
          logger.error("Contract missing after upsert", {
            key: c.instrument_key,
          });
          continue;
        }
        const windowFrom = earlier(
          args.from,
          addDays(c.expiry, -CONTRACT_LOOKBACK_DAYS),
        );
        const from = state?.last_date
          ? addDays(state.last_date, 1)
          : windowFrom;
        if (from > c.expiry) {
          await saveState(db, c.instrument_key, { is_final: true });
          skipped += 1;
          continue;
        }
        try {
          const candles = await withRetry(`candles ${c.trading_symbol}`, () =>
            client.getExpiredHistoricalCandles(
              c.instrument_key,
              "day",
              from,
              c.expiry,
            ),
          );
          const written = await writeCandles(
            db,
            instrumentId,
            c.instrument_key,
            candles,
            "hist_expired",
          );
          rows += written;
          loaded += 1;
          await saveState(db, c.instrument_key, {
            first_date: state?.first_date ?? windowFrom,
            last_date: c.expiry,
            is_final: true, // contract is expired and now loaded through expiry
            rows_written: (state?.rows_written ?? 0) + written,
            last_error: null,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          await saveState(db, c.instrument_key, { last_error: message });
          logger.error("Contract candles failed", {
            key: c.instrument_key,
            error: message,
          });
        }
        processed += 1;
        if (args.limit && processed >= args.limit) break;
      }

      logger.info("Expiry done", {
        symbol: u.symbol,
        expiry,
        kind,
        contracts: contracts.length,
        loaded,
        skippedFinal: skipped,
        rows,
      });
      const { error: expError } = await db.from("underlying_expiries").upsert(
        {
          underlying_key: u.instrumentKey,
          expiry,
          contracts_loaded: true,
          option_count: kind === "options" ? contracts.length : undefined,
          future_count: kind === "futures" ? contracts.length : undefined,
          loaded_at: new Date().toISOString(),
        },
        { onConflict: "underlying_key,expiry" },
      );
      if (expError)
        logger.error("Failed to mark expiry loaded", {
          symbol: u.symbol,
          expiry,
          error: expError.message,
        });
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Args {
  const target = (argv[0] ?? "all") as Target;
  if (!["spot", "options", "futures", "all"].includes(target)) {
    throw new Error(
      `Unknown target "${target}". Use: spot | options | futures | all`,
    );
  }
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    target,
    symbols:
      flag("symbols")
        ?.split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean) ?? null,
    from: flag("from") ?? HISTORY_FLOOR,
    limit: Number(flag("limit") ?? 0) || 0,
    dryRun: argv.includes("--dry-run"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const account = config.upstoxAccounts.require("hist");
  const db = getSupabaseClient();
  const client = new UpstoxHistoricalClient(account.token, {
    baseUrl: config.upstoxBaseUrl,
  });

  const { data: indexRows, error } = await db
    .from("instruments")
    .select("id, provider_instrument_key, trading_symbol, name, segment")
    .in("segment", ["NSE_INDEX", "BSE_INDEX"]);
  if (error)
    throw new Error(`Failed to load index instruments: ${error.message}`);

  const wanted = args.symbols
    ? FNO_INDEX_UNDERLYINGS.filter((u) => args.symbols!.includes(u.symbol))
    : FNO_INDEX_UNDERLYINGS;
  const { resolved, unresolved } = resolveUnderlyings(
    wanted,
    (indexRows ?? []) as IndexInstrumentRow[],
  );

  if (unresolved.length > 0) {
    logger.error("Could not resolve these underlyings in `instruments`", {
      symbols: unresolved.map((u) => u.symbol),
      hint: "Run sync:instruments, then check the exact index names in the instruments table",
    });
  }
  if (resolved.length === 0)
    throw new Error("No underlyings resolved — nothing to do");
  logger.info("Backfill starting", {
    target: args.target,
    from: args.from,
    dryRun: args.dryRun,
    underlyings: resolved.map((u) => `${u.symbol}=${u.instrumentKey}`),
  });

  const started = Date.now();
  if (args.target === "spot" || args.target === "all")
    await backfillSpot(db, client, resolved, args);
  if (args.target === "futures" || args.target === "all")
    await backfillContracts(db, client, resolved, "futures", args);
  if (args.target === "options" || args.target === "all")
    await backfillContracts(db, client, resolved, "options", args);

  logger.info("Backfill finished", {
    target: args.target,
    minutes: +((Date.now() - started) / 60000).toFixed(1),
  });
}

main().catch((error) => {
  logger.error("Backfill failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
