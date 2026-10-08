/**
 * Upstox historical + expired-instruments REST client (read-only; works with the Analytics Token).
 *
 * Endpoints (verified 2026-09-13):
 *   GET /v3/historical-candle/{instrument_key}/{unit}/{interval}/{to}/{from}      active instruments
 *   GET /v2/expired-instruments/expiries?instrument_key=                            last ~6 months only
 *   GET /v2/expired-instruments/option/contract?instrument_key=&expiry_date=        Plus
 *   GET /v2/expired-instruments/future/contract?instrument_key=&expiry_date=        Plus
 *   GET /v2/expired-instruments/historical-candle/{expired_key}/{interval}/{to}/{from}   Plus
 * Candle rows are [ts, open, high, low, close, volume, oi]. Dates are YYYY-MM-DD.
 *
 * Rate limits are per API, per user (25/s, 250/min, 1000/30 min). Each client therefore holds one
 * limiter per endpoint family, and each account gets its own client — see UpstoxHistoricalClientPool.
 */
import { logger } from "../../lib/logger.js";
import { DEFAULT_UPSTOX_BASE_URL } from "./client.js";
import { RateLimiter } from "./rate-limiter.js";

export type HistoricalUnit = "minutes" | "hours" | "days" | "weeks" | "months";
export type ExpiredInterval =
  | "1minute"
  | "3minute"
  | "5minute"
  | "15minute"
  | "30minute"
  | "day";

export interface HistoricalCandle {
  ts: string; // ISO with offset as returned by Upstox
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi: number | null;
}

export interface ExpiredContract {
  name: string;
  segment: string;
  exchange: string;
  expiry: string; // YYYY-MM-DD
  instrument_key: string; // e.g. NSE_FO|47983|17-04-2025
  exchange_token: string;
  trading_symbol: string;
  tick_size: number;
  lot_size: number;
  instrument_type: "CE" | "PE" | "FUT" | string;
  freeze_quantity?: number;
  underlying_key: string;
  underlying_type?: string;
  underlying_symbol: string;
  strike_price?: number;
  minimum_lot?: number;
  weekly?: boolean;
}

export class UpstoxApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null,
    public readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = "UpstoxApiError";
  }
  get isRateLimit(): boolean {
    return this.status === 429;
  }
  get isPlusRequired(): boolean {
    return this.code === "UDAPI1149";
  }
}

interface UpstoxEnvelope<T> {
  status: string;
  data?: T;
  errors?: Array<{ errorCode?: string; message?: string }>;
}

/**
 * Upstox counts limits per API. Calls that hit the same endpoint share a family; different
 * families have independent budgets, so listing contracts never slows candle downloads.
 */
export type EndpointFamily =
  | "historical-candles"
  | "expiries"
  | "contracts"
  | "expired-candles";

export const ENDPOINT_FAMILIES: readonly EndpointFamily[] = [
  "historical-candles",
  "expiries",
  "contracts",
  "expired-candles",
];

export type LimiterFactory = () => RateLimiter;

export interface UpstoxHistoricalClientOptions {
  baseUrl?: string;
  /** Name used in logs. Defaults to "default". */
  alias?: string;
  /**
   * Builds one limiter per endpoint family for this client. Each client MUST own its limiters —
   * two clients on the same token would double the real request rate.
   */
  limiterFactory?: LimiterFactory;
}

export interface FamilyUsage {
  lastMinute: number;
  lastThirtyMinutes: number;
  blockedForMs: number;
}

export class UpstoxHistoricalClient {
  readonly alias: string;
  private readonly baseUrl: string;
  private readonly limiters: Map<EndpointFamily, RateLimiter>;

  constructor(
    private readonly accessToken: string,
    options: UpstoxHistoricalClientOptions = {},
  ) {
    this.baseUrl = options.baseUrl ?? DEFAULT_UPSTOX_BASE_URL;
    this.alias = options.alias ?? "default";
    const factory = options.limiterFactory ?? (() => new RateLimiter());
    this.limiters = new Map(ENDPOINT_FAMILIES.map((f) => [f, factory()]));
  }

  /** ms until this client may send a request in `family` (0 = now). Used by the pool to choose. */
  msUntilAllowed(family: EndpointFamily): number {
    return this.limiter(family).msUntilAllowed();
  }

  usage(family: EndpointFamily): FamilyUsage {
    const s = this.limiter(family).stats();
    return {
      lastMinute: s.lastMinute,
      lastThirtyMinutes: s.lastThirtyMinutes,
      blockedForMs: s.blockedForMs,
    };
  }

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------

  /** Active instrument candles. unit=days interval=1 → daily. Ranges are inclusive. */
  async getHistoricalCandles(
    instrumentKey: string,
    unit: HistoricalUnit,
    interval: number,
    fromDate: string,
    toDate: string,
  ): Promise<HistoricalCandle[]> {
    const path = `/v3/historical-candle/${encodeURIComponent(instrumentKey)}/${unit}/${interval}/${toDate}/${fromDate}`;
    const data = await this.get<{ candles: unknown[][] }>(
      "historical-candles",
      path,
    );
    return (data.candles ?? []).map(parseCandle);
  }

  /** Expiry dates for an underlying (observed range: 2024-10 onwards). */
  async getExpiries(underlyingKey: string): Promise<string[]> {
    const data = await this.get<string[]>(
      "expiries",
      `/v2/expired-instruments/expiries?instrument_key=${encodeURIComponent(underlyingKey)}`,
    );
    return Array.isArray(data) ? data : [];
  }

  async getExpiredOptionContracts(
    underlyingKey: string,
    expiryDate: string,
  ): Promise<ExpiredContract[]> {
    const data = await this.get<ExpiredContract[]>(
      "contracts",
      `/v2/expired-instruments/option/contract?instrument_key=${encodeURIComponent(underlyingKey)}&expiry_date=${expiryDate}`,
    );
    return Array.isArray(data) ? data : [];
  }

  async getExpiredFutureContracts(
    underlyingKey: string,
    expiryDate: string,
  ): Promise<ExpiredContract[]> {
    const data = await this.get<ExpiredContract[]>(
      "contracts",
      `/v2/expired-instruments/future/contract?instrument_key=${encodeURIComponent(underlyingKey)}&expiry_date=${expiryDate}`,
    );
    return Array.isArray(data) ? data : [];
  }

  /** Candles for an expired contract key (NSE_FO|token|DD-MM-YYYY). */
  async getExpiredHistoricalCandles(
    expiredInstrumentKey: string,
    interval: ExpiredInterval,
    fromDate: string,
    toDate: string,
  ): Promise<HistoricalCandle[]> {
    const path = `/v2/expired-instruments/historical-candle/${encodeURIComponent(expiredInstrumentKey)}/${interval}/${toDate}/${fromDate}`;
    const data = await this.get<{ candles: unknown[][] }>(
      "expired-candles",
      path,
    );
    return (data.candles ?? []).map(parseCandle);
  }

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------

  private limiter(family: EndpointFamily): RateLimiter {
    const l = this.limiters.get(family);
    if (!l) throw new Error(`No limiter for endpoint family "${family}"`);
    return l;
  }

  private async get<T>(family: EndpointFamily, path: string): Promise<T> {
    const limiter = this.limiter(family);
    await limiter.acquire();
    const url = new URL(path, this.baseUrl);
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.accessToken}`,
      },
    });

    let payload: UpstoxEnvelope<T> | null = null;
    try {
      payload = (await response.json()) as UpstoxEnvelope<T>;
    } catch {
      /* non-JSON body (e.g. 502 HTML) */
    }

    if (!response.ok || payload?.status !== "success") {
      const code = payload?.errors?.[0]?.errorCode ?? null;
      const message =
        payload?.errors?.[0]?.message ??
        `${response.status} ${response.statusText}`;
      const retryAfter = response.headers.get("retry-after");
      const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : null;
      if (response.status === 429) {
        // Our accounting said we were within budget, so the server's window differs from ours.
        // Pause only this account's family; the others keep working.
        limiter.penalise(retryAfterMs ?? 60_000);
      }
      logger.warn("Upstox historical request failed", {
        account: this.alias,
        family,
        path: url.pathname,
        status: response.status,
        code,
        message,
      });
      throw new UpstoxApiError(
        `Upstox ${url.pathname}: ${message}`,
        response.status,
        code,
        retryAfterMs,
      );
    }
    return payload.data as T;
  }
}

function parseCandle(row: unknown[]): HistoricalCandle {
  const n = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : Number(v);
  return {
    ts: String(row[0]),
    open: n(row[1]),
    high: n(row[2]),
    low: n(row[3]),
    close: n(row[4]),
    volume: n(row[5]) || 0,
    oi:
      row.length > 6 && row[6] !== null && row[6] !== undefined
        ? n(row[6])
        : null,
  };
}

/** NSE_FO|47983|17-04-2025 → { instrumentKey: "NSE_FO|47983", expiry: "2025-04-17" } */
export function splitExpiredKey(
  expiredKey: string,
): { instrumentKey: string; expiry: string } | null {
  const m = /^(.+\|[^|]+)\|(\d{2})-(\d{2})-(\d{4})$/.exec(expiredKey);
  if (!m) return null;
  return { instrumentKey: m[1], expiry: `${m[4]}-${m[3]}-${m[2]}` };
}

/** Inverse of splitExpiredKey. */
export function buildExpiredKey(
  instrumentKey: string,
  expiryIso: string,
): string {
  const [y, m, d] = expiryIso.split("-");
  return `${instrumentKey}|${d}-${m}-${y}`;
}

/**
 * One client per Upstox account, exposing the same API. Each call is routed to the account that can
 * send soonest *for that endpoint family* — so N accounts give N times the throughput per family.
 *
 * Duplicates are impossible by construction: the pool only chooses which token sends a request;
 * the caller still decides what to request, one item at a time.
 */
export class UpstoxHistoricalClientPool {
  private cursor = 0;

  constructor(private readonly clients: UpstoxHistoricalClient[]) {
    if (clients.length === 0)
      throw new Error("UpstoxHistoricalClientPool needs at least one client");
  }

  get size(): number {
    return this.clients.length;
  }

  aliases(): string[] {
    return this.clients.map((c) => c.alias);
  }

  /** The client that can send in `family` soonest; ties rotate so load spreads evenly. */
  pick(family: EndpointFamily): UpstoxHistoricalClient {
    const n = this.clients.length;
    let best = this.clients[this.cursor % n];
    let bestWait = best.msUntilAllowed(family);
    for (let i = 1; i < n && bestWait > 0; i++) {
      const c = this.clients[(this.cursor + i) % n];
      const wait = c.msUntilAllowed(family);
      if (wait < bestWait) {
        best = c;
        bestWait = wait;
      }
    }
    this.cursor = (this.clients.indexOf(best) + 1) % n;
    return best;
  }

  getHistoricalCandles(
    ...args: Parameters<UpstoxHistoricalClient["getHistoricalCandles"]>
  ) {
    return this.pick("historical-candles").getHistoricalCandles(...args);
  }

  getExpiries(...args: Parameters<UpstoxHistoricalClient["getExpiries"]>) {
    return this.pick("expiries").getExpiries(...args);
  }

  getExpiredOptionContracts(
    ...args: Parameters<UpstoxHistoricalClient["getExpiredOptionContracts"]>
  ) {
    return this.pick("contracts").getExpiredOptionContracts(...args);
  }

  getExpiredFutureContracts(
    ...args: Parameters<UpstoxHistoricalClient["getExpiredFutureContracts"]>
  ) {
    return this.pick("contracts").getExpiredFutureContracts(...args);
  }

  getExpiredHistoricalCandles(
    ...args: Parameters<UpstoxHistoricalClient["getExpiredHistoricalCandles"]>
  ) {
    return this.pick("expired-candles").getExpiredHistoricalCandles(...args);
  }

  /** Requests in the last 30 min for `family`, summed across accounts. */
  usage(family: EndpointFamily): {
    lastThirtyMinutes: number;
    budgetThirtyMinutes: number;
    perAccount: Record<string, number>;
  } {
    const perAccount: Record<string, number> = {};
    let total = 0;
    for (const c of this.clients) {
      const used = c.usage(family).lastThirtyMinutes;
      perAccount[c.alias] = used;
      total += used;
    }
    return {
      lastThirtyMinutes: total,
      budgetThirtyMinutes: this.clients.length * 900,
      perAccount,
    };
  }
}
