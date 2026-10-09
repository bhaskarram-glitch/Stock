/**
 * Job: apply SQL migrations from infra/db/migrations, in filename order, exactly once each.
 *
 * Run: npm run db:migrate            apply pending migrations
 *      npm run db:migrate -- --status  list applied / pending, change nothing
 *
 * Connects with MIGRATION_DATABASE_URL (the schema owner, `stock_migrator`); falls back to
 * DATABASE_URL for single-role dev setups.
 *
 * Safety:
 *   - each file runs in its own transaction; a failure rolls that file back and stops the run
 *   - an advisory lock stops two runs (e.g. two containers starting) from racing
 *   - a sha256 of every applied file is stored; if an applied file is later edited, the run refuses
 *     to continue — write a new migration instead of changing an old one
 */
import "dotenv/config.js";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createDb, type ClosableDb } from "../lib/db.js";
import { logger } from "../lib/logger.js";

const LOCK_ID = 727_001; // arbitrary, unique to this app
const FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;

export interface Migration {
  version: string;
  file: string;
  sql: string;
  checksum: string;
}

/** First existing candidate wins: explicit env, repo layout (npm run from the app dir), Docker image. */
export function findMigrationsDir(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [
    env.MIGRATIONS_DIR,
    path.resolve(process.cwd(), "infra/db/migrations"),
    path.resolve(process.cwd(), "../../infra/db/migrations"),
    "/app/migrations",
  ].filter((p): p is string => Boolean(p));
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(`No migrations directory found. Tried: ${candidates.join(", ")}`);
  }
  return found;
}

export function loadMigrations(dir: string): Migration[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const bad = files.filter((f) => !FILE_PATTERN.test(f));
  if (bad.length > 0) {
    throw new Error(`Migration file names must look like 0002_add_thing.sql: ${bad.join(", ")}`);
  }
  const versions = new Set<string>();
  return files.map((file) => {
    const version = file.slice(0, 4);
    if (versions.has(version)) throw new Error(`Duplicate migration version ${version}`);
    versions.add(version);
    // Normalise line endings so a Windows checkout produces the same checksum as Linux.
    const sql = readFileSync(path.join(dir, file), "utf8").replace(/\r\n/g, "\n");
    return { version, file, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  });
}

async function migrate(db: ClosableDb, migrations: Migration[], statusOnly: boolean): Promise<void> {
  await db.query(`create table if not exists schema_migrations (
    version    text primary key,
    file       text not null,
    checksum   text not null,
    applied_at timestamptz not null default now()
  )`);

  const { rows: applied } = await db.query<{ version: string; file: string; checksum: string }>(
    "select version, file, checksum from schema_migrations order by version",
  );
  const appliedByVersion = new Map(applied.map((r) => [r.version, r]));

  for (const row of applied) {
    const local = migrations.find((m) => m.version === row.version);
    if (!local) throw new Error(`Migration ${row.file} is applied but missing from disk`);
    if (local.checksum !== row.checksum) {
      throw new Error(
        `Migration ${row.file} was edited after it was applied. Revert the edit and add a new migration.`,
      );
    }
  }

  const pending = migrations.filter((m) => !appliedByVersion.has(m.version));
  logger.info("Migration status", {
    applied: applied.map((r) => r.file),
    pending: pending.map((m) => m.file),
  });
  if (statusOnly || pending.length === 0) return;

  for (const m of pending) {
    // pg runs a multi-statement string in one round trip; the explicit transaction makes it atomic.
    try {
      await db.query(`begin;\n${m.sql}\n;\ninsert into schema_migrations (version, file, checksum) values ('${m.version}', '${m.file}', '${m.checksum}');\ncommit;`);
    } catch (error) {
      await db.query("rollback").catch(() => undefined);
      throw new Error(`${m.file} failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`);
    }
    logger.info("Migration applied", { file: m.file });
  }
}

async function main(): Promise<void> {
  const statusOnly = process.argv.includes("--status");
  const url = process.env.MIGRATION_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("Set MIGRATION_DATABASE_URL (or DATABASE_URL)");

  const dir = findMigrationsDir();
  const migrations = loadMigrations(dir);
  logger.info("Migrations found", { dir, count: migrations.length });

  // max: 1 → every query, including the lock, runs on the same session.
  const db = createDb(url, { max: 1, applicationName: "stock-migrate" });
  try {
    const { rows } = await db.query<{ locked: boolean }>("select pg_try_advisory_lock($1) as locked", [LOCK_ID]);
    if (!rows[0]?.locked) throw new Error("Another migration run holds the lock; try again shortly");
    try {
      await migrate(db, migrations, statusOnly);
    } finally {
      await db.query("select pg_advisory_unlock($1)", [LOCK_ID]).catch(() => undefined);
    }
  } finally {
    await db.close();
  }
}

if (process.argv[1] && /migrate\.(ts|js)$/.test(process.argv[1])) {
  main().catch((error) => {
    logger.error("Migration failed", { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
}
