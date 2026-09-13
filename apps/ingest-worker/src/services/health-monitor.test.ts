import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockUpstoxClient = {
  fetchQuote: vi.fn(async (instrumentKey: string) => ({
    instrument_token: instrumentKey,
    symbol: "TEST",
    last_price: 123,
    volume: 1000,
  })),
};

const mockUpdateEq = vi.fn(async () => ({ error: null }));
const mockUpdate = vi.fn(() => ({ eq: mockUpdateEq }));
const mockUpsert = vi.fn(async (_rows: unknown, _opts?: unknown) => ({
  error: null,
}));
const mockFrom = vi.fn(() => ({ update: mockUpdate, upsert: mockUpsert }));
const mockSupabase = { from: mockFrom } as any;

import { HealthMonitor } from "./health-monitor.js";

describe("HealthMonitor", () => {
  let healthMonitor: HealthMonitor;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: false });

    healthMonitor = new HealthMonitor({
      supabase: mockSupabase,
      upstoxClient: mockUpstoxClient as any,
      healthCheckInterval: 1000,
      apiFallbackDelay: 10,
      apiFallbackInterval: 20,
    });
  });

  afterEach(() => {
    healthMonitor.stop();
    vi.useRealTimers();
  });

  it("should start and stop health monitoring", () => {
    healthMonitor.start();
    expect(vi.getTimerCount()).toBe(1); // health-check interval

    healthMonitor.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("should schedule API fallback after WebSocket disconnect", async () => {
    healthMonitor.start();
    healthMonitor.addInstruments(["NSE_EQ|TEST"]);

    healthMonitor.onWebSocketDisconnect();
    expect(vi.getTimerCount()).toBe(2); // health check + fallback delay
    expect(healthMonitor.getHealthStatus().apiFallbackActive).toBe(true);

    await vi.advanceTimersByTimeAsync(15);

    expect(mockUpstoxClient.fetchQuote).toHaveBeenCalledWith("NSE_EQ|TEST");
    expect(mockUpdate).toHaveBeenCalled(); // last_api_ts
    expect(mockUpsert).toHaveBeenCalled(); // status offline
    expect(vi.getTimerCount()).toBe(2); // health check + fallback interval
  });

  it("should stop API fallback when WebSocket reconnects", async () => {
    healthMonitor.start();
    healthMonitor.addInstruments(["NSE_EQ|TEST"]);
    healthMonitor.onWebSocketDisconnect();
    expect(vi.getTimerCount()).toBe(2);

    healthMonitor.onWebSocketConnect();
    expect(vi.getTimerCount()).toBe(1);
    expect(healthMonitor.getHealthStatus().apiFallbackActive).toBe(false);
  });

  it("should not arm fallback timers after stop() or before start() (Bug #11)", () => {
    healthMonitor.addInstruments(["NSE_EQ|TEST"]);

    healthMonitor.onWebSocketDisconnect(); // never started
    expect(vi.getTimerCount()).toBe(0);

    healthMonitor.start();
    healthMonitor.stop();
    healthMonitor.onWebSocketDisconnect(); // after stop
    expect(vi.getTimerCount()).toBe(0);
    expect(healthMonitor.getHealthStatus().apiFallbackActive).toBe(false);
  });

  it("should buffer tick timestamps and flush them in one upsert per health-check cycle (Perf #1)", async () => {
    healthMonitor.start();
    healthMonitor.onWebSocketConnect();
    healthMonitor.addInstruments(["A", "B"]);
    mockUpsert.mockClear();

    for (let i = 0; i < 50; i++) {
      healthMonitor.onTickReceived("A");
      healthMonitor.onTickReceived("B");
    }
    expect(mockUpsert).not.toHaveBeenCalled(); // nothing written per tick

    await vi.advanceTimersByTimeAsync(1000);

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const rows = mockUpsert.mock.calls[0][0] as Array<{
      instrument_key: string;
      last_ws_ts: string;
    }>;
    expect(rows.map((r) => r.instrument_key).sort()).toEqual(["A", "B"]);
  });

  it("should flush pending timestamps on stop()", () => {
    healthMonitor.start();
    healthMonitor.onWebSocketConnect();
    healthMonitor.onTickReceived("A");
    mockUpsert.mockClear();

    healthMonitor.stop();
    expect(mockUpsert).toHaveBeenCalledTimes(1);
  });

  it("should restore health and cancel fallback when a tick arrives", async () => {
    healthMonitor.start();
    healthMonitor.addInstruments(["A"]);
    healthMonitor.onWebSocketDisconnect();
    expect(healthMonitor.getHealthStatus().wsHealthy).toBe(false);

    healthMonitor.onTickReceived("A");
    expect(healthMonitor.getHealthStatus().wsHealthy).toBe(true);
    expect(healthMonitor.getHealthStatus().apiFallbackActive).toBe(false);
  });

  it("should return correct health status", () => {
    healthMonitor.addInstruments(["NSE_EQ|TEST"]);
    const status = healthMonitor.getHealthStatus();

    expect(status.wsHealthy).toBe(false);
    expect(status.monitoredInstruments).toBe(1);
    expect(status.apiFallbackActive).toBe(false);
  });

  it("should throw when constructed without a client or credentials", () => {
    expect(
      () => new HealthMonitor({ upstoxClient: mockUpstoxClient as any }),
    ).toThrow(/supabase/i);
  });
});
