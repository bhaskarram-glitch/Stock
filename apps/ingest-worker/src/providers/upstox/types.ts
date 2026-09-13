export type UpstoxQuote = {
  symbol?: string;
  last_price?: number;
  volume?: number;
  last_trade_time?: string;
  timestamp?: string;
  instrument_token?: string;
  average_price?: number;
  oi?: number;
  net_change?: number;
  total_buy_quantity?: number;
  total_sell_quantity?: number;
  depth?: {
    buy?: Array<{ price?: number; quantity?: number; orders?: number }>;
    sell?: Array<{ price?: number; quantity?: number; orders?: number }>;
  };
  ohlc?: {
    open?: number;
    high?: number;
    low?: number;
    close?: number;
  };
};

export type UpstoxQuoteResponse = {
  status?: string;
  data?: Record<string, UpstoxQuote>;
};

export type UpstoxMarketDataFeedAuthorizeResponse = {
  status?: string;
  data?: {
    authorized_redirect_uri?: string;
  };
};

export type UpstoxWSTick = {
  instrument_token: string;
  last_price?: number;
  volume?: number;
  timestamp?: string;
  prev_close?: number;
  bid?: number;
  ask?: number;
  request_mode?: string;
  feed_type?: string;
  market_data?: {
    ltpc?: number;
    ltt?: string;
    vol_traded_today?: number;
    total_buy_qty?: number;
    total_sell_qty?: number;
    oi?: number;
  };
  ohlc?: {
    open?: number;
    high?: number;
    low?: number;
    close?: number;
  };
  raw?: unknown;
};
