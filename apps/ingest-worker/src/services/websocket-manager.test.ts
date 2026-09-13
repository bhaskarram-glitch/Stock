import { describe, it, expect, beforeEach, vi } from "vitest";

const connectMock = vi.fn();
const disconnectMock = vi.fn();
const subscribeMock = vi.fn();
const unsubscribeMock = vi.fn();
const isConnectedMock = vi.fn(() => true);

vi.mock("../providers/upstox/websocket-client.js", () => ({
  UpstoxWebSocketClient: class {
    onTick?: (tick: any) => void;
    onConnect?: () => void;
    onDisconnect?: () => void;
    onError?: (error: Error) => void;

    constructor(options: any) {
      this.onTick = options.onTick;
      this.onConnect = options.onConnect;
      this.onDisconnect = options.onDisconnect;
      this.onError = options.onError;
    }

    connect() {
      connectMock();
      this.onConnect?.();
    }

    disconnect() {
      disconnectMock();
      this.onDisconnect?.();
    }

    subscribe(instruments: string[]) {
      subscribeMock(instruments);
    }

    unsubscribe(instruments: string[]) {
      unsubscribeMock(instruments);
    }

    isWebSocketConnected() {
      return isConnectedMock();
    }
  },
}));

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { WebSocketManager } from "./websocket-manager.js";

function makeAggregatorMock(missingOnPreload: string[] = []) {
  return {
    processTick: vi.fn(async () => {}),
    flushAllBuckets: vi.fn(async () => {}),
    preloadInstrumentIds: vi.fn(async () => missingOnPreload),
    startFlusher: vi.fn(() => {}),
    stopFlusher: vi.fn(() => {}),
    drain: vi.fn(async () => {}),
    setActiveIntervals: vi.fn(() => {}),
    getStats: vi.fn(() => ({
      activeBuckets: 0,
      intervals: ["1m"],
      droppedLateTicks: 0,
      pendingPersist: 0,
    })),
  };
}

describe("WebSocketManager", () => {
  let manager: WebSocketManager;
  let mockCandleAggregator: ReturnType<typeof makeAggregatorMock>;
  const mockHealthMonitor = {
    start: vi.fn(() => {}),
    stop: vi.fn(() => {}),
    addInstruments: vi.fn(() => {}),
    removeInstruments: vi.fn(() => {}),
    onWebSocketConnect: vi.fn(() => {}),
    onWebSocketDisconnect: vi.fn(() => {}),
    onWebSocketError: vi.fn(() => {}),
    onTickReceived: vi.fn(() => {}),
    getHealthStatus: vi.fn(() => ({
      wsHealthy: true,
      monitoredInstruments: 0,
      apiFallbackActive: false,
    })),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCandleAggregator = makeAggregatorMock();
    manager = new WebSocketManager(
      mockCandleAggregator as any,
      mockHealthMonitor as any,
      {} as any,
      { maxInstruments: 2 },
    );
  });

  it("should start and stop cleanly, in the right order", async () => {
    await manager.start();
    expect(mockHealthMonitor.start).toHaveBeenCalled();
    expect(mockCandleAggregator.startFlusher).toHaveBeenCalled();
    expect(connectMock).toHaveBeenCalled();

    await manager.stop();
    expect(disconnectMock).toHaveBeenCalled();
    expect(mockCandleAggregator.stopFlusher).toHaveBeenCalled();
    expect(mockCandleAggregator.flushAllBuckets).toHaveBeenCalled();
    expect(mockHealthMonitor.stop).toHaveBeenCalled();
    // A deliberate stop must not arm API fallback (Bug #11)
    expect(mockHealthMonitor.onWebSocketDisconnect).not.toHaveBeenCalled();
    expect(manager.getStatus().isRunning).toBe(false);
  });

  it("should preload ids and auto-subscribe initial instruments on start", async () => {
    manager = new WebSocketManager(
      mockCandleAggregator as any,
      mockHealthMonitor as any,
      {} as any,
      { maxInstruments: 2, initialInstruments: ["A"] },
    );

    await manager.start();

    expect(mockCandleAggregator.preloadInstrumentIds).toHaveBeenCalledWith([
      "A",
    ]);
    expect(mockHealthMonitor.addInstruments).toHaveBeenCalledWith(["A"]);
    expect(subscribeMock).toHaveBeenCalledWith(["A"]);
  });

  it("should fail fast when an initial instrument is missing from the DB", async () => {
    mockCandleAggregator = makeAggregatorMock(["A"]);
    manager = new WebSocketManager(
      mockCandleAggregator as any,
      mockHealthMonitor as any,
      {} as any,
      { maxInstruments: 2, initialInstruments: ["A"] },
    );

    await expect(manager.start()).rejects.toThrow(/missing/i);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("should only warn about missing instruments when failOnMissingInstruments is false", async () => {
    mockCandleAggregator = makeAggregatorMock(["A"]);
    manager = new WebSocketManager(
      mockCandleAggregator as any,
      mockHealthMonitor as any,
      {} as any,
      {
        maxInstruments: 2,
        initialInstruments: ["A"],
        failOnMissingInstruments: false,
      },
    );

    await manager.start();
    expect(connectMock).toHaveBeenCalled();
  });

  it("should subscribe and unsubscribe instruments", async () => {
    await manager.start();
    manager.subscribe(["A", "B"]);

    expect(subscribeMock).toHaveBeenCalledWith(["A", "B"]);
    expect(mockHealthMonitor.addInstruments).toHaveBeenCalledWith(["A", "B"]);
    expect(mockCandleAggregator.preloadInstrumentIds).toHaveBeenCalledWith([
      "A",
      "B",
    ]);

    manager.unsubscribe(["A"]);
    expect(unsubscribeMock).toHaveBeenCalledWith(["A"]);
    expect(mockHealthMonitor.removeInstruments).toHaveBeenCalledWith(["A"]);
  });

  it("should enforce maxInstruments", async () => {
    await manager.start();
    expect(() => manager.subscribe(["A", "B", "C"])).toThrow(/exceed/i);
  });

  it("should pass volume deltas (not cumulative vtt) to the aggregator", async () => {
    await manager.start();
    const ts = new Date().toISOString();

    await (manager as any).handleTick({
      instrument_token: "A",
      last_price: 100,
      volume: 1000,
      timestamp: ts,
    });
    await (manager as any).handleTick({
      instrument_token: "A",
      last_price: 101,
      volume: 1250,
      timestamp: ts,
    });

    expect(mockCandleAggregator.processTick).toHaveBeenNthCalledWith(
      1,
      "A",
      100,
      0,
      expect.any(Date),
    );
    expect(mockCandleAggregator.processTick).toHaveBeenNthCalledWith(
      2,
      "A",
      101,
      250,
      expect.any(Date),
    );
    expect(mockHealthMonitor.onTickReceived).toHaveBeenCalledTimes(2);
  });

  it("should reject ticks with no usable price and accept ohlc.close fallback", async () => {
    await manager.start();

    await (manager as any).handleTick({
      instrument_token: "A",
      last_price: 0,
      timestamp: new Date().toISOString(),
    });
    await (manager as any).handleTick({
      instrument_token: "A",
      timestamp: new Date().toISOString(),
    });
    expect(mockCandleAggregator.processTick).not.toHaveBeenCalled();

    await (manager as any).handleTick({
      instrument_token: "A",
      ohlc: { close: 99.5 },
      timestamp: new Date().toISOString(),
    });
    expect(mockCandleAggregator.processTick).toHaveBeenCalledWith(
      "A",
      99.5,
      0,
      expect.any(Date),
    );
  });

  it("should report status", async () => {
    await manager.start();
    const status = manager.getStatus();
    expect(status.isRunning).toBe(true);
    expect(status.activeInstruments).toBe(0);
    expect(status.wsConnected).toBe(true);
    expect(status.candleStats.droppedLateTicks).toBe(0);
  });
});
