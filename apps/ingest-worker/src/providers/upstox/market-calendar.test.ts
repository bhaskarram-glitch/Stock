import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { decideSession, fnoHoliday, istClock, parseHhMm } from "./market-calendar.js";

const at = (ist: string) => Date.parse(`${ist}+05:30`);
const window = { startMin: parseHhMm("08:50"), stopMin: parseHhMm("15:45") };
const diwali = {
  date: "2026-11-10",
  description: "Diwali Balipratipada",
  holiday_type: "TRADING_HOLIDAY",
  closed_exchanges: ["NSE", "NFO", "CDS", "BSE", "BFO", "BCD", "MCX"],
  open_exchanges: [],
};

describe("market calendar", () => {
  it("converts to the IST clock", () => {
    expect(istClock(at("2026-10-19T09:15:00"))).toEqual({ date: "2026-10-19", minutes: 555, weekday: 1 });
    expect(istClock(Date.parse("2026-10-18T18:45:00Z")).date).toBe("2026-10-19"); // after IST midnight
  });

  it("parses HH:MM", () => {
    expect(parseHhMm("15:45")).toBe(945);
    expect(() => parseHhMm("25:00")).toThrow();
  });

  it("finds F&O holidays only when both NFO and BFO are closed", () => {
    expect(fnoHoliday([diwali], "2026-11-10")?.description).toBe("Diwali Balipratipada");
    expect(fnoHoliday([{ ...diwali, closed_exchanges: ["MCX"] }], "2026-11-10")).toBeNull();
    expect(fnoHoliday([{ ...diwali, holiday_type: "SETTLEMENT_HOLIDAY" }], "2026-11-10")).toBeNull();
  });

  it("streams on a normal weekday inside the window", async () => {
    expect(await decideSession(at("2026-10-19T09:00:00"), window, async () => [diwali])).toEqual({ stream: true });
  });

  it("skips weekends, out-of-window starts and holidays", async () => {
    const h = async () => [diwali];
    expect((await decideSession(at("2026-10-18T09:00:00"), window, h)).stream).toBe(false); // Sunday
    expect((await decideSession(at("2026-10-19T02:30:00"), window, h)).stream).toBe(false); // boot at 02:30
    expect((await decideSession(at("2026-10-19T15:45:00"), window, h)).stream).toBe(false);
    expect(await decideSession(at("2026-11-10T09:00:00"), window, h)).toEqual({
      stream: false,
      reason: "trading holiday: Diwali Balipratipada",
    });
  });

  it("streams anyway when the holiday API fails", async () => {
    const failing = async () => { throw new Error("503"); };
    expect(await decideSession(at("2026-11-10T09:00:00"), window, failing)).toEqual({ stream: true });
  });
});
