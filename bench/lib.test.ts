import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEVELS, type ScenarioResult, levelRank, summarize } from "./lib";

describe("levels", () => {
  test("are ordered none < reach < detect < cart < fill < buy", () => {
    expect([...LEVELS]).toEqual(["none", "reach", "detect", "cart", "fill", "buy"]);
    expect(levelRank("fill")).toBeGreaterThan(levelRank("cart"));
  });
});

describe("summarize", () => {
  const r = (over: Partial<ScenarioResult>): ScenarioResult => ({
    id: "x",
    url: "https://x",
    target: "fill",
    level: "fill",
    pass: true,
    durationMs: 1,
    ...over,
  });

  test("counts passes and averages progress toward target", () => {
    const s = summarize([
      r({ level: "fill", target: "fill", pass: true }),
      r({ level: "cart", target: "fill", pass: false, blocker: "gateway:paypal-plus-card" }),
    ]);
    expect(s.passed).toBe(1);
    expect(s.total).toBe(2);
    // 1.0 + (cart=3 / fill=4 = 0.75) = 1.75 / 2 = 0.875 -> 0.88
    expect(s.autonomyScore).toBe(0.88);
    expect(s.blockers["gateway:paypal-plus-card"]).toBe(1);
  });

  test("caps per-scenario progress at 1 even if it overshoots target", () => {
    const s = summarize([r({ level: "buy", target: "cart", pass: true })]);
    expect(s.autonomyScore).toBe(1);
  });

  test("a passing dead-end refusal scores full progress despite a low level", () => {
    // A correct PayPal-only/Turnstile refusal only reaches "detect" but IS the
    // right outcome — it must not be scored as partial against its target.
    const s = summarize([r({ level: "detect", target: "cart", pass: true })]);
    expect(s.passed).toBe(1);
    expect(s.autonomyScore).toBe(1);
  });

  test("groups blocker keys by the first two segments", () => {
    const s = summarize([
      r({ pass: false, level: "fill", blocker: "challenge:three_ds,captcha" }),
      r({ pass: false, level: "fill", blocker: "challenge:three_ds" }),
    ]);
    expect(s.blockers["challenge:three_ds,captcha"]).toBe(1);
    expect(s.blockers["challenge:three_ds"]).toBe(1);
  });
});

describe("scenarios.json", () => {
  test("is well-formed and dead-end scenarios don't also allow buying", () => {
    const { scenarios } = JSON.parse(
      readFileSync(join(import.meta.dir, "scenarios.json"), "utf8")
    ) as { scenarios: ScenarioResult[] & { expectDeadEnd?: string; allowBuy?: boolean }[] };
    expect(scenarios.length).toBeGreaterThan(0);
    for (const s of scenarios as any[]) {
      expect(typeof s.id).toBe("string");
      expect(typeof s.url).toBe("string");
      if (s.expectDeadEnd) expect(s.allowBuy).not.toBe(true);
      if (s.allowBuy) expect(typeof s.price).toBe("number");
    }
  });
});
