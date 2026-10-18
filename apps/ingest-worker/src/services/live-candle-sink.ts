/**
 * Writes closed live candles to live_candles_fine (1m/5m) and live_candles (15m/60m) — Phase 3, 3.3.
 *
 * - Candles arrive keyed by the store key (index key or permanent contract key); `sidByKey` maps
 *   that to instruments.sid. Unknown keys are counted and dropped (they cannot happen with a
 *   universe built by loadLiveUniverse, but a bad key must never block the batch).
 * - One multi-row insert per table via unnest() arrays, in chunks.
 * - A bucket written twice (worker restarted inside the bucket) MERGES: open kept, high/low widened,
 *   close/oi from the later write, volume added. Index spots have no volume: stored as NULL.
 * - Partitions: ensure_live_partitions(day) runs once per IST day seen, before the first insert.
 * - A failed write is retried twice (1s, 3s) before the batch is given up and logged.
 */
import type { Db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { istClock } from "../providers/upstox/market-calendar.js";
import type { CandleData, CandleInterval, CandleSink } from "./candle-aggregator.js";

const INTERVAL_MIN: Partial<Record<CandleInterval, number>> = { "1m": 1, "5m": 5, "15m": 15, "1h": 60 };
const FINE = new Set([1, 5]);
const CHUNK = 5000;

interface Row {
  sid: number;
  interval: number;
  bucket: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  oi: number | null;
}

export interface LiveSinkStats {
  written: number;
  droppedUnknown: number;
  failedBatches: number;
}

export class LiveCandleSink implements CandleSink {
  private readonly ensuredDays = new Set<string>();
  private readonly stats: LiveSinkStats = { written: 0, droppedUnknown: 0, failedBatches: 0 };

  constructor(
    private readonly db: Db,
    private readonly sidByKey: Map<string, number>,
    private readonly retryDelaysMs: number[] = [1000, 3000],
    /** Keys with no traded volume (index spots): stored with volume NULL, not 0. */
    private readonly noVolumeKeys: Set<string> = new Set(),
  ) {}

  getStats(): LiveSinkStats {
    return { ...this.stats };
  }

  async ensurePartitions(day: string): Promise<void> {
    if (this.ensuredDays.has(day)) return;
    await this.db.query("select ensure_live_partitions($1::date)", [day]);
    this.ensuredDays.add(day);
  }

  async persist(candles: CandleData[]): Promise<void> {
    const merged = new Map<string, Row>();
    for (const c of candles) {
      const sid = this.sidByKey.get(c.instrument_key);
      const interval = INTERVAL_MIN[c.interval];
      if (sid === undefined || interval === undefined) {
        this.stats.droppedUnknown += 1;
        continue;
      }
      const k = `${sid}|${interval}|${c.bucket_start.getTime()}`;
      const prev = merged.get(k);
      const volume = !this.noVolumeKeys.has(c.instrument_key) && Number.isFinite(c.volume) ? c.volume : null;
      const oi = c.oi !== undefined && Number.isFinite(c.oi) ? Math.round(c.oi) : null;
      if (!prev) {
        merged.set(k, { sid, interval, bucket: c.bucket_start, open: c.open, high: c.high, low: c.low, close: c.close, volume, oi });
      } else {
        prev.high = Math.max(prev.high, c.high);
        prev.low = Math.min(prev.low, c.low);
        prev.close = c.close;
        prev.volume = (prev.volume ?? 0) + (volume ?? 0);
        prev.oi = oi ?? prev.oi;
      }
    }
    if (merged.size === 0) return;
    const rows = [...merged.values()];

    for (const day of new Set(rows.map((r) => istClock(r.bucket.getTime()).date))) {
      await this.withRetry(() => this.ensurePartitions(day), "ensure partitions");
    }
    const fine = rows.filter((r) => FINE.has(r.interval));
    const coarse = rows.filter((r) => !FINE.has(r.interval));
    for (const [table, list] of [["live_candles_fine", fine], ["live_candles", coarse]] as const) {
      for (let i = 0; i < list.length; i += CHUNK) {
        const chunk = list.slice(i, i + CHUNK);
        try {
          await this.withRetry(() => this.insert(table, chunk), `insert ${table}`);
          this.stats.written += chunk.length;
        } catch (error) {
          this.stats.failedBatches += 1;
          logger.error("Live candles NOT saved", {
            table,
            count: chunk.length,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    logger.debug("Live candles saved", { fine: fine.length, coarse: coarse.length });
  }

  private async insert(table: "live_candles_fine" | "live_candles", rows: Row[]): Promise<void> {
    await this.db.query(
      `insert into ${table} as t (sid, interval_min, bucket_start, open, high, low, close, volume, oi)
       select * from unnest($1::int[], $2::smallint[], $3::timestamptz[], $4::float8[], $5::float8[],
                            $6::float8[], $7::float8[], $8::bigint[], $9::bigint[])
       on conflict (sid, interval_min, bucket_start) do update set
         high   = greatest(t.high, excluded.high),
         low    = least(t.low, excluded.low),
         close  = excluded.close,
         volume = case when t.volume is null and excluded.volume is null then null
                       else coalesce(t.volume, 0) + coalesce(excluded.volume, 0) end,
         oi     = coalesce(excluded.oi, t.oi)`,
      [
        rows.map((r) => r.sid),
        rows.map((r) => r.interval),
        rows.map((r) => r.bucket.toISOString()),
        rows.map((r) => r.open),
        rows.map((r) => r.high),
        rows.map((r) => r.low),
        rows.map((r) => r.close),
        rows.map((r) => (r.volume === null ? null : Math.round(r.volume))),
        rows.map((r) => r.oi),
      ],
    );
  }

  private async withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        const delay = this.retryDelaysMs[attempt];
        if (delay === undefined) throw error;
        logger.warn(`Live sink: ${label} failed, retrying`, {
          attempt: attempt + 1,
          delayMs: delay,
          error: error instanceof Error ? error.message : String(error),
        });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
}
