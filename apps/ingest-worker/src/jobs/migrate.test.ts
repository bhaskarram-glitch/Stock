import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { findMigrationsDir, loadMigrations } from "./migrate.js";

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mig-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
  return dir;
}

describe("loadMigrations", () => {
  it("orders by file name and checksums the content", () => {
    const dir = dirWith({ "0002_b.sql": "select 2;", "0001_a.sql": "select 1;" });
    const m = loadMigrations(dir);
    expect(m.map((x) => x.version)).toEqual(["0001", "0002"]);
    expect(m[0].checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives the same checksum for CRLF and LF checkouts", () => {
    const lf = loadMigrations(dirWith({ "0001_a.sql": "select 1;\nselect 2;\n" }));
    const crlf = loadMigrations(dirWith({ "0001_a.sql": "select 1;\r\nselect 2;\r\n" }));
    expect(crlf[0].checksum).toBe(lf[0].checksum);
  });

  it("rejects badly named files and duplicate versions", () => {
    expect(() => loadMigrations(dirWith({ "init.sql": "" }))).toThrow(/names/);
    expect(() => loadMigrations(dirWith({ "0001_a.sql": "", "0001_b.sql": "" }))).toThrow(/Duplicate/);
  });

  it("finds the repo's migrations directory and its init file", () => {
    const dir = findMigrationsDir({});
    expect(loadMigrations(dir)[0].file).toBe("0001_init.sql");
  });
});
