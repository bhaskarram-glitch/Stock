import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { UpstoxApiError } from "../providers/upstox/historical.js";
import { canonicalContractKey, lastCandleDate, newerDate, resumeFrom, settleBseExpiryClose } from "./backfill-history.js";

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

describe("canonicalContractKey (one key per contract for life)", () => {
  it("builds the expired-style key from segment, token and expiry", () => {
    expect(canonicalContractKey("NSE_FO", "47983", "2025-04-17")).toBe("NSE_FO|47983|17-04-2025");
    expect(canonicalContractKey("BSE_FO", "1162668", "2026-01-14")).toBe("BSE_FO|1162668|14-01-2026");
  });

  it("rejects a malformed expiry instead of inventing a key", () => {
    expect(() => canonicalContractKey("NSE_FO", "1", "17-04-2025")).toThrow(/YYYY-MM-DD/);
  });
});

describe("UpstoxApiError.isUnsupportedKey", () => {
  it("is true only for UDAPI1021 (key Upstox will never serve)", () => {
    expect(new UpstoxApiError("Instrument key is of invalid format", 400, "UDAPI1021", null).isUnsupportedKey).toBe(true);
    expect(new UpstoxApiError("rate limited", 429, null, 1000).isUnsupportedKey).toBe(false);
    expect(new UpstoxApiError("plus needed", 403, "UDAPI1149", null).isUnsupportedKey).toBe(false);
  });
});

describe("resumeFrom / newerDate (late-published candles)", () => {
  it("re-asks the last 7 days so a late candle is still picked up", () => {
    expect(resumeFrom("2026-10-21", "2024-10-03", "2026-10-22")).toBe("2026-10-15");
    expect(resumeFrom("2026-09-01", "2024-10-03", "2026-10-22")).toBe("2026-09-02"); // far behind: resume normally
    expect(resumeFrom(null, "2024-10-03", "2026-10-22")).toBe("2024-10-03");
    expect(resumeFrom("2024-10-03", "2024-10-03", "2024-10-05")).toBe("2024-10-03"); // never before the floor
  });

  it("never moves the watermark backwards", () => {
    expect(newerDate("2026-10-19", "2026-10-21")).toBe("2026-10-21");
    expect(newerDate(null, "2026-10-21")).toBe("2026-10-21");
    expect(newerDate("2026-10-22", undefined)).toBe("2026-10-22");
  });
});
