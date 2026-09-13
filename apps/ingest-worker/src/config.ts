import { DEFAULT_UPSTOX_BASE_URL } from "./providers/upstox/client.js";

export type WorkerMode = "healthcheck" | "websocket-stream";

/** What an Upstox account/token is allowed to be used for. */
export type UpstoxAccountRole = "ws" | "hist" | "trade";

export interface UpstoxAccount {
  /** Stable name used in logs and config, e.g. "primary", "plus-2". Never the token. */
  alias: string;
  token: string;
  roles: UpstoxAccountRole[];
  /** Upstox Plus accounts get 5 WS connections instead of 2. Default false. */
  plus: boolean;
}

export interface UpstoxAccountRegistry {
  all: UpstoxAccount[];
  /** All accounts holding `role`, in config order. */
  forRole(role: UpstoxAccountRole): UpstoxAccount[];
  /** First account holding `role`, or null. */
  first(role: UpstoxAccountRole): UpstoxAccount | null;
  /** First account holding `role`; throws with a helpful message if none. */
  require(role: UpstoxAccountRole): UpstoxAccount;
}

export type AppConfig = {
  workerMode: WorkerMode;
  supabaseUrl: string | null;
  supabaseServiceRoleKey: string | null;
  hasSupabase: boolean;
  upstoxBaseUrl: string;
  upstoxAccounts: UpstoxAccountRegistry;
  /** @deprecated use `upstoxAccounts.first("ws")`. Kept so existing call sites compile. */
  upstoxAccessToken: string | null;
  upstoxInstrumentKeys: string[];
};

const VALID_MODES: readonly WorkerMode[] = ["healthcheck", "websocket-stream"];
const VALID_ROLES: readonly UpstoxAccountRole[] = ["ws", "hist", "trade"];

function readOptional(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

function readCsvList(env: NodeJS.ProcessEnv, key: string): string[] {
  const raw = readOptional(env, key);
  return raw
    ? raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

function readWorkerMode(env: NodeJS.ProcessEnv): WorkerMode {
  const raw = readOptional(env, "WORKER_MODE");
  if (raw === null) return "healthcheck";
  if ((VALID_MODES as readonly string[]).includes(raw))
    return raw as WorkerMode;
  throw new Error(
    `Invalid WORKER_MODE "${raw}". Valid: ${VALID_MODES.join(" | ")}`,
  );
}

/**
 * Parses UPSTOX_ACCOUNTS (JSON array). Example:
 *   [{"alias":"primary","token":"...","roles":["ws","trade"],"plus":true},
 *    {"alias":"analytics","token":"...","roles":["hist","ws"]}]
 * Falls back to UPSTOX_ACCESS_TOKEN (roles ws,trade) and UPSTOX_ANALYTICS_TOKEN (roles hist,ws).
 */
function readUpstoxAccounts(env: NodeJS.ProcessEnv): UpstoxAccount[] {
  const raw = readOptional(env, "UPSTOX_ACCOUNTS");
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `UPSTOX_ACCOUNTS is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("UPSTOX_ACCOUNTS must be a non-empty JSON array");
    }
    const seen = new Set<string>();
    return parsed.map((entry, idx) => {
      const e = entry as Partial<UpstoxAccount>;
      const alias =
        typeof e.alias === "string" && e.alias.trim()
          ? e.alias.trim()
          : `account-${idx + 1}`;
      if (seen.has(alias))
        throw new Error(`UPSTOX_ACCOUNTS: duplicate alias "${alias}"`);
      seen.add(alias);
      if (typeof e.token !== "string" || !e.token.trim()) {
        throw new Error(
          `UPSTOX_ACCOUNTS[${idx}] ("${alias}") is missing "token"`,
        );
      }
      const roles = Array.isArray(e.roles)
        ? e.roles.filter((r): r is UpstoxAccountRole =>
            VALID_ROLES.includes(r as UpstoxAccountRole),
          )
        : [];
      if (roles.length === 0) {
        throw new Error(
          `UPSTOX_ACCOUNTS[${idx}] ("${alias}") needs at least one role of ${VALID_ROLES.join(", ")}`,
        );
      }
      return { alias, token: e.token.trim(), roles, plus: e.plus === true };
    });
  }

  const accounts: UpstoxAccount[] = [];
  const accessToken = readOptional(env, "UPSTOX_ACCESS_TOKEN");
  if (accessToken)
    accounts.push({
      alias: "primary",
      token: accessToken,
      roles: ["ws", "trade"],
      plus: false,
    });
  const analyticsToken = readOptional(env, "UPSTOX_ANALYTICS_TOKEN");
  if (analyticsToken)
    accounts.push({
      alias: "analytics",
      token: analyticsToken,
      roles: ["hist", "ws"],
      plus: false,
    });
  return accounts;
}

function buildRegistry(accounts: UpstoxAccount[]): UpstoxAccountRegistry {
  const forRole = (role: UpstoxAccountRole) =>
    accounts.filter((a) => a.roles.includes(role));
  return {
    all: accounts,
    forRole,
    first: (role) => forRole(role)[0] ?? null,
    require: (role) => {
      const account = forRole(role)[0];
      if (!account) {
        throw new Error(
          `No Upstox account with role "${role}". Set UPSTOX_ACCOUNTS, or ` +
            (role === "hist"
              ? "UPSTOX_ANALYTICS_TOKEN"
              : "UPSTOX_ACCESS_TOKEN") +
            ".",
        );
      }
      return account;
    },
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const supabaseUrl = readOptional(env, "SUPABASE_URL");
  const supabaseServiceRoleKey = readOptional(env, "SUPABASE_SERVICE_ROLE_KEY");
  const upstoxAccounts = buildRegistry(readUpstoxAccounts(env));

  return {
    workerMode: readWorkerMode(env),
    supabaseUrl,
    supabaseServiceRoleKey,
    hasSupabase: Boolean(supabaseUrl && supabaseServiceRoleKey),
    upstoxBaseUrl:
      readOptional(env, "UPSTOX_BASE_URL") ?? DEFAULT_UPSTOX_BASE_URL,
    upstoxAccounts,
    upstoxAccessToken: upstoxAccounts.first("ws")?.token ?? null,
    upstoxInstrumentKeys: readCsvList(env, "UPSTOX_INSTRUMENT_KEYS"),
  };
}
