/**
 * Sliding-window rate limiter for Upstox REST calls.
 *
 * Documented limits are per-API, per-user (https://upstox.com/developer/api-documentation/rate-limiting):
 *   25 / second, 250 / minute, 1000 / 30 minutes.
 * The 30-minute window is the binding one for bulk work: 1000 / 1800 s ≈ 0.55 req/s sustained.
 *
 * `acquire()` waits until a request may be sent. `penalise()` is called on a 429 so the limiter
 * pauses the whole window rather than retrying into the same wall.
 */
export interface RateLimitWindows {
  perSecond: number;
  perMinute: number;
  perThirtyMinutes: number;
}

export const UPSTOX_LIMITS: RateLimitWindows = {
  perSecond: 25,
  perMinute: 250,
  perThirtyMinutes: 1000,
};

export interface RateLimiterOptions {
  limits?: RateLimitWindows;
  /** Fraction of the documented limits to actually use. Default 0.9 (headroom for clock skew). */
  safety?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const SECOND = 1_000;
const MINUTE = 60_000;
const THIRTY_MINUTES = 30 * 60_000;

export class RateLimiter {
  private readonly limits: RateLimitWindows;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Request timestamps, oldest first, trimmed to the longest window. */
  private history: number[] = [];
  private blockedUntil = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: RateLimiterOptions = {}) {
    const safety = options.safety ?? 0.9;
    const base = options.limits ?? UPSTOX_LIMITS;
    this.limits = {
      perSecond: Math.max(1, Math.floor(base.perSecond * safety)),
      perMinute: Math.max(1, Math.floor(base.perMinute * safety)),
      perThirtyMinutes: Math.max(1, Math.floor(base.perThirtyMinutes * safety)),
    };
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Resolves when it is safe to send. Calls are serialised so concurrent callers don't overshoot. */
  async acquire(): Promise<void> {
    const turn = this.queue.then(() => this.waitForSlot());
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private async waitForSlot(): Promise<void> {
    for (;;) {
      const wait = this.msUntilAllowed();
      if (wait <= 0) {
        this.history.push(this.now());
        return;
      }
      await this.sleep(Math.min(wait, 60_000));
    }
  }

  /** ms to wait before the next request is permitted by every window (0 = go now). */
  msUntilAllowed(): number {
    const now = this.now();
    if (now < this.blockedUntil) return this.blockedUntil - now;

    this.history = this.history.filter((t) => t > now - THIRTY_MINUTES);
    const waits = [
      this.windowWait(now, SECOND, this.limits.perSecond),
      this.windowWait(now, MINUTE, this.limits.perMinute),
      this.windowWait(now, THIRTY_MINUTES, this.limits.perThirtyMinutes),
    ];
    return Math.max(0, ...waits);
  }

  private windowWait(now: number, windowMs: number, limit: number): number {
    const inWindow = this.history.filter((t) => t > now - windowMs);
    if (inWindow.length < limit) return 0;
    // Wait until the oldest request in this window ages out.
    return inWindow[inWindow.length - limit] + windowMs - now;
  }

  /** Called after a 429: hold every request for `ms` (server knows better than our accounting). */
  penalise(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms);
  }

  stats(): {
    lastSecond: number;
    lastMinute: number;
    lastThirtyMinutes: number;
    blockedForMs: number;
  } {
    const now = this.now();
    return {
      lastSecond: this.history.filter((t) => t > now - SECOND).length,
      lastMinute: this.history.filter((t) => t > now - MINUTE).length,
      lastThirtyMinutes: this.history.filter((t) => t > now - THIRTY_MINUTES)
        .length,
      blockedForMs: Math.max(0, this.blockedUntil - now),
    };
  }
}
