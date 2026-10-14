import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { lastCandleDate, settleBseExpiryClose } from "./backfill-history.js";

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

describe("settleBseExpiryClose (BSE expiry-day close = index level)", () => {
  // Real shape from 2026-05-14: option traded 0.05–1.85, reported close 75,398.72 (= SENSEX)
  const bad = { ts: "2026-05-14T09:15:00+05:30", open: 0.9, high: 1.85, low: 0.05, close: 75398.72, volume: 1, oi: 1 };
  const contract = (type: string, strike: number, segment = "BSE_FO", expiry = "2026-05-14") =>
    ({ segment, instrument_type: type, strike_price: strike, expiry });

  it("replaces the index level with the call's intrinsic value and keeps the original", () => {
    expect(settleBseExpiryClose(bad, contract("CE", 75000))).toEqual({ close: 398.72, closeReported: 75398.72 });
  });

  it("puts settle at strike − index", () => {
    expect(settleBseExpiryClose(bad, contract("PE", 75500))).toEqual({ close: 101.28, closeReported: 75398.72 });
  });

  it("out-of-the-money settles at 0", () => {
    expect(settleBseExpiryClose(bad, contract("CE", 76000)).close).toBe(0);
    expect(settleBseExpiryClose(bad, contract("PE", 75000)).close).toBe(0);
  });

  it("leaves everything else untouched", () => {
    const untouched = { close: bad.close, closeReported: null };
    expect(settleBseExpiryClose(bad, contract("CE", 75000, "NSE_FO"))).toEqual(untouched); // NSE
    expect(settleBseExpiryClose(bad, contract("FUT", 75000))).toEqual(untouched); // futures
    expect(settleBseExpiryClose(bad, contract("CE", 75000, "BSE_FO", "2026-05-21"))).toEqual(untouched); // not expiry day
    expect(settleBseExpiryClose({ ...bad, close: 1.2 }, contract("CE", 75000))).toEqual({ close: 1.2, closeReported: null }); // normal close
    expect(settleBseExpiryClose(bad, contract("CE", 20000))).toEqual(untouched); // not index-like vs strike
  });
});
