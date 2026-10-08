import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  UpstoxHistoricalClient,
  UpstoxHistoricalClientPool,
  splitExpiredKey,
  buildExpiredKey,
} from "./historical.js";
import { RateLimiter } from "./rate-limiter.js";

vi.mock("../../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const fetchMock = vi.fn();

function ok(data: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    json: async () => ({ status: "success", data }),
  };
}
function tooMany() {
  return {
    ok: false,
    status: 429,
    statusText: "Too Many Requests",
    headers: new Headers(),
    json: async () => ({
      status: "error",
      errors: [{ errorCode: "UDAPI10005", message: "Too Many Request Sent" }],
    }),
  };
}
/** Limiter with a tiny 30-min budget and a frozen clock, so "exhausted" is instant and deterministic. */
const tinyLimiter = (perThirtyMinutes: number) => () =>
  new RateLimiter({
    limits: { perSecond: 1000, perMinute: 1000, perThirtyMinutes },
    safety: 1,
    now: () => 0,
    sleep: async () => {
      throw new Error("would block");
    },
  });

function tokenOf(call: unknown[]): string {
  return (
    (call[1] as { headers: Record<string, string> }).headers.Authorization ?? ""
  ).replace("Bearer ", "");
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("UpstoxHistoricalClientPool", () => {
  it("spreads calls in one family evenly across accounts", async () => {
    fetchMock.mockImplementation(async () => ok({ candles: [] }));
    const pool = new UpstoxHistoricalClientPool(
      ["t1", "t2", "t3"].map(
        (t, i) => new UpstoxHistoricalClient(t, { alias: `a${i + 1}` }),
      ),
    );
    for (let i = 0; i < 6; i++)
      await pool.getExpiredHistoricalCandles(
        "NSE_FO|1|03-10-2024",
        "day",
        "2024-01-01",
        "2024-10-03",
      );
    const tokens = fetchMock.mock.calls.map(tokenOf);
    expect(tokens.filter((t) => t === "t1")).toHaveLength(2);
    expect(tokens.filter((t) => t === "t2")).toHaveLength(2);
    expect(tokens.filter((t) => t === "t3")).toHaveLength(2);
  });

  it("routes around an account whose family budget is spent", async () => {
    fetchMock.mockImplementation(async () => ok({ candles: [] }));
    const pool = new UpstoxHistoricalClientPool([
      new UpstoxHistoricalClient("t1", {
        alias: "a1",
        limiterFactory: tinyLimiter(1),
      }),
      new UpstoxHistoricalClient("t2", {
        alias: "a2",
        limiterFactory: tinyLimiter(100),
      }),
    ]);
    for (let i = 0; i < 5; i++)
      await pool.getExpiredHistoricalCandles(
        "K",
        "day",
        "2024-01-01",
        "2024-10-03",
      );
    const tokens = fetchMock.mock.calls.map(tokenOf);
    expect(tokens.filter((t) => t === "t1")).toHaveLength(1); // spent after one
    expect(tokens.filter((t) => t === "t2")).toHaveLength(4);
  });

  it("keeps endpoint families independent — exhausting candles does not block listing", async () => {
    fetchMock.mockImplementation(async (url: URL) =>
      String(url).includes("expiries")
        ? ok(["2024-10-03"])
        : ok({ candles: [] }),
    );
    const client = new UpstoxHistoricalClient("t1", {
      alias: "a1",
      limiterFactory: tinyLimiter(1),
    });
    const pool = new UpstoxHistoricalClientPool([client]);
    await pool.getExpiredHistoricalCandles(
      "K",
      "day",
      "2024-01-01",
      "2024-10-03",
    );
    expect(client.msUntilAllowed("expired-candles")).toBeGreaterThan(0);
    expect(client.msUntilAllowed("expiries")).toBe(0);
    await expect(pool.getExpiries("NSE_INDEX|Nifty 50")).resolves.toEqual([
      "2024-10-03",
    ]);
  });

  it("penalises only the family that got a 429", async () => {
    fetchMock.mockResolvedValueOnce(tooMany());
    const client = new UpstoxHistoricalClient("t1", { alias: "a1" });
    await expect(
      client.getExpiredHistoricalCandles(
        "K",
        "day",
        "2024-01-01",
        "2024-10-03",
      ),
    ).rejects.toMatchObject({ status: 429 });
    expect(client.msUntilAllowed("expired-candles")).toBeGreaterThan(50_000);
    expect(client.msUntilAllowed("contracts")).toBe(0);
    expect(client.msUntilAllowed("historical-candles")).toBe(0);
  });

  it("reports usage per family across accounts", async () => {
    fetchMock.mockImplementation(async () => ok({ candles: [] }));
    const pool = new UpstoxHistoricalClientPool([
      new UpstoxHistoricalClient("t1", { alias: "a1" }),
      new UpstoxHistoricalClient("t2", { alias: "a2" }),
    ]);
    for (let i = 0; i < 4; i++)
      await pool.getExpiredHistoricalCandles(
        "K",
        "day",
        "2024-01-01",
        "2024-10-03",
      );
    const u = pool.usage("expired-candles");
    expect(u.lastThirtyMinutes).toBe(4);
    expect(u.perAccount).toEqual({ a1: 2, a2: 2 });
    expect(pool.usage("contracts").lastThirtyMinutes).toBe(0);
  });

  it("requires at least one client", () => {
    expect(() => new UpstoxHistoricalClientPool([])).toThrow();
  });
});

describe("expired keys", () => {
  it("round-trips", () => {
    expect(splitExpiredKey("NSE_FO|47983|17-04-2025")).toEqual({
      instrumentKey: "NSE_FO|47983",
      expiry: "2025-04-17",
    });
    expect(buildExpiredKey("NSE_FO|47983", "2025-04-17")).toBe(
      "NSE_FO|47983|17-04-2025",
    );
    expect(splitExpiredKey("NSE_FO|47983")).toBeNull();
  });
});
