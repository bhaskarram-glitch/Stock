/**
 * The index underlyings we track for F&O, and helpers for resolving their instrument keys.
 *
 * Keys are resolved from the `instruments` table (populated by sync-instruments) rather than
 * hardcoded, because Upstox's exact index naming varies. `patterns` are matched case-insensitively
 * against trading_symbol and name; the first match wins, and unresolved entries are reported.
 */
export interface IndexUnderlying {
  /** Short symbol used in logs and job arguments. */
  symbol: string;
  label: string;
  exchange: "NSE" | "BSE";
  /** Candidate names/symbols, most specific first. */
  patterns: string[];
}

export const FNO_INDEX_UNDERLYINGS: IndexUnderlying[] = [
  {
    symbol: "NIFTY",
    label: "Nifty 50",
    exchange: "NSE",
    patterns: ["Nifty 50", "NIFTY 50"],
  },
  {
    symbol: "BANKNIFTY",
    label: "Nifty Bank",
    exchange: "NSE",
    patterns: ["Nifty Bank", "NIFTY BANK"],
  },
  {
    symbol: "FINNIFTY",
    label: "Nifty Financial Services",
    exchange: "NSE",
    patterns: ["Nifty Fin Service", "Nifty Financial Services", "FINNIFTY"],
  },
  {
    symbol: "MIDCPNIFTY",
    label: "Nifty Midcap Select",
    exchange: "NSE",
    patterns: ["NIFTY MID SELECT", "Nifty Midcap Select", "MIDCPNIFTY"],
  },
  {
    symbol: "NIFTYNXT50",
    label: "Nifty Next 50",
    exchange: "NSE",
    patterns: ["Nifty Next 50", "NIFTY NEXT 50"],
  },
  {
    symbol: "NIFTYFPI",
    label: "Nifty India FPI 150",
    exchange: "NSE",
    patterns: ["Nifty India FPI 150", "NIFTY FPI 150", "NIFTYFPI"],
  },
  {
    symbol: "SENSEX",
    label: "S&P BSE SENSEX",
    exchange: "BSE",
    patterns: ["SENSEX"],
  },
  {
    symbol: "BANKEX",
    label: "S&P BSE BANKEX",
    exchange: "BSE",
    patterns: ["BANKEX"],
  },
  {
    symbol: "BSEFIT",
    label: "S&P BSE Focused IT",
    exchange: "BSE",
    patterns: ["BSE FOCUSED IT", "Focused IT", "BSEFIT"],
  },
];

export interface ResolvedUnderlying extends IndexUnderlying {
  instrumentKey: string;
  instrumentId: string;
  resolvedName: string;
}

export interface IndexInstrumentRow {
  id: string;
  provider_instrument_key: string;
  trading_symbol: string;
  name: string;
  segment: string;
}

/** Matches configured underlyings against index instruments loaded from the DB. */
export function resolveUnderlyings(
  wanted: IndexUnderlying[],
  indexRows: IndexInstrumentRow[],
): { resolved: ResolvedUnderlying[]; unresolved: IndexUnderlying[] } {
  const resolved: ResolvedUnderlying[] = [];
  const unresolved: IndexUnderlying[] = [];

  for (const u of wanted) {
    const segment = `${u.exchange}_INDEX`;
    const candidates = indexRows.filter((r) => r.segment === segment);
    let hit: IndexInstrumentRow | undefined;
    for (const pattern of u.patterns) {
      const p = pattern.toLowerCase();
      hit =
        candidates.find(
          (r) =>
            r.name?.toLowerCase() === p ||
            r.trading_symbol?.toLowerCase() === p,
        ) ??
        candidates.find(
          (r) =>
            r.name?.toLowerCase().includes(p) ||
            r.trading_symbol?.toLowerCase().includes(p),
        );
      if (hit) break;
    }
    if (hit) {
      resolved.push({
        ...u,
        instrumentKey: hit.provider_instrument_key,
        instrumentId: hit.id,
        resolvedName: hit.name ?? hit.trading_symbol,
      });
    } else {
      unresolved.push(u);
    }
  }
  return { resolved, unresolved };
}
