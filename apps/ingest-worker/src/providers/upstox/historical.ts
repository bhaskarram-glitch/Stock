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
 */
import { logger } from "../../lib/logger.js";
import { DEFAULT_UPSTOX_BASE_URL } from "./client.js";

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

export interface UpstoxHistoricalClientOptions {
  baseUrl?: string;
  /** Minimum spacing between requests in ms (client-side throttle). Default 60ms (~16 req/s). */
  minIntervalMs?: number;
}

export class UpstoxHistoricalClient {
  private readonly baseUrl: string;
  private readonly minIntervalMs: number;
  private lastRequestAt = 0;

  constructor(
    private readonly accessToken: string,
    options: UpstoxHistoricalClientOptions = {},
  ) {
    this.baseUrl = options.baseUrl ?? DEFAULT_UPSTOX_BASE_URL;
    this.minIntervalMs = options.minIntervalMs ?? 60;
  }

  // ---------------------------------------------------------------------------
  // Public API
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
    const data = await this.get<{ candles: unknown[][] }>(path);
    return (data.candles ?? []).map(parseCandle);
  }

  /** Expiry dates for an underlying — Upstox only returns roughly the last six months. */
  async getExpiries(underlyingKey: string): Promise<string[]> {
    const data = await this.get<string[]>(
      `/v2/expired-instruments/expiries?instrument_key=${encodeURIComponent(underlyingKey)}`,
    );
    return Array.isArray(data) ? data : [];
  }

  async getExpiredOptionContracts(
    underlyingKey: string,
    expiryDate: string,
  ): Promise<ExpiredContract[]> {
    const data = await this.get<ExpiredContract[]>(
      `/v2/expired-instruments/option/contract?instrument_key=${encodeURIComponent(underlyingKey)}&expiry_date=${expiryDate}`,
    );
    return Array.isArray(data) ? data : [];
  }

  async getExpiredFutureContracts(
    underlyingKey: string,
    expiryDate: string,
  ): Promise<ExpiredContract[]> {
    const data = await this.get<ExpiredContract[]>(
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
    const data = await this.get<{ candles: unknown[][] }>(path);
    return (data.candles ?? []).map(parseCandle);
  }

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }

  private async get<T>(path: string): Promise<T> {
    await this.throttle();
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
      logger.warn("Upstox historical request failed", {
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
