/**
 * In-memory stand-in for lib/db.ts `Db` in unit tests. Records every statement, decodes the
 * INSERTs that upsertRows() builds back into row objects, and answers SELECTs via a callback.
 * Real-SQL behaviour is covered by the integration test against Postgres, not here.
 */
import type { Db, QueryResult } from "../lib/db.js";

type Row = Record<string, unknown>;

export interface FakeDb extends Db {
  /** Rows written per table, in order (one entry per row). */
  inserted(table: string): Row[];
  /** Number of INSERT statements per table (one per upsertRows chunk). */
  insertCalls(table: string): number;
  /** Every statement that was run. */
  statements: { text: string; values: unknown[] }[];
  /** Make the next N statements matching `pattern` throw. */
  failNext(pattern: RegExp, times?: number): void;
}

const INSERT = /^insert into "([a-z_]+)" \(([^)]*)\) values /;

export function fakeDb(
  onSelect: (text: string, values: unknown[]) => Row[] = () => [],
): FakeDb {
  const statements: { text: string; values: unknown[] }[] = [];
  const inserts = new Map<string, Row[][]>();
  const failures: { pattern: RegExp; left: number }[] = [];

  return {
    statements,
    async query<R>(text: string, values: unknown[] = []): Promise<QueryResult<R>> {
      statements.push({ text, values });
      const failure = failures.find((f) => f.left > 0 && f.pattern.test(text));
      if (failure) {
        failure.left -= 1;
        throw new Error("simulated database failure");
      }
      const m = INSERT.exec(text);
      if (m) {
        const cols = m[2].split(", ").map((c) => c.replace(/"/g, ""));
        const rows: Row[] = [];
        for (let i = 0; i < values.length; i += cols.length) {
          rows.push(Object.fromEntries(cols.map((c, j) => [c, values[i + j]])));
        }
        const list = inserts.get(m[1]) ?? [];
        list.push(rows);
        inserts.set(m[1], list);
        return { rows: [] as R[], rowCount: rows.length };
      }
      const rows = /^\s*select/i.test(text) ? onSelect(text, values) : [];
      return { rows: rows as R[], rowCount: rows.length };
    },
    inserted: (table) => (inserts.get(table) ?? []).flat(),
    insertCalls: (table) => (inserts.get(table) ?? []).length,
    failNext(pattern, times = 1) {
      failures.push({ pattern, left: times });
    },
  };
}
