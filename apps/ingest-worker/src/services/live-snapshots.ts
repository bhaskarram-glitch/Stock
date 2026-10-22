/**
 * 5-minute market snapshots (Phase 3; table live_snapshots, migration 0006).
 *
 * SnapshotBook keeps the latest known state of every streamed instrument, updated from EVERY tick
 * (also the ones TickFilter ignores: OI/quote-only updates and never-traded contracts). At each
 * 5-minute mark `take()` returns rows for instruments whose state changed since their previous
 * snapshot — or all of them on the first take of the session — and LiveSnapshotWriter stores them.
 */
import type { Db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import type { UpstoxWSTick } from "../providers/upstox/types.js";

export const SNAPSHOT_EVERY_MS = 5 * 60_000;

export interface SnapshotState {
  ltp: number | null;
  ltt: string | null;
  volume: number | null;
  oi: number | null;
  atp: number | null;
  bid: number | null;
  bid_qty: number | null;
  ask: number | null;
  ask_qty: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
}

export interface SnapshotRow extends SnapshotState {
  sid: number;
  ts: Date;
}

const num = (v: number | undefined): number | null => (v !== undefined && Number.isFinite(v) ? v : null);

interface Entry {
  state: SnapshotState;
  /** serialized state at the last take, null = never taken */
  written: string | null;
}

export class SnapshotBook {
  private readonly entries = new Map<number, Entry>();

  /** Merge a tick into the instrument's state; fields the tick does not carry keep their value. */
  update(sid: number, tick: UpstoxWSTick): void {
    let e = this.entries.get(sid);
    if (!e) {
      e = {
        state: { ltp: null, ltt: null, volume: null, oi: null, atp: null, bid: null, bid_qty: null, ask: null, ask_qty: null, iv: null, delta: null, gamma: null, theta: null, vega: null },
        written: null,
      };
      this.entries.set(sid, e);
    }
    const s = e.state;
    const set = <K extends keyof SnapshotState>(k: K, v: SnapshotState[K] | null) => {
      if (v !== null) s[k] = v;
    };
    set("ltp", num(tick.last_price));
    set("ltt", tick.market_data?.ltt ?? null);
    set("volume", num(tick.volume));
    set("oi", num(tick.market_data?.oi));
    set("atp", num(tick.atp));
    set("bid", num(tick.bid));
    set("bid_qty", num(tick.bid_qty));
    set("ask", num(tick.ask));
    set("ask_qty", num(tick.ask_qty));
    set("iv", num(tick.iv));
    set("delta", num(tick.greeks?.delta));
    set("gamma", num(tick.greeks?.gamma));
    set("theta", num(tick.greeks?.theta));
    set("vega", num(tick.greeks?.vega));
  }

  /** Rows for every instrument whose state changed since its last take (first take: all). */
  take(ts: Date): SnapshotRow[] {
    const rows: SnapshotRow[] = [];
    for (const [sid, e] of this.entries) {
      const key = JSON.stringify(e.state);
      if (key === e.written) continue;
      e.written = key;
      rows.push({ sid, ts, ...e.state });
    }
    return rows;
  }

  size(): number {
    return this.entries.size;
  }
}

/** The next 5-minute mark strictly after `nowMs` (IST marks fall on UTC 5-minute marks). */
export function nextSnapshotMark(nowMs: number, everyMs: number = SNAPSHOT_EVERY_MS): number {
  return Math.floor(nowMs / everyMs) * everyMs + everyMs;
}

const CHUNK = 5000;

export class LiveSnapshotWriter {
  written = 0;
  failedBatches = 0;

  constructor(
    private readonly db: Db,
    private readonly ensurePartitions: (day: string) => Promise<void>,
    private readonly retryDelaysMs: number[] = [1000, 3000],
  ) {}

  async write(rows: SnapshotRow[], istDay: string): Promise<void> {
    if (rows.length === 0) return;
    await this.ensurePartitions(istDay);
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      try {
        await this.withRetry(() => this.insert(chunk));
        this.written += chunk.length;
      } catch (error) {
        this.failedBatches += 1;
        logger.error("Live snapshots NOT saved", {
          count: chunk.length,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async insert(rows: SnapshotRow[]): Promise<void> {
    const col = <K extends keyof SnapshotRow>(k: K) => rows.map((r) => r[k]);
    const int = (v: number | null) => (v === null ? null : Math.round(v));
    await this.db.query(
      `insert into live_snapshots (sid, ts, ltp, ltt, volume, oi, atp, bid, bid_qty, ask, ask_qty,
                                   iv, delta, gamma, theta, vega)
       select * from unnest($1::int[], $2::timestamptz[], $3::float8[], $4::timestamptz[], $5::bigint[],
                            $6::bigint[], $7::float8[], $8::float8[], $9::int[], $10::float8[], $11::int[],
                            $12::real[], $13::real[], $14::real[], $15::real[], $16::real[])
       on conflict (sid, ts) do update set
         ltp = excluded.ltp, ltt = excluded.ltt, volume = excluded.volume, oi = excluded.oi,
         atp = excluded.atp, bid = excluded.bid, bid_qty = excluded.bid_qty, ask = excluded.ask,
         ask_qty = excluded.ask_qty, iv = excluded.iv, delta = excluded.delta, gamma = excluded.gamma,
         theta = excluded.theta, vega = excluded.vega`,
      [
        col("sid"),
        rows.map((r) => r.ts.toISOString()),
        col("ltp"),
        col("ltt"),
        rows.map((r) => int(r.volume)),
        rows.map((r) => int(r.oi)),
        col("atp"),
        col("bid"),
        rows.map((r) => int(r.bid_qty)),
        col("ask"),
        rows.map((r) => int(r.ask_qty)),
        col("iv"),
        col("delta"),
        col("gamma"),
        col("theta"),
        col("vega"),
      ],
    );
  }

  private async withRetry(fn: () => Promise<void>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        const delay = this.retryDelaysMs[attempt];
        if (delay === undefined) throw error;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
}
