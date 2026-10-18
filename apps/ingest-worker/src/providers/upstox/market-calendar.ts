/**
 * Is today a session the live worker should stream? (Phase 3, step 3.4)
 *
 * Weekends never are. A weekday is skipped when Upstox lists it as a TRADING_HOLIDAY with both
 * derivative exchanges (NFO and BFO) closed. If the holidays API fails, the worker streams anyway
 * (fail open): an idle connection on a holiday costs nothing, a missed trading day cannot be redone.
 * Special sessions (e.g. Muhurat trading on a weekend evening) are not streamed by this worker.
 */
import { logger } from "../../lib/logger.js";
import type { UpstoxMarketHoliday } from "./types.js";

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** IST calendar date (YYYY-MM-DD) and minutes since IST midnight for an instant. */
export function istClock(nowMs: number): { date: string; minutes: number; weekday: number } {
  const ist = new Date(nowMs + IST_OFFSET_MS);
  return {
    date: ist.toISOString().slice(0, 10),
    minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes(),
    weekday: ist.getUTCDay(), // 0 = Sunday
  };
}

/** "HH:MM" → minutes since midnight. */
export function parseHhMm(value: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`Bad time "${value}" (want HH:MM)`);
  return Number(m[1]) * 60 + Number(m[2]);
}

const FNO_EXCHANGES = ["NFO", "BFO"];

/** The holiday entry that closes F&O on `date`, or null. */
export function fnoHoliday(holidays: UpstoxMarketHoliday[], date: string): UpstoxMarketHoliday | null {
  return (
    holidays.find(
      (h) =>
        h.date?.slice(0, 10) === date &&
        h.holiday_type === "TRADING_HOLIDAY" &&
        FNO_EXCHANGES.every((x) => (h.closed_exchanges ?? []).includes(x)),
    ) ?? null
  );
}

export type SessionDecision = { stream: true } | { stream: false; reason: string };

export async function decideSession(
  nowMs: number,
  window: { startMin: number; stopMin: number },
  fetchHolidays: () => Promise<UpstoxMarketHoliday[]>,
): Promise<SessionDecision> {
  const { date, minutes, weekday } = istClock(nowMs);
  if (weekday === 0 || weekday === 6) return { stream: false, reason: `weekend (${date})` };
  if (minutes < window.startMin || minutes >= window.stopMin) {
    return { stream: false, reason: `outside the streaming window (${date}, IST minute ${minutes})` };
  }
  try {
    const hit = fnoHoliday(await fetchHolidays(), date);
    if (hit) return { stream: false, reason: `trading holiday: ${hit.description ?? date}` };
  } catch (error) {
    logger.warn("Holiday check failed; streaming anyway", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { stream: true };
}
