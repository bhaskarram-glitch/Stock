/**
 * The live streaming worker (Phase 3, step 3.2): one Upstox connection per `ws` account, each
 * subscribed to its shard of the universe, all ticks into one CandleAggregator.
 *
 * Tick rules (TickFilter):
 * - Upstox `full` mode re-sends an instrument whenever ANY field changes (depth, OI, …). Only a new
 *   trade moves a candle, so a tick is used only when its last-trade time (ltt) or price changed.
 * - The first tick per instrument after start only sets the baseline (price/ltt/cumulative volume):
 *   it describes the last trade, which may be from yesterday for an illiquid strike.
 * - OI is remembered from every tick and attached to the next trade.
 * - Candle time = ltt (exchange time), so a late-delivered trade still lands in its own minute;
 *   the aggregator drops it if that bucket already closed.
 */
import { logger } from "../lib/logger.js";
import type { UpstoxClient } from "../providers/upstox/client.js";
import {
  UpstoxWebSocketClient,
  type UpstoxWebSocketLike,
  type UpstoxWSTick,
} from "../providers/upstox/websocket-client.js";
import type { CandleAggregator } from "./candle-aggregator.js";
import type { LiveInstrument } from "./live-universe.js";
import { CumulativeVolumeTracker } from "./volume-tracker.js";

interface LastSeen {
  ltt: number;
  price: number;
  oi?: number;
}

export interface AcceptedTick {
  price: number;
  volumeDelta: number;
  timestamp: Date;
  oi?: number;
}

export class TickFilter {
  private readonly last = new Map<string, LastSeen>();
  private readonly volume = new CumulativeVolumeTracker();
  baselines = 0;
  duplicates = 0;
  accepted = 0;

  /** Returns what to feed the aggregator, or null when the tick is not a new trade. */
  accept(tick: UpstoxWSTick): AcceptedTick | null {
    const key = tick.instrument_token;
    const price = tick.last_price;
    const lttIso = tick.market_data?.ltt ?? tick.timestamp;
    const ltt = lttIso ? Date.parse(lttIso) : NaN;
    if (price === undefined || !Number.isFinite(price) || !Number.isFinite(ltt)) return null;
    const oiRaw = tick.market_data?.oi;
    const oi = oiRaw !== undefined && Number.isFinite(oiRaw) ? oiRaw : undefined;

    const prev = this.last.get(key);
    if (!prev) {
      this.last.set(key, { ltt, price, oi });
      this.volume.delta(key, tick.volume);
      this.baselines += 1;
      return null;
    }
    if (oi !== undefined) prev.oi = oi;
    if (ltt === prev.ltt && price === prev.price) {
      this.duplicates += 1;
      return null;
    }
    if (ltt < prev.ltt) {
      // out-of-order delivery of an older trade: never move the clock backwards
      this.duplicates += 1;
      return null;
    }
    prev.ltt = ltt;
    prev.price = price;
    this.accepted += 1;
    return {
      price,
      volumeDelta: this.volume.delta(key, tick.volume),
      timestamp: new Date(ltt),
      oi: prev.oi,
    };
  }

  size(): number {
    return this.last.size;
  }
}

export interface LiveShard {
  alias: string;
  upstoxClient: Pick<UpstoxClient, "authorizeMarketDataFeed">;
  instruments: LiveInstrument[];
}

export interface LiveStreamOptions {
  shards: LiveShard[];
  aggregator: CandleAggregator;
  /** Called once when every connection has been down this long. Default 10 min. */
  allDownLimitMs?: number;
  onAllDown?: (downForMs: number) => void;
  now?: () => number;
  socketFactory?: (url: string) => UpstoxWebSocketLike;
  /** How often the watchdog looks. Default 15s. */
  watchdogIntervalMs?: number;
}

interface ShardState {
  shard: LiveShard;
  client: UpstoxWebSocketClient;
  connected: boolean;
  connects: number;
  ticks: number;
}

export class LiveStream {
  private readonly byFeedKey = new Map<string, LiveInstrument>();
  private readonly filter = new TickFilter();
  private readonly states: ShardState[] = [];
  private readonly now: () => number;
  private readonly allDownLimitMs: number;
  private lastAnyUpMs: number;
  private watchdog?: NodeJS.Timeout;
  private allDownReported = false;
  private stopping = false;
  /** One raw future tick per minute goes to the log — evidence for the measuring day (3.5). */
  private sampleDueMs = 0;
  unknownTicks = 0;

  constructor(private readonly options: LiveStreamOptions) {
    this.now = options.now ?? Date.now;
    this.allDownLimitMs = options.allDownLimitMs ?? 10 * 60_000;
    this.lastAnyUpMs = this.now();
    for (const shard of options.shards) {
      for (const inst of shard.instruments) this.byFeedKey.set(inst.feedKey, inst);
      const state: ShardState = { shard, client: undefined as never, connected: false, connects: 0, ticks: 0 };
      state.client = new UpstoxWebSocketClient({
        upstoxClient: shard.upstoxClient,
        label: shard.alias,
        subscriptionMode: "full",
        socketFactory: options.socketFactory,
        onTick: (tick) => {
          state.ticks += 1;
          this.handleTick(tick);
        },
        onConnect: () => {
          state.connected = true;
          state.connects += 1;
          if (state.connects > 1) logger.warn("Upstox stream reconnected", { account: shard.alias, connects: state.connects });
          state.client.subscribe(shard.instruments.map((i) => i.feedKey));
        },
        onDisconnect: () => {
          if (state.connected && !this.stopping) logger.warn("Upstox stream disconnected", { account: shard.alias });
          state.connected = false;
          if (this.states.some((s) => s.connected)) return;
          this.lastAnyUpMs = this.now();
        },
        onError: (error) => logger.debug("Upstox stream error", { account: shard.alias, error: error.message }),
      });
      this.states.push(state);
    }
  }

  start(): void {
    this.options.aggregator.startFlusher();
    for (const s of this.states) s.client.connect();
    this.watchdog = setInterval(() => this.checkWatchdog(), this.options.watchdogIntervalMs ?? 15_000);
    this.watchdog.unref?.();
  }

  /** Disconnects every account and writes every open candle. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.watchdog) clearInterval(this.watchdog);
    for (const s of this.states) s.client.disconnect();
    this.options.aggregator.stopFlusher();
    await this.options.aggregator.flushAllBuckets();
  }

  handleTick(tick: UpstoxWSTick): void {
    const inst = this.byFeedKey.get(tick.instrument_token);
    if (!inst) {
      this.unknownTicks += 1;
      return;
    }
    if (inst.kind === "future" && this.now() >= this.sampleDueMs) {
      this.sampleDueMs = this.now() + 60_000;
      logger.info("Feed sample", {
        key: inst.storeKey,
        ltt: tick.market_data?.ltt,
        price: tick.last_price,
        volume: tick.volume,
        oi: tick.market_data?.oi,
        ohlc: tick.ohlc,
      });
    }
    const t = this.filter.accept(tick);
    if (!t) return;
    void this.options.aggregator.processTick(inst.storeKey, t.price, t.volumeDelta, t.timestamp, t.oi);
  }

  checkWatchdog(): void {
    if (this.states.some((s) => s.connected)) {
      this.lastAnyUpMs = this.now();
      this.allDownReported = false;
      return;
    }
    const downFor = this.now() - this.lastAnyUpMs;
    if (downFor >= this.allDownLimitMs && !this.allDownReported) {
      this.allDownReported = true;
      logger.error("No Upstox stream connected", { downForMs: downFor });
      this.options.onAllDown?.(downFor);
    }
  }

  getStatus() {
    const agg = this.options.aggregator.getStats();
    return {
      connected: `${this.states.filter((s) => s.connected).length}/${this.states.length}`,
      accounts: Object.fromEntries(
        this.states.map((s) => [s.shard.alias, { up: s.connected, keys: s.shard.instruments.length, ticks: s.ticks, connects: s.connects }]),
      ),
      instrumentsSeen: this.filter.size(),
      trades: this.filter.accepted,
      duplicates: this.filter.duplicates,
      unknownTicks: this.unknownTicks,
      openBuckets: agg.activeBuckets,
      pendingPersist: agg.pendingPersist,
      droppedLateTicks: agg.droppedLateTicks,
    };
  }
}
