/**
 * Postgres access for the worker and jobs (replaces supabase-js, Phase H4).
 *
 * - One pool per process, from DATABASE_URL (the least-privileged `stock_app` role).
 * - Migrations use MIGRATION_DATABASE_URL (`stock_migrator`) via createDb() — see jobs/migrate.ts.
 * - Services depend on the small `Db` interface, not on pg, so tests can pass a fake.
 */
import pg from "pg";
import { logger } from "./logger.js";

// DATE → keep "YYYY-MM-DD" strings (pg's default builds a local-time Date, which shifts the day).
pg.types.setTypeParser(1082, (v) => v);
// BIGINT (count(*) etc.) → number. Safe for row counts; never used for money.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

export interface QueryResult<R> {
  rows: R[];
  rowCount: number | null;
}

export interface Db {
  query<R = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

export interface ClosableDb extends Db {
  close(): Promise<void>;
}

export function createDb(
  connectionString: string,
  options: { max?: number; applicationName?: string } = {},
): ClosableDb {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: options.applicationName ?? "stock-worker",
  });
  // An idle client losing its connection emits here; unhandled, it would crash the process.
  pool.on("error", (error) => {
    logger.error("Postgres pool error", { error: error.message });
  });
  return {
    query: async <R>(text: string, values?: unknown[]) => {
      const result = await pool.query(text, values);
      return { rows: result.rows as R[], rowCount: result.rowCount };
    },
    close: () => pool.end(),
  };
}

let shared: ClosableDb | null = null;

/** Process-wide pool from DATABASE_URL. */
export function getDb(): ClosableDb {
  if (shared) return shared;
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "Missing DATABASE_URL (e.g. postgresql://stock_app:<pw>@127.0.0.1:5432/stock)",
    );
  }
  shared = createDb(url);
  return shared;
}

export async function closeDb(): Promise<void> {
  if (!shared) return;
  const db = shared;
  shared = null;
  await db.close();
}

// ---------------------------------------------------------------------------
// Bulk upsert
// ---------------------------------------------------------------------------

const IDENT = /^[a-z_][a-z0-9_]*$/;
const MAX_PARAMS = 60_000; // Postgres hard limit is 65,535 bind parameters per statement

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`);
  return `"${name}"`;
}

function toParam(value: unknown): unknown {
  if (value === null || value instanceof Date) return value;
  // pg would turn JS arrays into Postgres arrays; every structured value here is jsonb.
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

export interface UpsertOptions {
  /** Columns of the unique constraint / primary key that defines a duplicate. */
  conflict: string[];
  /** true → keep the existing row untouched (ON CONFLICT DO NOTHING). Default: update every other column. */
  ignoreDuplicates?: boolean;
}

/**
 * INSERT … ON CONFLICT for many rows, chunked under the bind-parameter limit.
 * Columns come from the first row; keys whose value is `undefined` are omitted (the column keeps its
 * DB default on insert and its current value on update), so every row must use the same keys.
 * @returns number of rows sent.
 */
export async function upsertRows(
  db: Db,
  table: string,
  rows: Record<string, unknown>[],
  options: UpsertOptions,
): Promise<number> {
  if (rows.length === 0) return 0;
  const columns = Object.keys(rows[0]).filter((k) => rows[0][k] !== undefined);
  if (columns.length === 0) throw new Error(`upsertRows(${table}): no columns`);
  for (const row of rows) {
    const keys = Object.keys(row).filter((k) => row[k] !== undefined);
    if (keys.length !== columns.length || keys.some((k) => !columns.includes(k))) {
      throw new Error(`upsertRows(${table}): every row must have the same columns`);
    }
  }

  for (const c of options.conflict) {
    if (!columns.includes(c)) throw new Error(`upsertRows(${table}): conflict column "${c}" missing from rows`);
  }
  // One statement may not touch the same key twice ("cannot affect row a second time"): last row wins.
  const byKey = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    byKey.set(JSON.stringify(options.conflict.map((c) => row[c])), row);
  }
  rows = Array.from(byKey.values());

  const updates = columns.filter((c) => !options.conflict.includes(c));
  const onConflict =
    options.ignoreDuplicates || updates.length === 0
      ? "do nothing"
      : `do update set ${updates.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(", ")}`;
  const head =
    `insert into ${ident(table)} (${columns.map(ident).join(", ")}) values `;
  const tail = ` on conflict (${options.conflict.map(ident).join(", ")}) ${onConflict}`;

  const perChunk = Math.max(1, Math.floor(MAX_PARAMS / columns.length));
  let sent = 0;
  for (let i = 0; i < rows.length; i += perChunk) {
    const chunk = rows.slice(i, i + perChunk);
    const values: unknown[] = [];
    const tuples = chunk.map((row) => {
      const placeholders = columns.map((c) => {
        values.push(toParam(row[c]));
        return `$${values.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    await db.query(head + tuples.join(", ") + tail, values);
    sent += chunk.length;
  }
  return sent;
}
