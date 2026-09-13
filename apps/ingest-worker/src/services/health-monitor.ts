import { logger } from "../lib/logger.js";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../lib/database.types.js";
import { UpstoxClient } from "../providers/upstox/client.js";

export interface HealthStatus {
  wsHealthy: boolean;
  monitoredInstruments: number;
  wsDownTime?: Date;
  apiFallbackActive: boolean;
}

export interface HealthMonitorOptions {
  /** Preferred: inject the shared client from lib/supabase.ts (Perf #4). */
  supabase?: SupabaseClient<Database>;
  /** Legacy: build a client from url/key. Ignored when `supabase` is provided. */
  supabaseUrl?: string;
  supabaseKey?: string;
  upstoxClient: UpstoxClient;
  healthCheckInterval?: number; // How often to check health + flush WS timestamps (ms)
  apiFallbackDelay?: number; // Delay before triggering API fallback (ms)
  apiFallbackInterval?: number; // How often to run API fallback when WS is down (ms)
}

export class HealthMonitor {
  private supabase: SupabaseClient<Database>;
  private upstoxClient: UpstoxClient;
  private healthCheckInterval: number;
  private apiFallbackDelay: number;
  private apiFallbackInterval: number;

  private healthCheckTimer?: NodeJS.Timeout;
  private apiFallbackDelayTimer?: NodeJS.Timeout;
  private apiFallbackIntervalTimer?: NodeJS.Timeout;
  private wsDownTime?: Date;

  private monitoredInstruments = new Set<string>();
  private wsHealthy = false;
  /** Once stop() runs, no timer may be (re)armed until start() is called again (Bug #11). */
  private stopped = true;

  /** Buffered last-tick timestamps, flushed in one upsert per health-check cycle (Perf #1). */
  private pendingWsTs = new Map<string, Date>();

  constructor(options: HealthMonitorOptions) {
    if (options.supabase) {
      this.supabase = options.supabase;
    } else if (options.supabaseUrl && options.supabaseKey) {
      this.supabase = createClient<Database>(
        options.supabaseUrl,
        options.supabaseKey,
      );
    } else {
      throw new Error(
        "HealthMonitor requires `supabase` or `supabaseUrl` + `supabaseKey`",
      );
    }
    this.upstoxClient = options.upstoxClient;
    this.healthCheckInterval = options.healthCheckInterval ?? 30_000;
    this.apiFallbackDelay = options.apiFallbackDelay ?? 60_000;
    this.apiFallbackInterval = options.apiFallbackInterval ?? 3_600_000;
  }

  start(): void {
    logger.info("Starting health monitor", {
      healthCheckInterval: this.healthCheckInterval,
      apiFallbackDelay: this.apiFallbackDelay,
      apiFallbackInterval: this.apiFallbackInterval,
    });
    this.stopped = false;
    this.startHealthChecks();
  }

  stop(): void {
    logger.info("Stopping health monitor");
    this.stopped = true;
    this.clearFallbackTimers();
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
    void this.flushWsTimestamps();
  }

  addInstruments(instrumentKeys: string[]): void {
    instrumentKeys.forEach((key) => this.monitoredInstruments.add(key));
    logger.info("Added instruments to health monitor", {
      count: instrumentKeys.length,
    });
  }

  removeInstruments(instrumentKeys: string[]): void {
    instrumentKeys.forEach((key) => {
      this.monitoredInstruments.delete(key);
      this.pendingWsTs.delete(key);
    });
    logger.info("Removed instruments from health monitor", {
      count: instrumentKeys.length,
    });
  }

  onWebSocketConnect(): void {
    logger.info("WebSocket connected - updating health status");
    this.wsHealthy = true;
    this.wsDownTime = undefined;
    if (this.clearFallbackTimers()) {
      logger.info("Stopped API fallback due to WebSocket recovery");
    }
    void this.updateInstrumentStatuses("online");
  }

  onWebSocketDisconnect(): void {
    if (this.stopped) return;
    logger.warn("WebSocket disconnected - scheduling API fallback");
    this.wsHealthy = false;
    this.wsDownTime = new Date();
    void this.updateInstrumentStatuses("offline");
    this.scheduleApiFallback();
  }

  onWebSocketError(error: Error): void {
    logger.error("WebSocket error detected", { error: error.message });
    if (this.wsHealthy) {
      this.wsHealthy = false;
      this.wsDownTime = new Date();
      void this.updateInstrumentStatuses("degraded");
    }
  }

  /** Cheap: records the timestamp in memory. Persisted in batch by the health-check cycle. */
  onTickReceived(instrumentKey: string): void {
    this.pendingWsTs.set(instrumentKey, new Date());

    if (!this.wsHealthy) {
      logger.info("WebSocket health restored via tick data");
      this.wsHealthy = true;
      this.wsDownTime = undefined;
      void this.updateInstrumentStatuses("online");
      this.clearFallbackTimers();
    }
  }

  /** Writes all buffered last_ws_ts values in a single upsert. Exposed for tests/shutdown. */
  async flushWsTimestamps(): Promise<void> {
    if (this.pendingWsTs.size === 0) return;
    const rows = Array.from(this.pendingWsTs, ([instrument_key, ts]) => ({
      instrument_key,
      ws_status: "online" as const,
      last_ws_ts: ts.toISOString(),
      updated_at: new Date().toISOString(),
    }));
    this.pendingWsTs.clear();

    try {
      const { error } = await this.supabase
        .from("instrument_status")
        .upsert(rows, { onConflict: "instrument_key" });
      if (error) {
        logger.error("Failed to flush instrument WS timestamps", {
          count: rows.length,
          error: error.message,
        });
      }
    } catch (error) {
      logger.error("Error flushing instrument WS timestamps", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private startHealthChecks(): void {
    this.healthCheckTimer = setInterval(async () => {
      try {
        await this.flushWsTimestamps();
        await this.performHealthCheck();
      } catch (error) {
        logger.error("Health check failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, this.healthCheckInterval);
  }

  private async performHealthCheck(): Promise<void> {
    const now = new Date();
    const timeSinceWsDown = this.wsDownTime
      ? now.getTime() - this.wsDownTime.getTime()
      : 0;

    logger.info("Health check", {
      wsHealthy: this.wsHealthy,
      monitoredInstruments: this.monitoredInstruments.size,
      timeSinceWsDown: Math.round(timeSinceWsDown / 1000) + "s",
    });

    if (
      !this.wsHealthy &&
      timeSinceWsDown > this.apiFallbackDelay &&
      !this.apiFallbackDelayTimer &&
      !this.apiFallbackIntervalTimer
    ) {
      logger.warn(
        "WebSocket unhealthy for extended period, ensuring API fallback",
      );
      this.scheduleApiFallback();
    }
  }

  private scheduleApiFallback(): void {
    if (this.stopped) return;
    if (this.apiFallbackDelayTimer || this.apiFallbackIntervalTimer) return;

    logger.info("Scheduling API fallback", {
      delay: this.apiFallbackDelay,
      interval: this.apiFallbackInterval,
    });

    this.apiFallbackDelayTimer = setTimeout(async () => {
      this.apiFallbackDelayTimer = undefined;
      if (this.stopped) return;
      await this.performApiFallback();
      if (this.stopped) return;
      this.apiFallbackIntervalTimer = setInterval(async () => {
        await this.performApiFallback();
      }, this.apiFallbackInterval);
    }, this.apiFallbackDelay);
  }

  /** @returns true if any fallback timer was active */
  private clearFallbackTimers(): boolean {
    let cleared = false;
    if (this.apiFallbackDelayTimer) {
      clearTimeout(this.apiFallbackDelayTimer);
      this.apiFallbackDelayTimer = undefined;
      cleared = true;
    }
    if (this.apiFallbackIntervalTimer) {
      clearInterval(this.apiFallbackIntervalTimer);
      this.apiFallbackIntervalTimer = undefined;
      cleared = true;
    }
    return cleared;
  }

  // TODO(Phase 4, Bug #6): persist fetched quotes as candles with source 'api'. Today only last_api_ts is recorded.
  private async performApiFallback(): Promise<void> {
    if (this.monitoredInstruments.size === 0) return;

    logger.info("Performing API fallback for monitored instruments", {
      count: this.monitoredInstruments.size,
    });

    const now = new Date();
    for (const instrumentKey of this.monitoredInstruments) {
      try {
        const quote = await this.upstoxClient.fetchQuote(instrumentKey);
        await this.updateInstrumentLastApiTs(instrumentKey, now);
        logger.info("API fallback successful", {
          instrumentKey,
          price: quote.last_price,
          timestamp: now.toISOString(),
        });
      } catch (error) {
        logger.error("API fallback failed for instrument", {
          instrumentKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async updateInstrumentStatuses(
    status: "online" | "offline" | "degraded",
  ): Promise<void> {
    if (this.monitoredInstruments.size === 0) return;
    const instrumentKeys = Array.from(this.monitoredInstruments);

    try {
      const { error } = await this.supabase.from("instrument_status").upsert(
        instrumentKeys.map((key) => ({
          instrument_key: key,
          ws_status: status,
          updated_at: new Date().toISOString(),
        })),
        { onConflict: "instrument_key" },
      );
      if (error) {
        logger.error("Failed to update instrument statuses", {
          error: error.message,
        });
      } else {
        logger.info("Updated instrument statuses", {
          status,
          count: instrumentKeys.length,
        });
      }
    } catch (error) {
      logger.error("Error updating instrument statuses", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async updateInstrumentLastApiTs(
    instrumentKey: string,
    timestamp: Date,
  ): Promise<void> {
    try {
      const { error } = await this.supabase
        .from("instrument_status")
        .update({
          last_api_ts: timestamp.toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("instrument_key", instrumentKey);
      if (error) {
        logger.error("Failed to update instrument API timestamp", {
          instrumentKey,
          error: error.message,
        });
      }
    } catch (error) {
      logger.error("Error updating instrument API timestamp", {
        instrumentKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getHealthStatus(): HealthStatus {
    return {
      wsHealthy: this.wsHealthy,
      monitoredInstruments: this.monitoredInstruments.size,
      wsDownTime: this.wsDownTime,
      apiFallbackActive: !!(
        this.apiFallbackDelayTimer || this.apiFallbackIntervalTimer
      ),
    };
  }
}
