export type WorkerMode =
  | "healthcheck"
  | "snapshot-smoke"
  | "upstox-quote"
  | "websocket-stream";

export type AppConfig = {
  workerMode: WorkerMode;
  supabaseUrl: string | null;
  supabaseServiceRoleKey: string | null;
  hasSupabase: boolean;
  smokeInstrumentId: string | null;
  upstoxAccessToken: string | null;
  upstoxBaseUrl: string;
  upstoxInstrumentKey: string | null;
  upstoxInstrumentKeys: string[];
};

function readOptional(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

function readCsvList(env: NodeJS.ProcessEnv, key: string): string[] {
  const raw = readOptional(env, key);
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readWorkerMode(env: NodeJS.ProcessEnv): WorkerMode {
  const rawMode = readOptional(env, "WORKER_MODE");

  if (
    rawMode === "healthcheck" ||
    rawMode === "snapshot-smoke" ||
    rawMode === "upstox-quote" ||
    rawMode === "websocket-stream"
  ) {
    return rawMode;
  }

  return "healthcheck";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const supabaseUrl = readOptional(env, "SUPABASE_URL");
  const supabaseServiceRoleKey = readOptional(env, "SUPABASE_SERVICE_ROLE_KEY");

  return {
    workerMode: readWorkerMode(env),
    supabaseUrl,
    supabaseServiceRoleKey,
    hasSupabase: Boolean(supabaseUrl && supabaseServiceRoleKey),
    smokeInstrumentId: readOptional(env, "SMOKE_INSTRUMENT_ID"),
    upstoxAccessToken: readOptional(env, "UPSTOX_ACCESS_TOKEN"),
    upstoxBaseUrl:
      readOptional(env, "UPSTOX_BASE_URL") ?? "https://api.upstox.com/v2",
    upstoxInstrumentKey: readOptional(env, "UPSTOX_INSTRUMENT_KEY"),
    upstoxInstrumentKeys: readCsvList(env, "UPSTOX_INSTRUMENT_KEYS"),
  };
}
