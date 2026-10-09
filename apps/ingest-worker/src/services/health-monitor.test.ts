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

import { HealthMonitor } from "./health-monitor.js";
import { fakeDb, type FakeDb } from "../test-utils/fake-db.js";

let db: FakeDb;
const statusUpserts = () =>
  db.statements.filter((s) => s.text.startsWith('insert into "instrument_status"'));
const apiTsUpdates = () =>
  db.statements.filter((s) => s.text.startsWith("update instrument_status"));

describe("HealthMonitor", () => {
  let healthMonitor: HealthMonitor;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: false });
    db = fakeDb();

    healthMonitor = new HealthMonitor({
      db,
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
    expect(apiTsUpdates().length).toBeGreaterThan(0); // last_api_ts
    expect(statusUpserts().length).toBeGreaterThan(0); // status offline
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
    const before = statusUpserts().length;

    for (let i = 0; i < 50; i++) {
      healthMonitor.onTickReceived("A");
      healthMonitor.onTickReceived("B");
    }
    expect(statusUpserts().length).toBe(before); // nothing written per tick

    await vi.advanceTimersByTimeAsync(1000);

    const flushes = statusUpserts().slice(before).filter((s) => s.text.includes('"last_ws_ts"'));
    expect(flushes).toHaveLength(1);
    const keys = db
      .inserted("instrument_status")
      .filter((r) => r.last_ws_ts !== undefined)
      .map((r) => r.instrument_key);
    expect(keys.sort()).toEqual(["A", "B"]);
  });

  it("should flush pending timestamps on stop()", () => {
    healthMonitor.start();
    healthMonitor.onWebSocketConnect();
    healthMonitor.onTickReceived("A");
    const before = statusUpserts().length;

    healthMonitor.stop();
    expect(statusUpserts().length).toBe(before + 1);
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

  it("should throw when constructed without a db", () => {
    expect(
      () => new HealthMonitor({ upstoxClient: mockUpstoxClient as any } as any),
    ).toThrow(/db/i);
  });
});
