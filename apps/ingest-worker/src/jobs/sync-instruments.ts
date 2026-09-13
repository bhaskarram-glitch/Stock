/**
 * Job: sync the Upstox instrument master into `instruments`.
 *
 * Run: npm run sync:instruments
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *      INSTRUMENT_SOURCES (optional, CSV) — default "complete"; any of complete|NSE|BSE|MCX
 *
 * Notes:
 * - `complete.json.gz` already contains every exchange/segment; the per-exchange files are only
 *   useful to narrow the download. Don't combine them with `complete` — it just re-uploads the same rows.
 * - F&O fields (expiry, strike, option type, underlying) are captured in `metadata` today.
 *   Phase 1 promotes them to real columns; the mapping below is the only place that changes.
 * - Exit codes: 0 ok · 1 fatal (DB unreachable, no data, aborted) · 2 completed with some failed batches
 */
import "dotenv/config.js";
import { gunzipSync } from "node:zlib";
import { logger } from "../lib/logger.js";
import { getSupabaseClient } from "../lib/supabase.js";
import type { Database, Json } from "../lib/database.types.js";

const SOURCE_URLS: Record<string, string> = {
  complete:
    "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz",
  NSE: "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz",
  BSE: "https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz",
  MCX: "https://assets.upstox.com/market-quote/instruments/exchange/MCX.json.gz",
};

const BATCH_SIZE = 1000;
const MAX_CONSECUTIVE_FAILURES = 3;

/** Shape of one entry in Upstox's instrument JSON (fields we read; the file has more). */
interface UpstoxInstrumentRecord {
  instrument_key: string;
  exchange: string;
  segment?: string;
  name?: string;
  isin?: string;
  trading_symbol?: string;
  short_name?: string;
  instrument_type?: string;
  exchange_token?: string | number;
  tick_size?: string | number;
  lot_size?: string | number;
  expiry?: string | number;
  strike_price?: string | number;
  underlying_key?: string;
  underlying_symbol?: string;
  underlying_type?: string;
  weekly?: boolean;
  freeze_quantity?: string | number;
  minimum_lot?: string | number;
}

type InstrumentRow = Database["public"]["Tables"]["instruments"]["Insert"];

export interface SyncResult {
  total: number;
  upserted: number;
  failed: number;
}

function num(value: string | number | undefined | null): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Extracts the low-level reason from an undici `fetch failed` error, if present. */
function errorDetail(error: unknown): { error: string; cause: string | null } {
  const cause = (error as { cause?: { code?: string; message?: string } })
    ?.cause;
  return {
    error: error instanceof Error ? error.message : String(error),
    cause: cause?.code ?? cause?.message ?? null,
  };
}

async function download(url: string): Promise<UpstoxInstrumentRecord[]> {
  logger.info("Downloading instruments", { url });
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Download failed: ${response.status} ${response.statusText} (${url})`,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = url.endsWith(".gz")
    ? gunzipSync(bytes).toString("utf8")
    : bytes.toString("utf8");
  const parsed = JSON.parse(text) as UpstoxInstrumentRecord[];
  logger.info("Downloaded instruments", { url, count: parsed.length });
  return parsed;
}

export function mapUpstoxInstrument(i: UpstoxInstrumentRecord): InstrumentRow {
  return {
    provider: "upstox",
    provider_instrument_key: i.instrument_key,
    exchange: i.exchange,
    segment: i.segment ?? i.exchange,
    trading_symbol: i.trading_symbol ?? i.short_name ?? i.instrument_key,
    name: i.name ?? i.trading_symbol ?? i.instrument_key,
    isin: i.isin ?? null,
    tick_size: num(i.tick_size),
    lot_size: num(i.lot_size),
    is_active: true,
    metadata: <Json>{
      short_name: i.short_name ?? null,
      instrument_type: i.instrument_type ?? null,
      exchange_token: i.exchange_token ?? null,
      expiry: i.expiry ?? null,
      strike_price: num(i.strike_price),
      underlying_key: i.underlying_key ?? null,
      underlying_symbol: i.underlying_symbol ?? null,
      underlying_type: i.underlying_type ?? null,
      weekly: i.weekly ?? null,
      freeze_quantity: num(i.freeze_quantity),
      minimum_lot: num(i.minimum_lot),
    },
  };
}

/** One cheap query so a paused project / bad URL / bad key fails before any download. */
async function assertDatabaseReachable(
  supabase: ReturnType<typeof getSupabaseClient>,
): Promise<void> {
  try {
    const { error } = await supabase
      .from("instruments")
      .select("id", { head: true, count: "exact" });
    if (error) throw new Error(error.message);
  } catch (error) {
    const detail = errorDetail(error);
    throw new Error(
      `Supabase unreachable (${detail.cause ?? detail.error}). ` +
        "Check the project is not paused and SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are correct.",
    );
  }
}

export async function syncInstruments(sources: string[]): Promise<SyncResult> {
  const supabase = getSupabaseClient();
  await assertDatabaseReachable(supabase);

  const rowsByKey = new Map<string, InstrumentRow>();
  for (const source of sources) {
    const url = SOURCE_URLS[source];
    if (!url) {
      logger.warn("Unknown instrument source, skipping", {
        source,
        known: Object.keys(SOURCE_URLS),
      });
      continue;
    }
    try {
      for (const record of await download(url)) {
        if (!record.instrument_key) continue;
        rowsByKey.set(record.instrument_key, mapUpstoxInstrument(record)); // dedupe across sources
      }
    } catch (error) {
      logger.error("Failed to process instrument source", {
        source,
        ...errorDetail(error),
      });
    }
  }

  const rows = Array.from(rowsByKey.values());
  if (rows.length === 0)
    throw new Error("No instruments downloaded from any source");
  logger.info("Upserting instruments", {
    total: rows.length,
    batchSize: BATCH_SIZE,
  });

  let upserted = 0;
  let failed = 0;
  let consecutiveFailures = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    try {
      const { error } = await supabase
        .from("instruments")
        .upsert(batch, { onConflict: "provider,provider_instrument_key" });
      if (error) throw new Error(error.message);
      upserted += batch.length;
      consecutiveFailures = 0;
    } catch (error) {
      failed += batch.length;
      consecutiveFailures += 1;
      logger.error("Instrument batch upsert failed", {
        batchStart: i,
        ...errorDetail(error),
      });
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        throw new Error(
          `Aborting after ${MAX_CONSECUTIVE_FAILURES} consecutive batch failures ` +
            `(${upserted} upserted, ${rows.length - upserted} remaining)`,
        );
      }
    }
    if ((i / BATCH_SIZE) % 20 === 0) {
      logger.info("Instrument sync progress", {
        upserted,
        failed,
        total: rows.length,
      });
    }
  }

  logger.info("Instrument sync completed", {
    total: rows.length,
    upserted,
    failed,
  });
  return { total: rows.length, upserted, failed };
}

// Entry point when run directly (npm run sync:instruments)
if (process.argv[1] && /sync-instruments\.(ts|js)$/.test(process.argv[1])) {
  const sources = (process.env.INSTRUMENT_SOURCES ?? "complete")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  syncInstruments(sources)
    .then(({ failed }) => process.exit(failed > 0 ? 2 : 0))
    .catch((error) => {
      logger.error("Instrument sync failed", errorDetail(error));
      process.exit(1);
    });
}
