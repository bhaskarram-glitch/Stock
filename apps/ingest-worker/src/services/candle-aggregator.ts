import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "../lib/logger.js";
import type { Database } from "../lib/database.types.js";
import type { CandleInterval } from "@shared/market/types.js";
export type { CandleInterval };

const ALL_INTERVALS: readonly CandleInterval[] = [
  "1m",
  "5m",
  "15m",
  "1h",
  "1d",
];
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export interface CandleStats {
  activeBuckets: number;
  intervals: CandleInterval[];
  droppedLateTicks: number;
  pendingPersist: number;
}

export interface CandleData {
  instrument_key: string;
  interval: CandleInterval;
  bucket_start: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tick_count: number;
}

interface AggregatorState {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tick_count: number;
  bucket_start_ms: number;
  last_update: Date;
}

export interface CandleAggregatorOptions {
  activeIntervals?: CandleInterval[];
  /** How often the flusher checks for expired buckets. Default 5s. */
  flushIntervalMs?: number;
  /** Injectable wall clock (ms). Default Date.now. */
  now?: () => number;
}

export class CandleAggregator {
  private readonly aggregators = new Map<string, AggregatorState>();
  /** key -> bucket_start_ms of the most recently closed bucket (late-tick guard) */
  private readonly closedWatermark = new Map<string, number>();
  private readonly instrumentIdCache = new Map<string, string>();
  private readonly intervalMs: Record<CandleInterval, number> = {
    "1m": 60_000,
    "5m": 5 * 60_000,
    "15m": 15 * 60_000,
    "1h": 60 * 60_000,
    "1d": 24 * 60 * 60_000,
  };

  private activeIntervals: CandleInterval[];
  private readonly flushIntervalMs: number;
  private readonly now: () => number;
  private flushTimer?: NodeJS.Timeout;
  private persistChain: Promise<void> = Promise.resolve();
  private pendingPersist = 0;
  private droppedLateTicks = 0;

  constructor(
    private readonly supabase: SupabaseClient<Database>,
    options: CandleAggregatorOptions = {},
  ) {
    this.activeIntervals = options.activeIntervals ?? ["1m", "5m", "15m", "1h"];
    this.flushIntervalMs = options.flushIntervalMs ?? 5_000;
    this.now = options.now ?? Date.now;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Resolves instrument ids for the given keys in one query and caches them.
   * @returns keys that could NOT be resolved. Caller decides whether to fail fast.
   */
  async preloadInstrumentIds(instrumentKeys: string[]): Promise<string[]> {
    const missing = instrumentKeys.filter(
      (k) => !this.instrumentIdCache.has(k),
    );
    if (missing.length === 0) return [];

    const { data, error } = await this.supabase
      .from("instruments")
      .select("id, provider_instrument_key")
      .in("provider_instrument_key", missing);

    if (error) {
      logger.error("Failed to preload instrument ids", {
        error: error.message,
      });
      return missing;
    }
    for (const row of data ?? []) {
      this.instrumentIdCache.set(row.provider_instrument_key, row.id);
    }
    return missing.filter((k) => !this.instrumentIdCache.has(k));
  }

  /** Starts the periodic flusher that closes buckets whose end time has passed. */
  startFlusher(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      void this.flushExpiredBuckets();
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  stopFlusher(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Tick processing (synchronous in memory)
  // ---------------------------------------------------------------------------

  /**
   * Updates all active intervals for a tick. `volumeDelta` MUST be the volume
   * traded since the previous tick for this instrument (see CumulativeVolumeTracker),
   * never a cumulative figure.
   *
   * The in-memory update is synchronous; any candles closed as a side effect are
   * queued for persistence and the returned promise resolves when the queue has
   * been *enqueued*, not when the DB write completes. Use `drain()` to wait.
   */
  processTick(
    instrumentKey: string,
    price: number,
    volumeDelta: number,
    timestamp: Date = new Date(this.now()),
  ): Promise<void> {
    const closed: CandleData[] = [];
    for (const interval of this.activeIntervals) {
      const c = this.updateCandle(
        instrumentKey,
        interval,
        price,
        volumeDelta,
        timestamp,
      );
      if (c) closed.push(c);
    }
    if (closed.length > 0) this.enqueuePersist(closed);
    return Promise.resolve();
  }

  private updateCandle(
    instrumentKey: string,
    interval: CandleInterval,
    price: number,
    volumeDelta: number,
    timestamp: Date,
  ): CandleData | undefined {
    const key = `${instrumentKey}:${interval}`;
    const intervalMs = this.intervalMs[interval];
    const bucketStartMs = this.getBucketStartMs(timestamp.getTime(), interval);

    let closed: CandleData | undefined;
    let state = this.aggregators.get(key);

    // Late-tick guard: bucket already closed, or older than the open bucket.
    const watermark = this.closedWatermark.get(key);
    if (
      (watermark !== undefined && bucketStartMs <= watermark) ||
      (state && bucketStartMs < state.bucket_start_ms)
    ) {
      this.droppedLateTicks += 1;
      logger.warn("Dropped late tick for closed bucket", {
        instrumentKey,
        interval,
        tickBucket: new Date(bucketStartMs).toISOString(),
      });
      return undefined;
    }

    if (!state || state.bucket_start_ms !== bucketStartMs) {
      if (state) closed = this.closeBucket(key, instrumentKey, interval, state);
      state = {
        open: price,
        high: price,
        low: price,
        close: price,
        volume: volumeDelta,
        tick_count: 1,
        bucket_start_ms: bucketStartMs,
        last_update: timestamp,
      };
      this.aggregators.set(key, state);
    } else {
      state.high = Math.max(state.high, price);
      state.low = Math.min(state.low, price);
      state.close = price;
      state.volume += volumeDelta;
      state.tick_count += 1;
      state.last_update = timestamp;
    }

    // Wall-clock close: bucket window has already ended.
    if (this.now() >= bucketStartMs + intervalMs) {
      const c = this.closeBucket(key, instrumentKey, interval, state);
      // If the previous branch also closed one, persist both.
      if (closed) this.enqueuePersist([closed]);
      closed = c;
    }
    return closed;
  }

  private closeBucket(
    key: string,
    instrumentKey: string,
    interval: CandleInterval,
    state: AggregatorState,
  ): CandleData {
    this.aggregators.delete(key);
    this.closedWatermark.set(key, state.bucket_start_ms);
    return {
      instrument_key: instrumentKey,
      interval,
      bucket_start: new Date(state.bucket_start_ms),
      open: state.open,
      high: state.high,
      low: state.low,
      close: state.close,
      volume: state.volume,
      tick_count: state.tick_count,
    };
  }

  // ---------------------------------------------------------------------------
  // Flushing
  // ---------------------------------------------------------------------------

  /** Closes and persists every bucket whose window has ended (called by the flusher). */
  async flushExpiredBuckets(): Promise<void> {
    const now = this.now();
    const closed: CandleData[] = [];
    for (const [key, state] of this.aggregators) {
      const parsed = this.parseKey(key);
      if (!parsed) continue;
      const end = state.bucket_start_ms + this.intervalMs[parsed.interval];
      if (now >= end) {
        closed.push(
          this.closeBucket(key, parsed.instrumentKey, parsed.interval, state),
        );
      }
    }
    if (closed.length > 0) {
      this.enqueuePersist(closed);
      await this.drain();
    }
  }

  /** Force-closes ALL open buckets (shutdown) and waits for persistence. */
  async flushAllBuckets(): Promise<void> {
    logger.info("Flushing all open candle buckets", {
      count: this.aggregators.size,
    });
    const closed: CandleData[] = [];
    for (const [key, state] of this.aggregators) {
      const parsed = this.parseKey(key);
      if (!parsed) continue;
      closed.push(
        this.closeBucket(key, parsed.instrumentKey, parsed.interval, state),
      );
    }
    this.aggregators.clear();
    if (closed.length > 0) this.enqueuePersist(closed);
    await this.drain();
    logger.info("All candle buckets flushed");
  }

  /** Waits for every queued persistence batch to finish. */
  drain(): Promise<void> {
    return this.persistChain;
  }

  // ---------------------------------------------------------------------------
  // Persistence (serial queue, batched upsert)
  // ---------------------------------------------------------------------------

  private enqueuePersist(candles: CandleData[]): void {
    this.pendingPersist += candles.length;
    this.persistChain = this.persistChain
      .then(() => this.persistCandles(candles))
      .catch((error) => {
        logger.error("Unhandled error in candle persistence", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.pendingPersist -= candles.length;
      });
  }

  private async persistCandles(candles: CandleData[]): Promise<void> {
    const unresolved = await this.preloadInstrumentIds(
      Array.from(new Set(candles.map((c) => c.instrument_key))),
    );
    if (unresolved.length > 0) {
      logger.error("Dropping candles for unknown instruments", {
        instrumentKeys: unresolved,
        dropped: candles.filter((c) => unresolved.includes(c.instrument_key))
          .length,
      });
    }

    const rows = candles
      .filter((c) => this.instrumentIdCache.has(c.instrument_key))
      .map((c) => ({
        instrument_id: this.instrumentIdCache.get(c.instrument_key)!,
        instrument_key: c.instrument_key,
        interval: c.interval,
        bucket_start: c.bucket_start.toISOString(),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        source: "ws" as const,
      }));
    if (rows.length === 0) return;

    const { error } = await this.supabase
      .from("market_candles")
      .upsert(rows, { onConflict: "instrument_key,interval,bucket_start" });

    if (error) {
      logger.error("Failed to save candles", {
        count: rows.length,
        error: error.message,
      });
      return;
    }
    logger.info("Candles saved", { count: rows.length });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Bucket start in epoch ms. Intraday intervals align to UTC (divides evenly); 1d aligns to IST midnight. */
  private getBucketStartMs(
    timestampMs: number,
    interval: CandleInterval,
  ): number {
    const intervalMs = this.intervalMs[interval];
    if (interval === "1d") {
      const shifted = timestampMs + IST_OFFSET_MS;
      return Math.floor(shifted / intervalMs) * intervalMs - IST_OFFSET_MS;
    }
    return Math.floor(timestampMs / intervalMs) * intervalMs;
  }

  private parseKey(
    key: string,
  ): { instrumentKey: string; interval: CandleInterval } | undefined {
    const idx = key.lastIndexOf(":");
    if (idx === -1) {
      logger.error("Invalid aggregator key format", { key });
      return undefined;
    }
    const instrumentKey = key.slice(0, idx);
    const interval = key.slice(idx + 1) as CandleInterval;
    if (!ALL_INTERVALS.includes(interval)) {
      logger.error("Invalid interval in aggregator key", { key });
      return undefined;
    }
    return { instrumentKey, interval };
  }

  getStats(): CandleStats {
    return {
      activeBuckets: this.aggregators.size,
      intervals: this.activeIntervals,
      droppedLateTicks: this.droppedLateTicks,
      pendingPersist: this.pendingPersist,
    };
  }

  setActiveIntervals(intervals: CandleInterval[]): void {
    logger.info("Updating active candle intervals", {
      old: this.activeIntervals,
      new: intervals,
    });
    this.activeIntervals = intervals;
  }
}
