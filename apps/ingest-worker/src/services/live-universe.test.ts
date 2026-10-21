import { describe, expect, it } from "vitest";
import { describeDropped, planShards, type LiveInstrument } from "./live-universe.js";

const inst = (feedKey: string, kind: LiveInstrument["kind"], expiry: string | null): LiveInstrument => ({
  feedKey, storeKey: feedKey, sid: 1, kind, underlyingKey: "U", expiry,
});

describe("planShards", () => {
  const universe = [
    inst("opt-far", "option", "2026-12-31"),
    inst("opt-near", "option", "2026-10-20"),
    inst("fut", "future", "2026-10-27"),
    inst("spot", "spot", null),
    inst("opt-mid", "option", "2026-11-24"),
    inst("spot", "spot", null), // duplicate key is counted once
  ];

  it("keeps spot > futures > nearest options and drops the farthest expiries", () => {
    const plan = planShards(universe, ["a", "b"], 2);
    expect(plan.capacity).toBe(4);
    expect(plan.dropped.map((d) => d.feedKey)).toEqual(["opt-far"]);
    const all = [...plan.shards.values()].flat().map((i) => i.feedKey);
    expect(all.sort()).toEqual(["fut", "opt-mid", "opt-near", "spot"]);
  });

  it("deals instruments out round-robin and never over the per-account limit", () => {
    const plan = planShards(universe, ["a", "b", "c"], 2);
    expect(plan.dropped).toHaveLength(0);
    expect(plan.shards.get("a")!.map((i) => i.feedKey)).toEqual(["spot", "opt-mid"]);
    expect(plan.shards.get("b")!.map((i) => i.feedKey)).toEqual(["fut", "opt-far"]);
    expect(plan.shards.get("c")!.map((i) => i.feedKey)).toEqual(["opt-near"]);
    for (const s of plan.shards.values()) expect(s.length).toBeLessThanOrEqual(2);
  });

  it("keeps recently traded options ahead of never-traded nearer ones", () => {
    const plan = planShards(
      [
        inst("near-dead", "option", "2026-10-20"),
        { ...inst("far-liquid", "option", "2027-12-28"), recentlyTraded: true },
        inst("spot", "spot", null),
      ],
      ["a"],
      2,
    );
    expect(plan.shards.get("a")!.map((i) => i.feedKey)).toEqual(["spot", "far-liquid"]);
    expect(plan.dropped.map((d) => d.feedKey)).toEqual(["near-dead"]);
  });

  it("needs at least one account", () => {
    expect(() => planShards(universe, [])).toThrow();
  });

  it("describes what was dropped", () => {
    const plan = planShards(universe, ["a"], 2);
    expect(describeDropped(plan.dropped)).toEqual({
      dropped: 3,
      recentlyTraded: 0,
      kinds: { spot: 0, future: 0, option: 3 },
      expiriesFrom: "2026-10-20",
      expiriesTo: "2026-12-31",
    });
    expect(describeDropped([])).toEqual({ dropped: 0 });
  });
});
