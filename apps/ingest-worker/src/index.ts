import "dotenv/config.js";
import { describeAccount, loadConfig } from "./config.js";
import { logger } from "./lib/logger.js";
import { closeDb, getDb } from "./lib/db.js";
import { createUpstoxClientFromEnv } from "./providers/upstox/client.js";
import {
  FNO_INDEX_UNDERLYINGS,
  resolveUnderlyings,
  type IndexInstrumentRow,
} from "./providers/upstox/indices.js";
import { decideSession, istClock, parseHhMm } from "./providers/upstox/market-calendar.js";
import { CandleAggregator, type CandleInterval } from "./services/candle-aggregator.js";
import { LiveCandleSink } from "./services/live-candle-sink.js";
import { LiveStream } from "./services/live-stream.js";
import { describeDropped, loadLiveUniverse, planShards } from "./services/live-universe.js";

const LIVE_INTERVALS: CandleInterval[] = ["1m", "5m", "15m", "1h"];
const MARKET_OPEN_MIN = 9 * 60 + 15; // 09:15 IST

/** Verifies config + DB reachability. Exit code is the signal; used by supervisors and CI. */
async function runHealthcheck(
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  if (!config.databaseUrl) throw new Error("healthcheck requires DATABASE_URL");
  // Planner estimate, not count(*): instant even on a multi-million-row table.
  const { rows } = await getDb().query<{ estimate: number }>(
    "select greatest(reltuples, 0)::bigint as estimate from pg_class where oid = 'public.instruments'::regclass",
  );

  logger.info("Healthcheck OK", {
    instrumentsInDbApprox: rows[0]?.estimate ?? 0,
    upstoxAccounts: config.upstoxAccounts.all.map(describeAccount),
  });
  await closeDb();
}

/**
 * Live streaming (Phase 3). Started by stock-stream.timer on weekdays; exits 0 by itself at
 * LIVE_STOP, at once outside the window / on weekends / on F&O holidays, and exits 1 (→ systemd
 * restarts it) if no Upstox connection has been up for 10 minutes.
 */
async function runWebsocketStream(config: ReturnType<typeof loadConfig>): Promise<void> {
  if (!config.databaseUrl) throw new Error("websocket-stream requires DATABASE_URL");
  const wsAccounts = config.upstoxAccounts.forRole("ws");
  if (wsAccounts.length === 0) config.upstoxAccounts.require("ws"); // throws with guidance
  const clients = new Map(
    wsAccounts.map((a) => [a.alias, createUpstoxClientFromEnv(a.token, config.upstoxBaseUrl)]),
  );

  const startMin = parseHhMm(config.live.startTime);
  const stopMin = parseHhMm(config.live.stopTime);
  const decision = await decideSession(Date.now(), { startMin, stopMin }, () =>
    clients.get(wsAccounts[0].alias)!.fetchMarketHolidays(),
  );
  if (!decision.stream) {
    logger.info("Not streaming today", { reason: decision.reason });
    await closeDb();
    return;
  }

  const db = getDb();
  const today = istClock(Date.now()).date;
  const { rows: indexRows } = await db.query<IndexInstrumentRow>(
    `select id, provider_instrument_key, trading_symbol, name, segment
       from instruments where segment in ('NSE_INDEX', 'BSE_INDEX')`,
  );
  const wanted =
    config.live.symbols.length > 0
      ? FNO_INDEX_UNDERLYINGS.filter((u) => config.live.symbols.includes(u.symbol))
      : FNO_INDEX_UNDERLYINGS;
  const { resolved, unresolved } = resolveUnderlyings(wanted, indexRows);
  if (unresolved.length > 0) {
    logger.error("Could not resolve these underlyings", { symbols: unresolved.map((u) => u.symbol) });
  }
  if (resolved.length === 0) throw new Error("No underlyings resolved — run sync-instruments first");

  const universe = await loadLiveUniverse(db, resolved, today);
  const plan = planShards(universe, wsAccounts.map((a) => a.alias), config.live.keysPerAccount);
  const kinds = (k: string) => universe.filter((i) => i.kind === k).length;
  logger.info("Live universe", {
    date: today,
    underlyings: resolved.map((u) => u.symbol),
    total: universe.length,
    spots: kinds("spot"),
    futures: kinds("future"),
    options: kinds("option"),
    capacity: plan.capacity,
    accounts: wsAccounts.map(describeAccount),
  });
  if (plan.dropped.length > 0) {
    logger.warn("Universe exceeds account capacity; farthest expiries left out", describeDropped(plan.dropped));
  }

  const sids = new Map(universe.map((i) => [i.storeKey, i.sid]));
  const spotKeys = new Set(universe.filter((i) => i.kind === "spot").map((i) => i.storeKey));
  const sink = new LiveCandleSink(db, sids, undefined, spotKeys);
  await sink.ensurePartitions(today);
  const aggregator = new CandleAggregator(db, { activeIntervals: LIVE_INTERVALS, sink, closeGraceMs: 3_000 });
  const startMs = Date.now();

  let shuttingDown = false;
  const shutdown = async (reason: string, code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Live stream stopping", { reason, ...stream.getStatus(), sink: sink.getStats() });
    clearInterval(statusTimer);
    clearTimeout(stopTimer);
    try {
      await stream.stop(); // writes every open candle before the pool closes
      await closeDb();
    } catch (error) {
      logger.error("Shutdown error", { error: error instanceof Error ? error.message : String(error) });
      code = 1;
    }
    process.exit(code);
  };

  const stream = new LiveStream({
    shards: [...plan.shards].map(([alias, instruments]) => ({
      alias,
      upstoxClient: clients.get(alias)!,
      instruments,
    })),
    aggregator,
    // started before the 09:15 open → a contract's first trade today carries all of today's volume
    tickFilter: { startMs, countFirstTradeVolume: istClock(startMs).minutes < MARKET_OPEN_MIN },
    onAllDown: (ms) => void shutdown(`no connection for ${Math.round(ms / 60_000)} min`, 1),
  });
  stream.start();

  const nowMin = istClock(Date.now()).minutes;
  const stopInMs = Math.max(0, (stopMin - nowMin) * 60_000 - (Date.now() % 60_000));
  const stopTimer = setTimeout(() => void shutdown(`stop time ${config.live.stopTime} IST`, 0), stopInMs);
  const statusTimer = setInterval(
    () => logger.info("Live status", { ...stream.getStatus(), sink: sink.getStats() }),
    60_000,
  );
  logger.info("Live stream started", { stopsAt: config.live.stopTime, stopInMin: Math.round(stopInMs / 60_000) });

  process.on("SIGINT", () => void shutdown("SIGINT", 0));
  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
}

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info("Worker starting", {
    workerMode: config.workerMode,
    hasDatabase: Boolean(config.databaseUrl),
    upstoxAccounts: config.upstoxAccounts.all.length,
  });

  switch (config.workerMode) {
    case "websocket-stream":
      return runWebsocketStream(config);
    case "healthcheck":
      return runHealthcheck(config);
    default:
      throw new Error(
        `Unknown WORKER_MODE "${String(config.workerMode)}". Valid: healthcheck | websocket-stream`,
      );
  }
}

main().catch((err) => {
  logger.error("Worker failed", {
    message: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
