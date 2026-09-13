import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { UpstoxClient, DEFAULT_UPSTOX_BASE_URL } from "./client.js";

vi.mock("../../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe("UpstoxClient", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should fetch quote using a direct key match", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: "success",
        data: {
          "NSE_EQ|TEST": {
            instrument_token: "NSE_EQ|TEST",
            symbol: "TEST",
            last_price: 120,
            volume: 50,
          },
        },
      }),
    });

    const client = new UpstoxClient("token");
    const quote = await client.fetchQuote("NSE_EQ|TEST");

    expect(quote.symbol).toBe("TEST");
    expect(quote.last_price).toBe(120);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      DEFAULT_UPSTOX_BASE_URL,
    );
  });

  it("should fetch quote using instrument_token fallback", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: "success",
        data: {
          SOME_OTHER_KEY: {
            instrument_token: "NSE_EQ|TEST",
            symbol: "FALLBACK",
            last_price: 112,
            volume: 15,
          },
        },
      }),
    });

    const client = new UpstoxClient("token", "https://api.upstox.com");
    const quote = await client.fetchQuote("NSE_EQ|TEST");

    expect(quote.symbol).toBe("FALLBACK");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("should attempt exactly maxRetries times then throw", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ status: "error", data: {} }),
    });

    const client = new UpstoxClient("token", "https://api.upstox.com", {
      maxRetries: 3,
      baseDelayMs: 10,
    });
    const quotePromise = client.fetchQuote("NSE_EQ|TEST");
    const rejection = expect(quotePromise).rejects.toThrow(
      "Upstox API returned non-success status: error",
    );

    await vi.runAllTimersAsync();
    await rejection;

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("should succeed on a later attempt without exhausting retries", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "success",
          data: {
            "NSE_EQ|TEST": {
              instrument_token: "NSE_EQ|TEST",
              symbol: "TEST",
              last_price: 1,
            },
          },
        }),
      });

    const client = new UpstoxClient("token", "https://api.upstox.com", {
      maxRetries: 3,
      baseDelayMs: 10,
    });
    const quotePromise = client.fetchQuote("NSE_EQ|TEST");
    await vi.runAllTimersAsync();

    await expect(quotePromise).resolves.toMatchObject({ symbol: "TEST" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("should authorize the V3 market data feed and return the redirect URI", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: "success",
        data: {
          authorized_redirect_uri:
            "wss://stream.upstox.com/feed/market-data?code=abc123",
        },
      }),
    });

    const client = new UpstoxClient("token", "https://api.upstox.com");
    const authorizedUrl = await client.authorizeMarketDataFeed();

    expect(authorizedUrl).toBe(
      "wss://stream.upstox.com/feed/market-data?code=abc123",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/v3/feed/market-data-feed/authorize", "https://api.upstox.com"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/json",
          Authorization: "Bearer token",
        }),
      }),
    );
  });
});
