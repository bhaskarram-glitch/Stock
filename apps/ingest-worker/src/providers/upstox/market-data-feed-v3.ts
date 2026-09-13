import { randomUUID } from "node:crypto";
import protobuf from "protobufjs";
import type { UpstoxWSTick } from "./types.js";

export type UpstoxV3FeedMode = "ltpc" | "full" | "option_greeks" | "full_d30";
export type UpstoxV3FeedMethod = "sub" | "change_mode" | "unsub";
export type UpstoxV3FeedRequest = {
  guid: string;
  method: UpstoxV3FeedMethod;
  data: {
    instrumentKeys: string[];
    mode?: UpstoxV3FeedMode;
  };
};

type ProtoLTPC = { ltp?: number; ltt?: number; ltq?: number; cp?: number };
type ProtoOHLC = {
  interval?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  vol?: number;
  ts?: number;
};
type ProtoMarketOHLC = { ohlc?: ProtoOHLC[] };
type ProtoQuote = {
  bidQ?: number;
  bidP?: number;
  askQ?: number;
  askP?: number;
};
type ProtoMarketLevel = { bidAskQuote?: ProtoQuote[] };
type ProtoOptionGreeks = {
  delta?: number;
  theta?: number;
  gamma?: number;
  vega?: number;
  rho?: number;
};
type ProtoMarketFullFeed = {
  ltpc?: ProtoLTPC;
  marketLevel?: ProtoMarketLevel;
  optionGreeks?: ProtoOptionGreeks;
  marketOHLC?: ProtoMarketOHLC;
  atp?: number;
  vtt?: number;
  oi?: number;
  iv?: number;
  tbq?: number;
  tsq?: number;
};
type ProtoIndexFullFeed = { ltpc?: ProtoLTPC; marketOHLC?: ProtoMarketOHLC };
type ProtoFullFeed = {
  marketFF?: ProtoMarketFullFeed;
  indexFF?: ProtoIndexFullFeed;
};
type ProtoFirstLevelWithGreeks = {
  ltpc?: ProtoLTPC;
  firstDepth?: ProtoQuote;
  optionGreeks?: ProtoOptionGreeks;
  vtt?: number;
  oi?: number;
  iv?: number;
};
type ProtoFeed = {
  ltpc?: ProtoLTPC;
  fullFeed?: ProtoFullFeed;
  firstLevelWithGreeks?: ProtoFirstLevelWithGreeks;
  requestMode?: string;
};
type ProtoMarketInfo = { segmentStatus?: Record<string, string> };
export type UpstoxV3FeedResponse = {
  type?: string;
  feeds?: Record<string, ProtoFeed>;
  currentTs?: number;
  marketInfo?: ProtoMarketInfo;
};

const MARKET_DATA_FEED_V3_PROTO = `
syntax = "proto3";
package com.upstox.marketdatafeederv3udapi.rpc.proto;
message LTPC {
  double ltp = 1;
  int64 ltt = 2;
  int64 ltq = 3;
  double cp = 4;
}
message MarketLevel {
  repeated Quote bidAskQuote = 1;
}
message Quote {
  int64 bidQ = 1;
  double bidP = 2;
  int64 askQ = 3;
  double askP = 4;
}
message OptionGreeks {
  double delta = 1;
  double theta = 2;
  double gamma = 3;
  double vega = 4;
  double rho = 5;
}
message OHLC {
  string interval = 1;
  double open = 2;
  double high = 3;
  double low = 4;
  double close = 5;
  int64 vol = 6;
  int64 ts = 7;
}
message MarketOHLC {
  repeated OHLC ohlc = 1;
}
message MarketFullFeed {
  LTPC ltpc = 1;
  MarketLevel marketLevel = 2;
  OptionGreeks optionGreeks = 3;
  MarketOHLC marketOHLC = 4;
  double atp = 5;
  int64 vtt = 6;
  double oi = 7;
  double iv = 8;
  double tbq = 9;
  double tsq = 10;
}
message IndexFullFeed {
  LTPC ltpc = 1;
  MarketOHLC marketOHLC = 2;
}
message FullFeed {
  oneof FullFeedUnion {
    MarketFullFeed marketFF = 1;
    IndexFullFeed indexFF = 2;
  }
}
message FirstLevelWithGreeks {
  LTPC ltpc = 1;
  Quote firstDepth = 2;
  OptionGreeks optionGreeks = 3;
  int64 vtt = 4;
  double oi = 5;
  double iv = 6;
}
enum RequestMode {
  ltpc = 0;
  full_d5 = 1;
  option_greeks = 2;
  full_d30 = 3;
}
enum Type {
  initial_feed = 0;
  live_feed = 1;
  market_info = 2;
}
message Feed {
  oneof FeedUnion {
    LTPC ltpc = 1;
    FullFeed fullFeed = 2;
    FirstLevelWithGreeks firstLevelWithGreeks = 3;
  }
  RequestMode requestMode = 4;
}
enum MarketStatus {
  PRE_OPEN_START = 0;
  PRE_OPEN_END = 1;
  NORMAL_OPEN = 2;
  NORMAL_CLOSE = 3;
  CLOSING_START = 4;
  CLOSING_END = 5;
}
message MarketInfo {
  map<string, MarketStatus> segmentStatus = 1;
}
message FeedResponse {
  Type type = 1;
  map<string, Feed> feeds = 2;
  int64 currentTs = 3;
  MarketInfo marketInfo = 4;
}
`;

const { parse } = protobuf;
const feedResponseType = parse(MARKET_DATA_FEED_V3_PROTO).root.lookupType(
  "com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse",
);

function asNumber(value: number | null | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function toIsoTimestamp(timestampMs?: number): string | undefined {
  if (!timestampMs || !Number.isFinite(timestampMs)) return undefined;
  return new Date(timestampMs).toISOString();
}

function pickDepthQuote(feed: ProtoFeed): ProtoQuote | undefined {
  return (
    feed.firstLevelWithGreeks?.firstDepth ??
    feed.fullFeed?.marketFF?.marketLevel?.bidAskQuote?.[0]
  );
}

function pickOHLC(feed: ProtoFeed): ProtoOHLC | undefined {
  const entries =
    feed.fullFeed?.marketFF?.marketOHLC?.ohlc ??
    feed.fullFeed?.indexFF?.marketOHLC?.ohlc ??
    [];
  return (
    entries.find((entry) => entry.interval === "I1") ??
    entries.find((entry) => entry.interval === "1d") ??
    entries[0]
  );
}

function pickLTPC(feed: ProtoFeed): ProtoLTPC | undefined {
  return (
    feed.ltpc ??
    feed.fullFeed?.marketFF?.ltpc ??
    feed.fullFeed?.indexFF?.ltpc ??
    feed.firstLevelWithGreeks?.ltpc
  );
}

/**
 * `volume` on the tick is ALWAYS the cumulative volume traded today (vtt), or
 * undefined when the feed does not carry it (ltpc mode, indexes). It is never a
 * per-bucket or per-trade figure; consumers must take deltas (CumulativeVolumeTracker).
 */
function normalizeFeedTick(
  instrumentKey: string,
  feed: ProtoFeed,
  feedType?: string,
  currentTs?: number,
): UpstoxWSTick | null {
  const ltpc = pickLTPC(feed);
  const ohlc = pickOHLC(feed);
  const depth = pickDepthQuote(feed);
  const marketFullFeed = feed.fullFeed?.marketFF;

  const timestamp =
    toIsoTimestamp(asNumber(ltpc?.ltt) ?? asNumber(ohlc?.ts) ?? currentTs) ??
    new Date().toISOString();

  const lastPrice = asNumber(ltpc?.ltp) ?? asNumber(ohlc?.close);
  if (lastPrice === undefined) return null;

  const cumulativeVolume =
    asNumber(marketFullFeed?.vtt) ?? asNumber(feed.firstLevelWithGreeks?.vtt);

  return {
    instrument_token: instrumentKey,
    last_price: lastPrice,
    volume: cumulativeVolume,
    timestamp,
    prev_close: asNumber(ltpc?.cp),
    bid: asNumber(depth?.bidP),
    ask: asNumber(depth?.askP),
    request_mode: feed.requestMode,
    feed_type: feedType,
    market_data: {
      ltpc: lastPrice,
      ltt: toIsoTimestamp(asNumber(ltpc?.ltt) ?? currentTs),
      vol_traded_today: cumulativeVolume,
      total_buy_qty: asNumber(marketFullFeed?.tbq),
      total_sell_qty: asNumber(marketFullFeed?.tsq),
      oi:
        asNumber(marketFullFeed?.oi) ?? asNumber(feed.firstLevelWithGreeks?.oi),
    },
    ohlc: ohlc
      ? {
          open: asNumber(ohlc.open),
          high: asNumber(ohlc.high),
          low: asNumber(ohlc.low),
          close: asNumber(ohlc.close),
        }
      : undefined,
  };
}

export function buildMarketDataFeedRequest(
  method: UpstoxV3FeedMethod,
  instrumentKeys: string[],
  mode?: UpstoxV3FeedMode,
): Buffer {
  const request: UpstoxV3FeedRequest = {
    guid: randomUUID(),
    method,
    data: { instrumentKeys, ...(mode ? { mode } : {}) },
  };
  return Buffer.from(JSON.stringify(request), "utf8");
}

export function decodeMarketDataFeedResponse(
  payload: Buffer,
): UpstoxV3FeedResponse {
  const decoded = feedResponseType.decode(payload);
  return feedResponseType.toObject(decoded, {
    longs: Number,
    enums: String,
    defaults: false,
    oneofs: false,
  }) as UpstoxV3FeedResponse;
}

export function extractTicksFromMarketDataFeedResponse(
  response: UpstoxV3FeedResponse,
): UpstoxWSTick[] {
  return Object.entries(response.feeds ?? {})
    .map(([instrumentKey, feed]) =>
      normalizeFeedTick(
        instrumentKey,
        feed,
        response.type,
        asNumber(response.currentTs),
      ),
    )
    .filter((tick): tick is UpstoxWSTick => tick !== null);
}

export function maskAuthorizedRedirectUri(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "[invalid-authorized-redirect-uri]";
  }
}

export { MARKET_DATA_FEED_V3_PROTO };
