/**
 * Row shapes the worker writes. Hand-maintained to match infra/db/migrations — update both together.
 * (Replaces the Supabase-generated database.types.ts.)
 */
import type { CandleInterval } from "@shared/market/types.js";

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type DataSource = "ws" | "api" | "hist" | "hist_expired";
export type WsStatus = "online" | "offline" | "degraded";

/** Insert shape for `instruments` (id / timestamps come from DB defaults). */
export interface InstrumentInsert {
  provider: string;
  provider_instrument_key: string;
  exchange: string;
  segment: string;
  trading_symbol: string;
  name: string;
  isin?: string | null;
  instrument_type?: string | null;
  exchange_token?: string | null;
  tick_size?: number | null;
  lot_size?: number | null;
  underlying_key?: string | null;
  underlying_symbol?: string | null;
  expiry?: string | null; // YYYY-MM-DD
  strike?: number | null;
  option_type?: "CE" | "PE" | string | null;
  weekly?: boolean | null;
  is_expired?: boolean;
  is_active?: boolean | null;
  metadata?: Json | null;
  [column: string]: unknown;
}

/** Insert shape for `market_candles`. */
export interface CandleInsert {
  instrument_id: string;
  instrument_key: string;
  interval: CandleInterval;
  bucket_start: string; // ISO timestamp
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
  oi?: number | null;
  /** Provider's original close when `close` was corrected (migration 0003); null = as reported. */
  close_reported?: number | null;
  source?: DataSource;
  [column: string]: unknown;
}
