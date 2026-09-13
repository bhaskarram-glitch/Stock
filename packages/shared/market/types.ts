/**
 * Shared market types. Single source of truth for interval/source enums (Bug #9).
 * Runtime code in apps/ must only `import type` from here — the @shared/* alias is a
 * tsconfig path, not a Node resolution rule.
 */
export type MarketProvider = "upstox";

export type MarketExchange =
  | "NSE"
  | "BSE"
  | "NFO"
  | "BFO"
  | "MCX"
  | (string & {});

/** Matches the `market_candles.interval` enum. */
export type CandleInterval = "1m" | "5m" | "15m" | "1h" | "1d";

/** Matches the `market_candles.source` enum (hist / hist_expired arrive with Phase 1 schema). */
export type CandleSource = "ws" | "api" | "hist" | "hist_expired";

export type InstrumentType =
  | "EQ"
  | "INDEX"
  | "FUT"
  | "CE"
  | "PE"
  | (string & {});

export type MarketTick = {
  instrumentId: string;
  provider: MarketProvider;
  providerInstrumentKey: string;
  symbol: string;
  exchange: MarketExchange;
  eventTs: string;
  ltp: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  prevClose: number | null;
  volume: number | null;
  bid?: number | null;
  ask?: number | null;
  marketStatus: "pre-market" | "open" | "post-market" | "closed" | null;
  oi?: number | null;
};

export type Candle = {
  instrumentId: string;
  instrumentKey: string;
  interval: CandleInterval;
  bucketStart: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi?: number | null;
  source: CandleSource;
};
