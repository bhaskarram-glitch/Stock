/**
 * Index derivative contracts: the permanent key rule, and registering still-trading contracts
 * under it. Shared by the backfill (target `active`) and the live streaming worker so both file
 * every contract's data under the same instrument row.
 */
import { upsertRows, type Db } from "../lib/db.js";
import type { Json } from "../lib/db-types.js";

/**
 * The permanent key for a derivative contract: `<segment>|<exchange_token>|<DD-MM-YYYY expiry>`,
 * i.e. the key Upstox uses once the contract has expired. Verified 2026-10-14 against every row:
 * trading key = `<segment>|<exchange_token>` (42,776/42,776), expired key = this (107,288/107,288).
 */
export function canonicalContractKey(segment: string, exchangeToken: string, expiry: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiry);
  if (!m) throw new Error(`Bad expiry date "${expiry}" (want YYYY-MM-DD)`);
  return `${segment}|${exchangeToken}|${m[3]}-${m[2]}-${m[1]}`;
}

/** A still-trading index contract as synced from the Upstox instrument master (trading key). */
export interface ActiveContractRow {
  provider_instrument_key: string;
  exchange: string;
  segment: string;
  trading_symbol: string;
  name: string;
  instrument_type: string | null;
  exchange_token: string;
  tick_size: string | null; // numeric → string from pg
  lot_size: number | null;
  underlying_key: string;
  underlying_symbol: string | null;
  expiry: string;
  strike: string | null;
  option_type: string | null;
  weekly: boolean | null;
  metadata: Json | null;
}

export interface ActiveContract {
  row: ActiveContractRow;
  /** permanent key */
  key: string;
}

/** Still-trading futures + options (trading-key rows) of the given underlyings, nearest expiry first. */
export async function loadActiveContracts(
  db: Db,
  underlyingKeys: string[],
  today: string,
): Promise<ActiveContract[]> {
  const { rows } = await db.query<ActiveContractRow>(
    `select provider_instrument_key, exchange, segment, trading_symbol, name, instrument_type,
            exchange_token, tick_size, lot_size, underlying_key, underlying_symbol, expiry, strike,
            option_type, weekly, metadata
       from instruments
      where segment in ('NSE_FO', 'BSE_FO')
        and expiry >= $1::date
        and provider_instrument_key = segment || '|' || exchange_token
        and underlying_key = any($2::text[])
      order by expiry, underlying_key, option_type nulls first, strike`,
    [today, underlyingKeys],
  );
  return rows.map((r) => ({ row: r, key: canonicalContractKey(r.segment, r.exchange_token, r.expiry) }));
}

/**
 * Makes sure every contract has its permanent-key instrument row and returns
 * permanent key → { id, sid }. DO NOTHING on conflict: a row an expired-contract run already wrote
 * (contract expiring today) must not be flipped back to active.
 */
export async function registerPermanentContracts(
  db: Db,
  contracts: ActiveContract[],
): Promise<Map<string, { id: string; sid: number }>> {
  if (contracts.length > 0) {
    await upsertRows(
      db,
      "instruments",
      contracts.map(({ row: r, key }) => ({
        provider: "upstox",
        provider_instrument_key: key,
        exchange: r.exchange,
        segment: r.segment,
        trading_symbol: r.trading_symbol,
        name: r.name,
        isin: null,
        instrument_type: r.instrument_type,
        exchange_token: r.exchange_token,
        tick_size: r.tick_size === null ? null : Number(r.tick_size),
        lot_size: r.lot_size,
        underlying_key: r.underlying_key,
        underlying_symbol: r.underlying_symbol,
        expiry: r.expiry,
        strike: r.strike === null ? null : Number(r.strike),
        option_type: r.option_type,
        weekly: r.weekly,
        is_expired: false,
        is_active: true,
        metadata: <Json>{ trading_key: r.provider_instrument_key },
      })),
      { conflict: ["provider", "provider_instrument_key"], ignoreDuplicates: true },
    );
  }
  return lookupInstrumentIds(db, contracts.map((c) => c.key));
}

/** provider_instrument_key → { id, sid } for the given keys (missing keys are simply absent). */
export async function lookupInstrumentIds(
  db: Db,
  keys: string[],
): Promise<Map<string, { id: string; sid: number }>> {
  const out = new Map<string, { id: string; sid: number }>();
  for (let i = 0; i < keys.length; i += 1000) {
    const { rows } = await db.query<{ id: string; sid: number; provider_instrument_key: string }>(
      `select id, sid, provider_instrument_key from instruments
        where provider = 'upstox' and provider_instrument_key = any($1::text[])`,
      [keys.slice(i, i + 1000)],
    );
    for (const r of rows) out.set(r.provider_instrument_key, { id: r.id, sid: r.sid });
  }
  return out;
}
