import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { lastCandleDate } from "./backfill-history.js";

const candle = (ts: string) => ({ ts, open: 1, high: 1, low: 1, close: 1, volume: 0, oi: null });

describe("lastCandleDate (backfill watermark)", () => {
  it("is null when Upstox returned nothing — the watermark must not move", () => {
    expect(lastCandleDate([])).toBeNull();
  });

  it("returns the IST trading date of the newest candle, whatever the input order", () => {
    expect(
      lastCandleDate([
        candle("2026-10-09T09:15:00+05:30"),
        candle("2026-10-12T09:15:00+05:30"),
        candle("2026-10-08T09:15:00+05:30"),
      ]),
    ).toBe("2026-10-12");
  });

  it("uses the IST date even when the timestamp is given in UTC", () => {
    // 2026-10-12 00:30 IST == 2026-10-11 19:00 UTC
    expect(lastCandleDate([candle("2026-10-11T19:00:00Z")])).toBe("2026-10-12");
  });
});
