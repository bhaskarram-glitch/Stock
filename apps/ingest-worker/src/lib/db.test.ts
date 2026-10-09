import { describe, expect, it, vi } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { upsertRows } from "./db.js";
import { fakeDb } from "../test-utils/fake-db.js";

describe("upsertRows", () => {
  it("builds one multi-row upsert that updates non-key columns", async () => {
    const db = fakeDb();
    await upsertRows(
      db,
      "instrument_status",
      [
        { instrument_key: "A", ws_status: "online" },
        { instrument_key: "B", ws_status: "offline" },
      ],
      { conflict: ["instrument_key"] },
    );
    expect(db.statements).toHaveLength(1);
    expect(db.statements[0].text).toBe(
      'insert into "instrument_status" ("instrument_key", "ws_status") values ($1, $2), ($3, $4)' +
        ' on conflict ("instrument_key") do update set "ws_status" = excluded."ws_status"',
    );
    expect(db.statements[0].values).toEqual(["A", "online", "B", "offline"]);
  });

  it("omits undefined columns so DB defaults / existing values survive", async () => {
    const db = fakeDb();
    await upsertRows(
      db,
      "underlying_expiries",
      [{ underlying_key: "U", expiry: "2026-01-01", option_count: undefined, future_count: 5 }],
      { conflict: ["underlying_key", "expiry"] },
    );
    expect(db.statements[0].text).not.toContain("option_count");
    expect(db.statements[0].text).toContain('"future_count" = excluded."future_count"');
  });

  it("uses DO NOTHING for ignoreDuplicates and key-only rows", async () => {
    const db = fakeDb();
    await upsertRows(db, "t", [{ k: 1, v: 2 }], { conflict: ["k"], ignoreDuplicates: true });
    await upsertRows(db, "t", [{ k: 1 }], { conflict: ["k"] });
    expect(db.statements.every((s) => s.text.endsWith("do nothing"))).toBe(true);
  });

  it("dedupes rows sharing a conflict key (last wins) — Postgres rejects duplicates in one statement", async () => {
    const db = fakeDb();
    const sent = await upsertRows(
      db,
      "t",
      [
        { k: "a", v: 1 },
        { k: "a", v: 2 },
        { k: "b", v: 3 },
      ],
      { conflict: ["k"] },
    );
    expect(sent).toBe(2);
    expect(db.inserted("t")).toEqual([
      { k: "a", v: 2 },
      { k: "b", v: 3 },
    ]);
  });

  it("serialises objects/arrays as JSON (jsonb), keeps Dates and nulls", async () => {
    const db = fakeDb();
    const when = new Date("2026-10-09T00:00:00Z");
    await upsertRows(db, "t", [{ k: 1, meta: { a: [1, 2] }, at: when, n: null }], { conflict: ["k"] });
    expect(db.statements[0].values).toEqual([1, '{"a":[1,2]}', when, null]);
  });

  it("chunks under the bind-parameter limit", async () => {
    const db = fakeDb();
    const rows = Array.from({ length: 25_000 }, (_, i) => ({ k: i, a: 1, b: 2, c: 3 }));
    expect(await upsertRows(db, "t", rows, { conflict: ["k"] })).toBe(25_000);
    expect(db.statements.length).toBeGreaterThan(1);
    expect(Math.max(...db.statements.map((s) => s.values.length))).toBeLessThanOrEqual(60_000);
  });

  it("rejects unsafe identifiers, mixed column sets and missing conflict columns", async () => {
    const db = fakeDb();
    await expect(upsertRows(db, "t; drop", [{ k: 1 }], { conflict: ["k"] })).rejects.toThrow(/Unsafe/);
    await expect(
      upsertRows(db, "t", [{ k: 1, a: 1 }, { k: 2 }], { conflict: ["k"] }),
    ).rejects.toThrow(/same columns/);
    await expect(upsertRows(db, "t", [{ a: 1 }], { conflict: ["k"] })).rejects.toThrow(/conflict column/);
    expect(db.statements).toHaveLength(0);
  });
});
