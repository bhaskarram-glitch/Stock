import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import protobuf from "protobufjs";
import {
  MARKET_DATA_FEED_V3_PROTO,
  type UpstoxV3FeedResponse,
} from "./market-data-feed-v3.js";
import {
  UpstoxWebSocketClient,
  type UpstoxWebSocketLike,
} from "./websocket-client.js";

const { parse } = protobuf;

const feedResponseType = parse(MARKET_DATA_FEED_V3_PROTO).root.lookupType(
  "com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse",
);

class FakeSocket extends EventEmitter implements UpstoxWebSocketLike {
  readyState = 0;
  readonly sent: Buffer[] = [];
  readonly ping = vi.fn();

  send(data: Buffer, callback?: (error?: Error) => void): void {
    this.sent.push(Buffer.from(data));
    callback?.();
  }

  close(code = 1000, reason = "Client disconnect"): void {
    this.readyState = 2;
    this.emit("close", code, Buffer.from(reason));
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  receiveBinary(data: Buffer): void {
    this.emit("message", data, true);
  }

  serverClose(code = 1006, reason = "abnormal-close"): void {
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }
}

function encodeFeedResponse(payload: UpstoxV3FeedResponse): Buffer {
  const message = feedResponseType.fromObject(payload as never);
  return Buffer.from(feedResponseType.encode(message).finish());
}

describe("UpstoxWebSocketClient", () => {
  const authorizeMarketDataFeed = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should authorize before opening the websocket and send binary subscribe frames", async () => {
    const sockets: FakeSocket[] = [];
    authorizeMarketDataFeed.mockResolvedValueOnce(
      "wss://stream.upstox.com/feed/market-data?code=abc123",
    );

    const onConnect = vi.fn();
    const client = new UpstoxWebSocketClient({
      upstoxClient: { authorizeMarketDataFeed },
      onConnect,
      socketFactory: (url) => {
        expect(url).toBe(
          "wss://stream.upstox.com/feed/market-data?code=abc123",
        );
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    client.connect();
    await new Promise((resolve) => setImmediate(resolve));

    expect(authorizeMarketDataFeed).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);

    sockets[0].open();
    expect(onConnect).toHaveBeenCalledTimes(1);

    client.subscribe(["NSE_EQ|TEST"]);

    expect(sockets[0].sent).toHaveLength(1);
    const request = JSON.parse(sockets[0].sent[0].toString("utf8"));
    expect(request).toMatchObject({
      method: "sub",
      data: {
        instrumentKeys: ["NSE_EQ|TEST"],
        mode: "full",
      },
    });
    expect(typeof request.guid).toBe("string");
  });

  it("should decode protobuf market data responses into normalized ticks", async () => {
    const sockets: FakeSocket[] = [];
    authorizeMarketDataFeed.mockResolvedValueOnce(
      "wss://stream.upstox.com/feed/market-data?code=def456",
    );

    const onTick = vi.fn();
    const client = new UpstoxWebSocketClient({
      upstoxClient: { authorizeMarketDataFeed },
      onTick,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    client.connect();
    await new Promise((resolve) => setImmediate(resolve));
    sockets[0].open();

    const now = Date.now();
    sockets[0].receiveBinary(
      encodeFeedResponse({
        type: "live_feed",
        currentTs: now,
        feeds: {
          "NSE_EQ|TEST": {
            fullFeed: {
              marketFF: {
                ltpc: {
                  ltp: 123.45,
                  ltt: now,
                  ltq: 15,
                  cp: 122.1,
                },
                marketOHLC: {
                  ohlc: [
                    {
                      interval: "I1",
                      open: 121,
                      high: 124,
                      low: 120,
                      close: 123.45,
                      vol: 500,
                      ts: now,
                    },
                  ],
                },
                vtt: 500,
                oi: 42,
                tbq: 1000,
                tsq: 900,
              },
            },
            requestMode: "full_d5",
          },
        },
      }),
    );

    expect(onTick).toHaveBeenCalledWith(
      expect.objectContaining({
        instrument_token: "NSE_EQ|TEST",
        last_price: 123.45,
        volume: 500,
        prev_close: 122.1,
        request_mode: "full_d5",
        market_data: expect.objectContaining({
          oi: 42,
          total_buy_qty: 1000,
          total_sell_qty: 900,
        }),
      }),
    );
  });

  it("should re-authorize and reconnect after an abnormal close", async () => {
    vi.useFakeTimers();

    const sockets: FakeSocket[] = [];
    authorizeMarketDataFeed
      .mockResolvedValueOnce("wss://stream.upstox.com/feed/market-data?code=1")
      .mockResolvedValueOnce("wss://stream.upstox.com/feed/market-data?code=2");

    const client = new UpstoxWebSocketClient({
      upstoxClient: { authorizeMarketDataFeed },
      reconnectDelay: 10,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    client.connect();
    await Promise.resolve();
    await Promise.resolve();

    sockets[0].open();
    sockets[0].serverClose(1006, "upstream-reset");

    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();
    await Promise.resolve();

    expect(authorizeMarketDataFeed).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(2);
  });
});
