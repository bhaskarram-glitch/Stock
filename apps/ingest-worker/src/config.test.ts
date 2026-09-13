import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const base = {
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "k",
};

describe("loadConfig", () => {
  it("defaults to healthcheck and rejects unknown modes", () => {
    expect(loadConfig({ ...base }).workerMode).toBe("healthcheck");
    expect(
      loadConfig({ ...base, WORKER_MODE: "websocket-stream" }).workerMode,
    ).toBe("websocket-stream");
    expect(() => loadConfig({ ...base, WORKER_MODE: "upstox-quote" })).toThrow(
      /Invalid WORKER_MODE/,
    );
  });

  it("builds accounts from legacy single-token vars", () => {
    const cfg = loadConfig({
      ...base,
      UPSTOX_ACCESS_TOKEN: "a",
      UPSTOX_ANALYTICS_TOKEN: "b",
    });
    expect(cfg.upstoxAccounts.all.map((a) => a.alias)).toEqual([
      "primary",
      "analytics",
    ]);
    expect(cfg.upstoxAccounts.require("ws").token).toBe("a");
    expect(cfg.upstoxAccounts.require("hist").token).toBe("b");
    expect(cfg.upstoxAccessToken).toBe("a");
  });

  it("parses UPSTOX_ACCOUNTS and prefers it over legacy vars", () => {
    const cfg = loadConfig({
      ...base,
      UPSTOX_ACCESS_TOKEN: "ignored",
      UPSTOX_ACCOUNTS: JSON.stringify([
        { alias: "plus-1", token: "t1", roles: ["ws", "trade"], plus: true },
        { alias: "plus-2", token: "t2", roles: ["hist", "ws"] },
      ]),
    });
    expect(cfg.upstoxAccounts.all).toHaveLength(2);
    expect(cfg.upstoxAccounts.forRole("ws").map((a) => a.alias)).toEqual([
      "plus-1",
      "plus-2",
    ]);
    expect(cfg.upstoxAccounts.first("trade")?.plus).toBe(true);
    expect(cfg.upstoxAccessToken).toBe("t1");
  });

  it("validates UPSTOX_ACCOUNTS entries", () => {
    expect(() => loadConfig({ ...base, UPSTOX_ACCOUNTS: "nope" })).toThrow(
      /not valid JSON/,
    );
    expect(() => loadConfig({ ...base, UPSTOX_ACCOUNTS: "[]" })).toThrow(
      /non-empty/,
    );
    expect(() =>
      loadConfig({
        ...base,
        UPSTOX_ACCOUNTS: JSON.stringify([{ alias: "a", roles: ["ws"] }]),
      }),
    ).toThrow(/missing "token"/);
    expect(() =>
      loadConfig({
        ...base,
        UPSTOX_ACCOUNTS: JSON.stringify([
          { alias: "a", token: "t", roles: ["bogus"] },
        ]),
      }),
    ).toThrow(/at least one role/);
    expect(() =>
      loadConfig({
        ...base,
        UPSTOX_ACCOUNTS: JSON.stringify([
          { alias: "a", token: "t", roles: ["ws"] },
          { alias: "a", token: "u", roles: ["ws"] },
        ]),
      }),
    ).toThrow(/duplicate alias/);
  });

  it("require() explains what env var is missing", () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.upstoxAccounts.first("ws")).toBeNull();
    expect(() => cfg.upstoxAccounts.require("hist")).toThrow(
      /UPSTOX_ANALYTICS_TOKEN/,
    );
    expect(() => cfg.upstoxAccounts.require("ws")).toThrow(
      /UPSTOX_ACCESS_TOKEN/,
    );
  });

  it("uses the single default base URL", () => {
    expect(loadConfig({ ...base }).upstoxBaseUrl).toBe(
      "https://api.upstox.com",
    );
  });
});
