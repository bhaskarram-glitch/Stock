import { describe, expect, it } from "vitest";
import {
  FNO_INDEX_UNDERLYINGS,
  resolveUnderlyings,
  type IndexInstrumentRow,
} from "./indices.js";

const rows: IndexInstrumentRow[] = [
  {
    id: "1",
    provider_instrument_key: "NSE_INDEX|Nifty 50",
    trading_symbol: "Nifty 50",
    name: "Nifty 50",
    segment: "NSE_INDEX",
  },
  {
    id: "2",
    provider_instrument_key: "NSE_INDEX|Nifty Bank",
    trading_symbol: "Nifty Bank",
    name: "Nifty Bank",
    segment: "NSE_INDEX",
  },
  {
    id: "3",
    provider_instrument_key: "BSE_INDEX|SENSEX",
    trading_symbol: "SENSEX",
    name: "SENSEX",
    segment: "BSE_INDEX",
  },
  {
    id: "4",
    provider_instrument_key: "NSE_EQ|SENSEXTRAP",
    trading_symbol: "SENSEX TRAP",
    name: "SENSEX lookalike",
    segment: "NSE_EQ",
  },
];

describe("resolveUnderlyings", () => {
  it("matches exact names and respects the exchange segment", () => {
    const { resolved, unresolved } = resolveUnderlyings(
      FNO_INDEX_UNDERLYINGS.filter((u) =>
        ["NIFTY", "BANKNIFTY", "SENSEX"].includes(u.symbol),
      ),
      rows,
    );
    expect(resolved.map((r) => r.symbol)).toEqual([
      "NIFTY",
      "BANKNIFTY",
      "SENSEX",
    ]);
    expect(resolved.find((r) => r.symbol === "SENSEX")?.instrumentKey).toBe(
      "BSE_INDEX|SENSEX",
    );
    expect(unresolved).toHaveLength(0);
  });

  it("reports underlyings it cannot find instead of guessing", () => {
    const { resolved, unresolved } = resolveUnderlyings(
      FNO_INDEX_UNDERLYINGS,
      rows,
    );
    expect(resolved).toHaveLength(3);
    expect(unresolved.map((u) => u.symbol)).toEqual([
      "FINNIFTY",
      "MIDCPNIFTY",
      "NIFTYNXT50",
      "NIFTYFPI",
      "BANKEX",
      "BSEFIT",
    ]);
  });

  it("falls back to substring matching", () => {
    const { resolved } = resolveUnderlyings(
      [
        {
          symbol: "BSEFIT",
          label: "Focused IT",
          exchange: "BSE",
          patterns: ["Focused IT"],
        },
      ],
      [
        {
          id: "9",
          provider_instrument_key: "BSE_INDEX|BSE FOCUSED IT",
          trading_symbol: "BSEFIT",
          name: "S&P BSE Focused IT Index",
          segment: "BSE_INDEX",
        },
      ],
    );
    expect(resolved[0]?.instrumentKey).toBe("BSE_INDEX|BSE FOCUSED IT");
  });
});
