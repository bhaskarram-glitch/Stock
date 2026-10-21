/**
 * What the live worker streams, and how it is split across Upstox accounts (Phase 3, step 3.1).
 *
 * Universe = the index spots of the resolved underlyings + every still-trading future and option
 * of those underlyings, read from `instruments` at start-up (so it follows the 08:00 instrument sync).
 *
 * Upstox limits are PER ACCOUNT: 2,000 instrument keys in `full` mode (docs, checked 2026-10-16).
 * If the universe is bigger than accounts × 2,000, contracts that have not traded recently are left
 * out first (farthest expiry first) — day 1 showed long-dated NIFTY options with real volume being
 * dropped while never-traded near strikes were streamed — and the worker logs what it left out. Each account gets one connection with its share.
 */
import type { Db } from "../lib/db.js";
import type { ResolvedUnderlying } from "../providers/upstox/indices.js";
import {
  loadActiveContracts,
  lookupInstrumentIds,
  registerPermanentContracts,
} from "./contract-registry.js";

/** Upstox `full`-mode subscription limit per account. */
export const FULL_MODE_KEYS_PER_ACCOUNT = 2000;

export type LiveKind = "spot" | "future" | "option";

export interface LiveInstrument {
  /** key Upstox streams under (index key, or the contract's trading key) */
  feedKey: string;
  /** key candles are stored under (index key, or the contract's permanent key) */
  storeKey: string;
  sid: number;
  kind: LiveKind;
  underlyingKey: string;
  expiry: string | null;
  /** traded in the last ~2 weeks (daily candles with volume > 0) — kept first when over capacity */
  recentlyTraded?: boolean;
}

export async function loadLiveUniverse(
  db: Db,
  underlyings: ResolvedUnderlying[],
  today: string,
): Promise<LiveInstrument[]> {
  const underlyingKeys = underlyings.map((u) => u.instrumentKey);
  const spotIds = await lookupInstrumentIds(db, underlyingKeys);
  const spots: LiveInstrument[] = underlyings.flatMap((u) => {
    const ids = spotIds.get(u.instrumentKey);
    return ids
      ? [{ feedKey: u.instrumentKey, storeKey: u.instrumentKey, sid: ids.sid, kind: "spot" as const, underlyingKey: u.instrumentKey, expiry: null }]
      : [];
  });

  const contracts = await loadActiveContracts(db, underlyingKeys, today);
  const ids = await registerPermanentContracts(db, contracts);
  const derivatives: LiveInstrument[] = contracts.flatMap(({ row, key }) => {
    const id = ids.get(key);
    if (!id) return [];
    return [{
      feedKey: row.provider_instrument_key,
      storeKey: key,
      sid: id.sid,
      kind: row.option_type ? ("option" as const) : ("future" as const),
      underlyingKey: row.underlying_key,
      expiry: row.expiry,
    }];
  });
  const traded = await recentlyTradedKeys(db, derivatives.map((d) => d.storeKey), today);
  for (const d of derivatives) d.recentlyTraded = traded.has(d.storeKey);
  return [...spots, ...derivatives];
}

/** Keys with at least one daily candle with volume > 0 in the 14 days before `today`. */
async function recentlyTradedKeys(db: Db, keys: string[], today: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < keys.length; i += 2000) {
    const { rows } = await db.query<{ instrument_key: string }>(
      `select distinct instrument_key from market_candles
        where instrument_key = any($1::text[]) and interval = '1d' and volume > 0
          and bucket_start >= ($2::date - 14)::timestamp at time zone 'Asia/Kolkata'`,
      [keys.slice(i, i + 2000), today],
    );
    for (const r of rows) out.add(r.instrument_key);
  }
  return out;
}

export interface ShardPlan {
  /** account alias → instruments it streams */
  shards: Map<string, LiveInstrument[]>;
  /** instruments that did not fit, farthest expiries first in line to be dropped */
  dropped: LiveInstrument[];
  capacity: number;
}

const KIND_ORDER: Record<LiveKind, number> = { spot: 0, future: 1, option: 2 };

/**
 * Keeps spots, then futures, then options that traded recently, then the rest — each by nearest
 * expiry — up to accounts × perAccount, and deals
 * them out round-robin so every account carries a similar mix (and a similar tick load).
 */
export function planShards(
  instruments: LiveInstrument[],
  accountAliases: string[],
  perAccount: number = FULL_MODE_KEYS_PER_ACCOUNT,
): ShardPlan {
  if (accountAliases.length === 0) throw new Error("planShards needs at least one account");
  const capacity = accountAliases.length * perAccount;
  const seen = new Set<string>();
  const ordered = instruments
    .filter((i) => (seen.has(i.feedKey) ? false : (seen.add(i.feedKey), true)))
    .sort(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        Number(!a.recentlyTraded) - Number(!b.recentlyTraded) ||
        (a.expiry ?? "").localeCompare(b.expiry ?? "") ||
        a.underlyingKey.localeCompare(b.underlyingKey) ||
        a.feedKey.localeCompare(b.feedKey),
    );
  const kept = ordered.slice(0, capacity);
  const dropped = ordered.slice(capacity);
  const shards = new Map<string, LiveInstrument[]>(accountAliases.map((a) => [a, []]));
  kept.forEach((inst, i) => shards.get(accountAliases.at(i % accountAliases.length)!)!.push(inst));
  return { shards, dropped, capacity };
}

/** Short, log-friendly description of what was left out. */
export function describeDropped(dropped: LiveInstrument[]): Record<string, unknown> {
  if (dropped.length === 0) return { dropped: 0 };
  const expiries = dropped.map((d) => d.expiry ?? "").filter(Boolean).sort();
  return {
    dropped: dropped.length,
    recentlyTraded: dropped.filter((d) => d.recentlyTraded).length,
    kinds: Object.fromEntries(
      (["spot", "future", "option"] as const).map((k) => [k, dropped.filter((d) => d.kind === k).length]),
    ),
    expiriesFrom: expiries.at(0) ?? null,
    expiriesTo: expiries.at(-1) ?? null,
  };
}
