import { logger } from "../lib/logger.js";
import { UpstoxWebSocketClient } from "../providers/upstox/websocket-client.js";
import type { UpstoxWSTick } from "../providers/upstox/types.js";
import {
  CandleAggregator,
  CandleInterval,
  CandleStats,
} from "./candle-aggregator.js";
import { HealthMonitor } from "./health-monitor.js";
import { UpstoxClient } from "../providers/upstox/client.js";
import { CumulativeVolumeTracker } from "./volume-tracker.js";

export interface HealthStatus {
  wsHealthy: boolean;
  monitoredInstruments: number;
  wsDownTime?: Date;
  apiFallbackActive: boolean;
}

export type { CandleStats };

export interface WebSocketManagerStatus {
  isRunning: boolean;
  activeInstruments: number;
  wsConnected: boolean;
  healthStatus: HealthStatus;
  candleStats: CandleStats;
}

export interface WebSocketManagerOptions {
  activeIntervals?: CandleInterval[];
  maxInstruments?: number;
  reconnectAttempts?: number;
  healthCheckInterval?: number;
  apiFallbackDelay?: number;
  apiFallbackInterval?: number;
  initialInstruments?: string[];
  /** If true (default), start() throws when any initial instrument is missing from `instruments`. */
  failOnMissingInstruments?: boolean;
}

export class WebSocketManager {
  private wsClient: UpstoxWebSocketClient;
  private candleAggregator: CandleAggregator;
  private healthMonitor: HealthMonitor;
  private volumeTracker = new CumulativeVolumeTracker();
  private activeInstruments = new Set<string>();
  private initialInstruments: string[];
  private maxInstruments: number;
  private failOnMissingInstruments: boolean;
  private isRunning = false;

  constructor(
    candleAggregator: CandleAggregator,
    healthMonitor: HealthMonitor,
    upstoxClient: UpstoxClient,
    options: WebSocketManagerOptions = {},
  ) {
    this.candleAggregator = candleAggregator;
    this.healthMonitor = healthMonitor;
    this.maxInstruments = options.maxInstruments ?? 100;
    this.initialInstruments = options.initialInstruments ?? [];
    this.failOnMissingInstruments = options.failOnMissingInstruments ?? true;

    if (options.activeIntervals) {
      this.candleAggregator.setActiveIntervals(options.activeIntervals);
    }

    this.wsClient = new UpstoxWebSocketClient({
      upstoxClient,
      reconnectAttempts: options.reconnectAttempts ?? 5,
      subscriptionMode: "full",
      onTick: this.handleTick.bind(this),
      onConnect: this.handleWebSocketConnect.bind(this),
      onDisconnect: this.handleWebSocketDisconnect.bind(this),
      onError: this.handleWebSocketError.bind(this),
    });

    logger.info("WebSocket Manager initialized", {
      activeIntervals: this.candleAggregator.getStats().intervals,
      maxInstruments: this.maxInstruments,
    });
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("WebSocket Manager is already running");
      return;
    }
    logger.info("Starting WebSocket Manager...");
    try {
      if (this.initialInstruments.length > 0) {
        const missing = await this.candleAggregator.preloadInstrumentIds(
          this.initialInstruments,
        );
        if (missing.length > 0) {
          const msg = `Instruments missing from 'instruments' table: ${missing.join(", ")}`;
          if (this.failOnMissingInstruments) throw new Error(msg);
          logger.warn(msg);
        }
        const newInstruments = this.initialInstruments.filter(
          (inst) => !this.activeInstruments.has(inst),
        );
        newInstruments.forEach((inst) => this.activeInstruments.add(inst));
        this.healthMonitor.addInstruments(newInstruments);
      }

      this.healthMonitor.start();
      this.candleAggregator.startFlusher();
      this.wsClient.connect();
      this.isRunning = true;
      logger.info("WebSocket Manager started successfully");
    } catch (error) {
      logger.error("Failed to start WebSocket Manager", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Order matters (Bug #11): disconnect first so the resulting onDisconnect →
   * healthMonitor.onWebSocketDisconnect() runs while the monitor is still alive,
   * then stop the monitor (which clears any fallback timers it just armed).
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn("WebSocket Manager is not running");
      return;
    }
    logger.info("Stopping WebSocket Manager...");
    try {
      this.isRunning = false;
      this.wsClient.disconnect();
      this.candleAggregator.stopFlusher();
      await this.candleAggregator.flushAllBuckets();
      this.healthMonitor.stop();
      logger.info("WebSocket Manager stopped successfully");
    } catch (error) {
      logger.error("Error stopping WebSocket Manager", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  subscribe(instruments: string[]): void {
    if (!this.isRunning) throw new Error("WebSocket Manager is not running");

    const newInstruments = instruments.filter(
      (inst) => !this.activeInstruments.has(inst),
    );
    if (
      this.activeInstruments.size + newInstruments.length >
      this.maxInstruments
    ) {
      throw new Error(
        `Cannot subscribe to ${newInstruments.length} instruments. Would exceed max limit of ${this.maxInstruments}`,
      );
    }
    logger.info("Subscribing to instruments", {
      new: newInstruments.length,
      total: this.activeInstruments.size + newInstruments.length,
    });
    void this.candleAggregator
      .preloadInstrumentIds(newInstruments)
      .then((missing) => {
        if (missing.length > 0) {
          logger.error(
            "Subscribed instruments missing from 'instruments' table; their candles will be dropped",
            {
              missing,
            },
          );
        }
      });
    this.wsClient.subscribe(newInstruments);
    newInstruments.forEach((inst) => this.activeInstruments.add(inst));
    this.healthMonitor.addInstruments(newInstruments);
  }

  unsubscribe(instruments: string[]): void {
    if (!this.isRunning) {
      logger.warn("WebSocket Manager is not running");
      return;
    }
    const instrumentsToRemove = instruments.filter((inst) =>
      this.activeInstruments.has(inst),
    );
    if (instrumentsToRemove.length === 0) return;

    logger.info("Unsubscribing from instruments", {
      removing: instrumentsToRemove.length,
      remaining: this.activeInstruments.size - instrumentsToRemove.length,
    });
    this.wsClient.unsubscribe(instrumentsToRemove);
    instrumentsToRemove.forEach((inst) => {
      this.activeInstruments.delete(inst);
      this.volumeTracker.reset(inst);
    });
    this.healthMonitor.removeInstruments(instrumentsToRemove);
  }

  private async handleTick(tick: UpstoxWSTick): Promise<void> {
    try {
      const instrumentKey = tick.instrument_token;
      const price = tick.last_price ?? tick.ohlc?.close;

      // A traded price is strictly positive; 0 means "no trade yet" (pre-open / illiquid).
      if (price === undefined || !Number.isFinite(price) || price <= 0) {
        logger.warn("Tick received without usable price", {
          instrumentKey,
          price,
        });
        return;
      }

      const volumeDelta = this.volumeTracker.delta(instrumentKey, tick.volume);
      const timestamp = tick.timestamp ? new Date(tick.timestamp) : new Date();

      await this.candleAggregator.processTick(
        instrumentKey,
        price,
        volumeDelta,
        timestamp,
      );
      this.healthMonitor.onTickReceived(instrumentKey);
    } catch (error) {
      logger.error("Error processing tick", {
        error: error instanceof Error ? error.message : String(error),
        instrumentKey: tick.instrument_token,
      });
    }
  }

  private handleWebSocketConnect(): void {
    logger.info("WebSocket connected - subscribing to active instruments", {
      count: this.activeInstruments.size,
    });
    this.healthMonitor.onWebSocketConnect();
    if (this.activeInstruments.size > 0) {
      this.wsClient.subscribe(Array.from(this.activeInstruments));
    }
  }

  private handleWebSocketDisconnect(): void {
    if (!this.isRunning) return; // deliberate stop(); nothing to fall back to
    logger.warn("WebSocket disconnected - API fallback will activate");
    this.healthMonitor.onWebSocketDisconnect();
  }

  private handleWebSocketError(error: Error): void {
    logger.error("WebSocket error", { error: error.message });
    this.healthMonitor.onWebSocketError(error);
  }

  getStatus(): WebSocketManagerStatus {
    return {
      isRunning: this.isRunning,
      activeInstruments: this.activeInstruments.size,
      wsConnected: this.wsClient.isWebSocketConnected(),
      healthStatus: this.healthMonitor.getHealthStatus(),
      candleStats: this.candleAggregator.getStats(),
    };
  }

  setActiveIntervals(intervals: CandleInterval[]): void {
    this.candleAggregator.setActiveIntervals(intervals);
  }

  getActiveInstruments(): string[] {
    return Array.from(this.activeInstruments);
  }
}
