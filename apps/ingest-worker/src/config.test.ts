import { describe, expect, it } from "vitest";
import { describeAccount, loadConfig } from "./config.js";

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

  it("uses the single default base URL", () => {
    expect(loadConfig({ ...base }).upstoxBaseUrl).toBe(
      "https://api.upstox.com",
    );
  });
});

describe("Upstox accounts — legacy vars", () => {
  it("builds accounts from UPSTOX_ACCESS_TOKEN / UPSTOX_ANALYTICS_TOKEN", () => {
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
  });

  it("require() explains what is missing", () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.upstoxAccounts.first("ws")).toBeNull();
    expect(() => cfg.upstoxAccounts.require("hist")).toThrow(
      /UPSTOX_ACCOUNT_<n>_TOKEN.*UPSTOX_ANALYTICS_TOKEN/,
    );
  });
});

describe("Upstox accounts — numbered vars", () => {
  it("reads five accounts with defaults (roles hist,ws; plus false)", () => {
    const env: Record<string, string> = { ...base };
    for (let n = 1; n <= 5; n++) env[`UPSTOX_ACCOUNT_${n}_TOKEN`] = `tok-${n}`;
    const cfg = loadConfig(env);
    expect(cfg.upstoxAccounts.all).toHaveLength(5);
    expect(cfg.upstoxAccounts.forRole("hist").map((a) => a.alias)).toEqual([
      "account-1",
      "account-2",
      "account-3",
      "account-4",
      "account-5",
    ]);
    expect(
      cfg.upstoxAccounts.all.every(
        (a) => a.roles.join() === "hist,ws" && !a.plus,
      ),
    ).toBe(true);
  });

  it("honours alias, roles, plus, and allows gaps", () => {
    const cfg = loadConfig({
      ...base,
      UPSTOX_ACCOUNT_1_TOKEN: "t1",
      UPSTOX_ACCOUNT_1_ALIAS: "main",
      UPSTOX_ACCOUNT_1_ROLES: "ws,trade",
      UPSTOX_ACCOUNT_1_PLUS: "true",
      UPSTOX_ACCOUNT_3_TOKEN: "t3",
      UPSTOX_ACCOUNT_3_ROLES: "hist",
    });
    expect(cfg.upstoxAccounts.all.map((a) => a.alias)).toEqual([
      "main",
      "account-3",
    ]);
    expect(cfg.upstoxAccounts.first("trade")?.plus).toBe(true);
    expect(cfg.upstoxAccounts.forRole("hist").map((a) => a.alias)).toEqual([
      "account-3",
    ]);
  });

  it("takes precedence over legacy vars (sources are never merged)", () => {
    const cfg = loadConfig({
      ...base,
      UPSTOX_ANALYTICS_TOKEN: "legacy",
      UPSTOX_ACCOUNT_1_TOKEN: "n1",
    });
    expect(cfg.upstoxAccounts.all.map((a) => a.token)).toEqual(["n1"]);
  });

  it("is overridden by UPSTOX_ACCOUNTS JSON", () => {
    const cfg = loadConfig({
      ...base,
      UPSTOX_ACCOUNT_1_TOKEN: "n1",
      UPSTOX_ACCOUNTS: JSON.stringify([
        { alias: "j", token: "j1", roles: ["hist"] },
      ]),
    });
    expect(cfg.upstoxAccounts.all.map((a) => a.alias)).toEqual(["j"]);
  });

  it("rejects a half-configured slot, bad roles, and a reused token", () => {
    expect(() => loadConfig({ ...base, UPSTOX_ACCOUNT_2_ALIAS: "x" })).toThrow(
      /UPSTOX_ACCOUNT_2_TOKEN is missing/,
    );
    expect(() =>
      loadConfig({
        ...base,
        UPSTOX_ACCOUNT_1_TOKEN: "t",
        UPSTOX_ACCOUNT_1_ROLES: "hist,bogus",
      }),
    ).toThrow(/unknown role/);
    expect(() =>
      loadConfig({
        ...base,
        UPSTOX_ACCOUNT_1_TOKEN: "same",
        UPSTOX_ACCOUNT_2_TOKEN: "same",
      }),
    ).toThrow(/reuses a token/);
    expect(() =>
      loadConfig({
        ...base,
        UPSTOX_ACCOUNT_1_TOKEN: "a",
        UPSTOX_ACCOUNT_1_ALIAS: "dup",
        UPSTOX_ACCOUNT_2_TOKEN: "b",
        UPSTOX_ACCOUNT_2_ALIAS: "dup",
      }),
    ).toThrow(/Duplicate Upstox account alias/);
  });
});

describe("Upstox accounts — JSON", () => {
  it("validates entries", () => {
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
    ).toThrow(/unknown role/);
  });
});

describe("describeAccount", () => {
  it("never exposes the token", () => {
    const d = describeAccount({
      alias: "a",
      token: "secret-token-abcdef",
      roles: ["hist"],
      plus: true,
    });
    expect(JSON.stringify(d)).not.toContain("secret-token");
    expect(d.token).toBe("…abcdef");
  });
});
