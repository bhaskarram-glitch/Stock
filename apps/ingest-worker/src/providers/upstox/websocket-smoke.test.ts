import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
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
}

function encodeFeedResponse(payload: UpstoxV3FeedResponse): Buffer {
  const message = feedResponseType.fromObject(payload as never);
  return Buffer.from(feedResponseType.encode(message).finish());
}

describe("websocket smoke", () => {
  it("should complete the authorize, connect, subscribe, decode, unsubscribe, and disconnect flow using hardcoded data", async () => {
    const authorizeMarketDataFeed = vi.fn().mockResolvedValue(
      "wss://stream.upstox.com/feed/market-data?code=smoke",
    );
    const socket = new FakeSocket();
    const onConnect = vi.fn();
    const onDisconnect = vi.fn();
    const onError = vi.fn();
    const onTick = vi.fn();

    const client = new UpstoxWebSocketClient({
      upstoxClient: { authorizeMarketDataFeed },
      onConnect,
      onDisconnect,
      onError,
      onTick,
      socketFactory: (url) => {
        expect(url).toBe(
          "wss://stream.upstox.com/feed/market-data?code=smoke",
        );
        return socket;
      },
    });

    client.connect();
    await new Promise((resolve) => setImmediate(resolve));

    expect(authorizeMarketDataFeed).toHaveBeenCalledTimes(1);
    expect(client.isWebSocketConnected()).toBe(false);

    socket.open();

    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(client.isWebSocketConnected()).toBe(true);

    client.subscribe(["NSE_EQ|INE002A01018", "NSE_EQ|INE009A01021"]);

    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0].toString("utf8"))).toMatchObject({
      method: "sub",
      data: {
        instrumentKeys: ["NSE_EQ|INE002A01018", "NSE_EQ|INE009A01021"],
        mode: "full",
      },
    });

    const now = Date.now();
    socket.receiveBinary(
      encodeFeedResponse({
        type: "live_feed",
        currentTs: now,
        feeds: {
          "NSE_EQ|INE002A01018": {
            fullFeed: {
              marketFF: {
                ltpc: {
                  ltp: 2945.2,
                  ltt: now,
                  ltq: 75,
                  cp: 2910.5,
                },
                marketOHLC: {
                  ohlc: [
                    {
                      interval: "I1",
                      open: 2920,
                      high: 2950,
                      low: 2912.4,
                      close: 2945.2,
                      vol: 1250000,
                      ts: now,
                    },
                  ],
                },
                vtt: 1250000,
                oi: 2500,
                tbq: 1500,
                tsq: 1400,
              },
            },
            requestMode: "full_d5",
          },
        },
      }),
    );

    expect(onTick).toHaveBeenCalledWith(
      expect.objectContaining({
        instrument_token: "NSE_EQ|INE002A01018",
        last_price: 2945.2,
        volume: 1250000,
        prev_close: 2910.5,
        request_mode: "full_d5",
        market_data: expect.objectContaining({
          oi: 2500,
          total_buy_qty: 1500,
          total_sell_qty: 1400,
        }),
      }),
    );
    expect(onError).not.toHaveBeenCalled();

    client.unsubscribe(["NSE_EQ|INE009A01021"]);

    expect(socket.sent).toHaveLength(2);
    expect(JSON.parse(socket.sent[1].toString("utf8"))).toMatchObject({
      method: "unsub",
      data: {
        instrumentKeys: ["NSE_EQ|INE009A01021"],
      },
    });

    client.disconnect();

    expect(onDisconnect).toHaveBeenCalled();
    expect(client.isWebSocketConnected()).toBe(false);
  });
});
