import "dotenv/config.js";
import { loadConfig } from "./config.js";
import { logger } from "./lib/logger.js";
import { getSupabaseClient } from "./lib/supabase.js";
import { createUpstoxClientFromEnv } from "./providers/upstox/client.js";
import {
  CandleAggregator,
  type CandleInterval,
} from "./services/candle-aggregator.js";
import { HealthMonitor } from "./services/health-monitor.js";
import { WebSocketManager } from "./services/websocket-manager.js";

const ACTIVE_INTERVALS: CandleInterval[] = ["1m", "5m", "15m", "1h"];

// Defaults for local runs only; production sets UPSTOX_INSTRUMENT_KEYS.
const DEFAULT_INSTRUMENTS = [
  "NSE_EQ|INE002A01018", // Reliance
  "NSE_EQ|INE009A01021", // Infosys
  "NSE_EQ|INE238A01034", // Tata Steel
];

/** Verifies config + DB reachability. Exit code is the signal; used by supervisors and CI. */
async function runHealthcheck(
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  if (!config.hasSupabase) {
    throw new Error(
      "healthcheck requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
    );
  }
  const { error, count } = await getSupabaseClient()
    .from("instruments")
    .select("id", { count: "exact", head: true });
  if (error) throw new Error(`Supabase unreachable: ${error.message}`);

  logger.info("Healthcheck OK", {
    instrumentsInDb: count ?? 0,
    hasUpstoxToken: Boolean(config.upstoxAccessToken),
  });
}

async function runWebsocketStream(
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  if (!config.hasSupabase) {
    throw new Error(
      "websocket-stream requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
    );
  }
  if (!config.upstoxAccessToken) {
    throw new Error("websocket-stream requires UPSTOX_ACCESS_TOKEN");
  }

  const supabase = getSupabaseClient();
  const upstoxClient = createUpstoxClientFromEnv(
    config.upstoxAccessToken,
    config.upstoxBaseUrl,
  );
  const candleAggregator = new CandleAggregator(supabase, {
    activeIntervals: ACTIVE_INTERVALS,
  });
  const healthMonitor = new HealthMonitor({
    supabase,
    upstoxClient,
    healthCheckInterval: 30_000,
    apiFallbackDelay: 60_000,
    apiFallbackInterval: 3_600_000,
  });

  const initialInstruments =
    config.upstoxInstrumentKeys.length > 0
      ? config.upstoxInstrumentKeys
      : DEFAULT_INSTRUMENTS;

  const wsManager = new WebSocketManager(
    candleAggregator,
    healthMonitor,
    upstoxClient,
    {
      activeIntervals: ACTIVE_INTERVALS,
      maxInstruments: 2000, // Upstox full-mode cap per connection
      initialInstruments,
    },
  );

  await wsManager.start();
  logger.info("WebSocket streaming started", {
    instruments: initialInstruments.length,
    activeIntervals: ACTIVE_INTERVALS,
  });

  const statusInterval = setInterval(() => {
    const s = wsManager.getStatus();
    logger.info("Status", {
      wsConnected: s.wsConnected,
      activeInstruments: s.activeInstruments,
      candleBuckets: s.candleStats.activeBuckets,
      pendingPersist: s.candleStats.pendingPersist,
      droppedLateTicks: s.candleStats.droppedLateTicks,
      wsHealthy: s.healthStatus.wsHealthy,
      apiFallbackActive: s.healthStatus.apiFallbackActive,
    });
  }, 60_000);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down", { signal });
    clearInterval(statusInterval);
    try {
      await wsManager.stop();
      process.exit(0);
    } catch (error) {
      logger.error("Shutdown error", {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info("Worker starting", {
    workerMode: config.workerMode,
    hasSupabase: config.hasSupabase,
    hasUpstoxToken: Boolean(config.upstoxAccessToken),
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
