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

const MAX_NUMBERED_ACCOUNTS = 20;

function parseRoles(raw: unknown, where: string): UpstoxAccountRole[] {
  const list: string[] = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === "string"
      ? raw
          .split(",")
          .map((r) => r.trim())
          .filter(Boolean)
      : [];
  const invalid = list.filter(
    (r) => !(VALID_ROLES as readonly string[]).includes(r),
  );
  if (invalid.length > 0) {
    throw new Error(
      `${where}: unknown role(s) ${invalid.join(", ")}. Valid: ${VALID_ROLES.join(", ")}`,
    );
  }
  const roles = Array.from(new Set(list)) as UpstoxAccountRole[];
  if (roles.length === 0)
    throw new Error(
      `${where} needs at least one role of ${VALID_ROLES.join(", ")}`,
    );
  return roles;
}

function parseBool(raw: string | null): boolean {
  return raw !== null && ["1", "true", "yes", "y"].includes(raw.toLowerCase());
}

/** UPSTOX_ACCOUNTS='[{"alias":"a1","token":"...","roles":["hist","ws"],"plus":true}, ...]' */
function readJsonAccounts(raw: string): UpstoxAccount[] {
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
  return parsed.map((entry, idx) => {
    const e = entry as {
      alias?: unknown;
      token?: unknown;
      roles?: unknown;
      plus?: unknown;
    };
    const alias =
      typeof e.alias === "string" && e.alias.trim()
        ? e.alias.trim()
        : `account-${idx + 1}`;
    if (typeof e.token !== "string" || !e.token.trim()) {
      throw new Error(
        `UPSTOX_ACCOUNTS[${idx}] ("${alias}") is missing "token"`,
      );
    }
    return {
      alias,
      token: e.token.trim(),
      roles: parseRoles(e.roles, `UPSTOX_ACCOUNTS[${idx}] ("${alias}")`),
      plus: e.plus === true,
    };
  });
}

/**
 * Numbered accounts — easier to edit than one long JSON line:
 *   UPSTOX_ACCOUNT_1_TOKEN=...        required
 *   UPSTOX_ACCOUNT_1_ALIAS=acct1      optional, default "account-1"
 *   UPSTOX_ACCOUNT_1_ROLES=hist,ws    optional, default "hist,ws" (Analytics Tokens are read-only)
 *   UPSTOX_ACCOUNT_1_PLUS=true        optional, default false
 * Gaps are allowed (1, 2, 4 is fine). Numbers run 1..20.
 */
function readNumberedAccounts(env: NodeJS.ProcessEnv): UpstoxAccount[] {
  const accounts: UpstoxAccount[] = [];
  for (let n = 1; n <= MAX_NUMBERED_ACCOUNTS; n++) {
    const prefix = `UPSTOX_ACCOUNT_${n}_`;
    const token = readOptional(env, `${prefix}TOKEN`);
    const alias = readOptional(env, `${prefix}ALIAS`);
    const rolesRaw = readOptional(env, `${prefix}ROLES`);
    if (!token) {
      if (alias || rolesRaw)
        throw new Error(
          `${prefix}ALIAS/ROLES set but ${prefix}TOKEN is missing`,
        );
      continue;
    }
    accounts.push({
      alias: alias ?? `account-${n}`,
      token,
      roles: parseRoles(rolesRaw ?? "hist,ws", `${prefix}ROLES`),
      plus: parseBool(readOptional(env, `${prefix}PLUS`)),
    });
  }
  return accounts;
}

/** Legacy single-token vars, kept so older .env files still work. */
function readLegacyAccounts(env: NodeJS.ProcessEnv): UpstoxAccount[] {
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

/**
 * Account sources, first non-empty wins: UPSTOX_ACCOUNTS (JSON) → UPSTOX_ACCOUNT_<n>_* → legacy vars.
 * Sources are never merged, so a given setup is defined in exactly one place.
 */
function readUpstoxAccounts(env: NodeJS.ProcessEnv): UpstoxAccount[] {
  const json = readOptional(env, "UPSTOX_ACCOUNTS");
  const primary = json ? readJsonAccounts(json) : readNumberedAccounts(env);
  const resolved = primary.length > 0 ? primary : readLegacyAccounts(env);

  const aliases = new Set<string>();
  const tokens = new Set<string>();
  for (const a of resolved) {
    if (aliases.has(a.alias))
      throw new Error(`Duplicate Upstox account alias "${a.alias}"`);
    if (tokens.has(a.token)) {
      // Same token twice = same user = same rate-limit bucket; counting it twice would overshoot the limit.
      throw new Error(
        `Upstox account "${a.alias}" reuses a token already configured for another account`,
      );
    }
    aliases.add(a.alias);
    tokens.add(a.token);
  }
  return resolved;
}

/** Safe for logs: never the token itself, only a short fingerprint to tell accounts apart. */
export function describeAccount(a: UpstoxAccount): {
  alias: string;
  roles: UpstoxAccountRole[];
  plus: boolean;
  token: string;
} {
  return {
    alias: a.alias,
    roles: a.roles,
    plus: a.plus,
    token: `…${a.token.slice(-6)}`,
  };
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
          `No Upstox account with role "${role}". Set UPSTOX_ACCOUNT_<n>_TOKEN (+ _ROLES), UPSTOX_ACCOUNTS, or ` +
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
    upstoxInstrumentKeys: readCsvList(env, "UPSTOX_INSTRUMENT_KEYS"),
  };
}
