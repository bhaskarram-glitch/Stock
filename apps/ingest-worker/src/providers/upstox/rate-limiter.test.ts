import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limiter.js";

/** Virtual clock so window behaviour is tested without real waiting. */
function makeLimiter(limits: {
  perSecond: number;
  perMinute: number;
  perThirtyMinutes: number;
}) {
  let clock = 1_000_000;
  const limiter = new RateLimiter({
    limits,
    safety: 1,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  return { limiter, advance: (ms: number) => (clock += ms), at: () => clock };
}

describe("RateLimiter", () => {
  it("allows requests up to the per-second limit then waits", async () => {
    const { limiter, at } = makeLimiter({
      perSecond: 3,
      perMinute: 1000,
      perThirtyMinutes: 1000,
    });
    const start = at();
    for (let i = 0; i < 3; i++) await limiter.acquire();
    expect(at()).toBe(start); // no waiting yet
    await limiter.acquire();
    expect(at()).toBeGreaterThanOrEqual(start + 1000);
  });

  it("enforces the 30-minute window, the binding one for bulk work", async () => {
    const { limiter, at } = makeLimiter({
      perSecond: 100,
      perMinute: 100,
      perThirtyMinutes: 5,
    });
    const start = at();
    for (let i = 0; i < 5; i++) await limiter.acquire();
    await limiter.acquire();
    expect(at()).toBeGreaterThanOrEqual(start + 30 * 60_000);
  });

  it("penalise() holds every request for the given duration", async () => {
    const { limiter, at } = makeLimiter({
      perSecond: 100,
      perMinute: 100,
      perThirtyMinutes: 100,
    });
    limiter.penalise(120_000);
    expect(limiter.msUntilAllowed()).toBe(120_000);
    const start = at();
    await limiter.acquire();
    expect(at()).toBeGreaterThanOrEqual(start + 120_000);
  });

  it("reports window usage", async () => {
    const { limiter, advance } = makeLimiter({
      perSecond: 100,
      perMinute: 100,
      perThirtyMinutes: 100,
    });
    for (let i = 0; i < 4; i++) await limiter.acquire();
    expect(limiter.stats().lastSecond).toBe(4);
    advance(2000);
    expect(limiter.stats().lastSecond).toBe(0);
    expect(limiter.stats().lastMinute).toBe(4);
  });

  it("applies the safety factor to the documented limits", async () => {
    let clock = 0;
    const limiter = new RateLimiter({
      limits: { perSecond: 10, perMinute: 100, perThirtyMinutes: 1000 },
      safety: 0.5,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    for (let i = 0; i < 5; i++) await limiter.acquire();
    expect(clock).toBe(0);
    await limiter.acquire();
    expect(clock).toBeGreaterThanOrEqual(1000);
  });
});
