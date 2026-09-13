export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      instruments: {
        Row: {
          id: string;
          exchange: string;
          segment: string;
          name: string;
          isin: string | null;
          provider: string;
          provider_instrument_key: string;
          tick_size: number | null;
          lot_size: number | null;
          is_active: boolean | null;
          metadata: Json | null;
          trading_symbol: string;
          instrument_type: string | null;
          exchange_token: string | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          exchange: string;
          segment: string;
          name: string;
          isin?: string | null;
          provider: string;
          provider_instrument_key: string;
          tick_size?: number | null;
          lot_size?: number | null;
          is_active?: boolean | null;
          metadata?: Json | null;
          trading_symbol: string;
          instrument_type?: string | null;
          exchange_token?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          id?: string;
          exchange?: string;
          segment?: string;
          name?: string;
          isin?: string | null;
          provider?: string;
          provider_instrument_key?: string;
          tick_size?: number | null;
          lot_size?: number | null;
          is_active?: boolean | null;
          metadata?: Json | null;
          trading_symbol?: string;
          instrument_type?: string | null;
          exchange_token?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      market_candles: {
        Row: {
          id: string;
          instrument_id: string;
          instrument_key: string;
          interval: Database["public"]["Enums"]["candle_interval"];
          bucket_start: string;
          open: number;
          high: number;
          low: number;
          close: number;
          volume: number | null;
          source: Database["public"]["Enums"]["data_source"];
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          instrument_id: string;
          instrument_key: string;
          interval: Database["public"]["Enums"]["candle_interval"];
          bucket_start: string;
          open: number;
          high: number;
          low: number;
          close: number;
          volume?: number | null;
          source?: Database["public"]["Enums"]["data_source"];
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          instrument_id?: string;
          instrument_key?: string;
          interval?: Database["public"]["Enums"]["candle_interval"];
          bucket_start?: string;
          open?: number;
          high?: number;
          low?: number;
          close?: number;
          volume?: number | null;
          source?: Database["public"]["Enums"]["data_source"];
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "market_candles_instrument_id_fkey";
            columns: ["instrument_id"];
            isOneToOne: false;
            referencedRelation: "instruments";
            referencedColumns: ["id"];
          },
        ];
      };
      market_snapshots: {
        Row: {
          instrument_id: string;
          as_of: string;
          open: number | null;
          high: number | null;
          low: number | null;
          close: number | null;
          ltp: number | null;
          prev_close: number | null;
          volume: number | null;
          change: number | null;
          change_pct: number | null;
          updated_at: string;
        };
        Insert: {
          instrument_id: string;
          as_of: string;
          open?: number | null;
          high?: number | null;
          low?: number | null;
          close?: number | null;
          ltp?: number | null;
          prev_close?: number | null;
          volume?: number | null;
          change?: number | null;
          change_pct?: number | null;
          updated_at?: string;
        };
        Update: {
          instrument_id?: string;
          as_of?: string;
          open?: number | null;
          high?: number | null;
          low?: number | null;
          close?: number | null;
          ltp?: number | null;
          prev_close?: number | null;
          volume?: number | null;
          change?: number | null;
          change_pct?: number | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      instrument_status: {
        Row: {
          instrument_key: string;
          ws_status: Database["public"]["Enums"]["ws_status"];
          last_ws_ts: string | null;
          last_api_ts: string | null;
          heartbeat_ts: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          instrument_key: string;
          ws_status?: Database["public"]["Enums"]["ws_status"];
          last_ws_ts?: string | null;
          last_api_ts?: string | null;
          heartbeat_ts?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          instrument_key?: string;
          ws_status?: Database["public"]["Enums"]["ws_status"];
          last_ws_ts?: string | null;
          last_api_ts?: string | null;
          heartbeat_ts?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      ws_failures: {
        Row: {
          id: string;
          instrument_key: string;
          failure_type: string;
          failure_ts: string;
          error_message: string | null;
          recovered_ts: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          instrument_key: string;
          failure_type: string;
          failure_ts?: string;
          error_message?: string | null;
          recovered_ts?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          instrument_key?: string;
          failure_type?: string;
          failure_ts?: string;
          error_message?: string | null;
          recovered_ts?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: {
      candle_interval: "1m" | "5m" | "15m" | "1h" | "1d";
      data_source: "ws" | "api";
      ws_status: "online" | "offline" | "degraded";
    };
    CompositeTypes: Record<string, never>;
  };
};
