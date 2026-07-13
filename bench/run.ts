// Autonomy benchmark runner.
//
// Measures how far Agent Pay + the playbooks get on real checkouts, WITHOUT
// spending money by default. It runs the recon → classify → playbook fill path
// on each scenario and scores where it stopped.
//
//   bun run bench                 # dry: reach → fill (never submits)
//   bun run bench -- --buy        # buy: also SUBMIT scenarios flagged allowBuy,
//                                 #   capped at --max-price (default $3)
//   bun run bench -- --only brushespack-woo,sanjosestickers-bigcartel
//   bun run bench -- --max-price 2
//
// Needs a live proxy + a seeded card, exactly like the demos:
//   SELF_AGENT_PAY_API_KEY, SELF_AGENT_PAY_PROXY_URL, SELF_AGENT_PAY_API_URL.
// Real BUYs settle real money — keep them tiny and verify via the merchant
// email receipt, never a confirmation page.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listTokens, tokensForUrl } from "@selfxyz/agent-pay-playwright";
import { catalogFromTokens, chromium } from "@selfxyz/agent-pay-playwright/playbooks.ts";
import { buildBundle, loadRecipes } from "../src/registry";
import { DEAD_END_TYPES } from "../src/types";
import { type RunOptions, type Scenario, type ScenarioResult, runScenario, summarize } from "./lib";

// Valid `target` levels (the reachable subset — "none"/"reach" aren't targets).
const TARGETS = ["detect", "cart", "fill", "buy"] as const;

// Validate contributor-edited scenarios BEFORE running: a bad `target` (typo or
// omission) would make levelRank(target) === -1, so any reached level would
// satisfy the pass check and a broken scenario would report full progress.
function validateScenarios(scenarios: Scenario[]): void {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const s of scenarios) {
    const at = s?.id ? `scenario "${s.id}"` : "a scenario";
    if (!s?.id || typeof s.id !== "string") problems.push(`${at}: missing string id`);
    else if (seen.has(s.id)) problems.push(`duplicate scenario id "${s.id}"`);
    else seen.add(s.id);
    if (typeof s?.url !== "string" || !s.url) problems.push(`${at}: missing url`);
    if (!(TARGETS as readonly string[]).includes(s?.target))
      problems.push(
        `${at}: target must be one of ${TARGETS.join(", ")} (got ${JSON.stringify(s?.target)})`
      );
    if (s?.expectDeadEnd !== undefined && !DEAD_END_TYPES.includes(s.expectDeadEnd))
      problems.push(`${at}: expectDeadEnd must be one of ${DEAD_END_TYPES.join(", ")}`);
    if (
      s?.price !== undefined &&
      (typeof s.price !== "number" || !Number.isFinite(s.price) || s.price <= 0)
    )
      problems.push(`${at}: price must be a positive finite number`);
    // Buy-mode invariants — this spends REAL money, so fail closed here rather
    // than let a bad scenario reach a live submit.
    if (s?.allowBuy === true) {
      if (typeof s?.price !== "number" || !Number.isFinite(s.price) || s.price <= 0)
        problems.push(`${at}: allowBuy requires a positive finite price`);
      // The --max-price cap is USD and the bench can't read the live total to
      // convert, so a non-USD priced buy could exceed the intended dollar cap.
      if (s?.currency !== undefined && s.currency.toUpperCase() !== "USD")
        problems.push(`${at}: allowBuy scenarios must be priced in USD (got ${s.currency})`);
      // A scenario that's both a dead-end AND buyable would submit real money if
      // the expected blocker isn't detected live (site changed / classifier miss).
      if (s?.expectDeadEnd !== undefined)
        problems.push(`${at}: a scenario cannot be both allowBuy and expectDeadEnd`);
    }
  }
  if (problems.length) throw new Error(`invalid bench/scenarios.json:\n  ${problems.join("\n  ")}`);
}

function parseArgs(argv: string[]): { buy: boolean; only?: string[]; maxPrice: number } {
  let buy = false;
  let maxPrice = 3;
  let only: string[] | undefined;
  // Accept both `--flag value` and `--flag=value`. Fail CLOSED on any unknown
  // flag: silently ignoring a misspelled/`--max-price=1`-style cap would let a
  // buy run fall back to the default $3 ceiling unnoticed.
  const takeValue = (a: string, i: { v: number }): string => {
    const eq = a.indexOf("=");
    if (eq !== -1) return a.slice(eq + 1);
    return argv[++i.v] ?? "";
  };
  const idx = { v: 0 };
  for (idx.v = 0; idx.v < argv.length; idx.v++) {
    const a = argv[idx.v];
    if (a === undefined) continue;
    const name = a.startsWith("--") ? a.split("=")[0] : a;
    if (name === "--buy") {
      // A boolean flag takes no value: reject `--buy=false` / `--buy=0` rather
      // than silently enabling real-money submits despite an intent to disable.
      if (a.includes("=")) throw new Error(`--buy takes no value (got "${a}")`);
      buy = true;
    } else if (name === "--only") only = takeValue(a, idx).split(",").filter(Boolean);
    else if (name === "--max-price") {
      const raw = takeValue(a, idx);
      maxPrice = Number(raw);
      // Fail closed on a mistyped cap (e.g. "$3", ""): a NaN cap makes the
      // `price > maxPrice` guard always false, which would let every priced buy
      // through instead of blocking it.
      if (!Number.isFinite(maxPrice) || maxPrice <= 0) {
        throw new Error(`--max-price must be a positive number (got "${raw}")`);
      }
    } else {
      throw new Error(`unknown argument "${a}" (supported: --buy, --only <ids>, --max-price <n>)`);
    }
  }
  return { buy, only, maxPrice };
}

// Run one scenario on a fresh browser, always closing it.
async function runOnce(
  scenario: Scenario,
  cat: ReturnType<typeof catalogFromTokens>,
  bundle: ReturnType<typeof buildBundle>,
  opts: RunOptions
): Promise<ScenarioResult> {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    return await runScenario(page, scenario, cat, bundle, opts);
  } catch (e) {
    // A browser-setup failure (cold-start launch / context closed) must become a
    // classified, retryable result — not escape and abort the whole run. Genuine
    // configuration errors (no API key / no cards) are thrown earlier in main(),
    // before any scenario, so they still abort.
    const msg = e instanceof Error ? e.message : String(e);
    return {
      id: scenario.id,
      url: scenario.url,
      target: scenario.target,
      level: "none",
      pass: false,
      blocker: `error:setup browser ${msg.slice(0, 120)}`,
      durationMs: 0,
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ROOT = join(import.meta.dir, "..");
  const scenariosFile = JSON.parse(readFileSync(join(ROOT, "bench/scenarios.json"), "utf8")) as {
    scenarios: Scenario[];
  };
  validateScenarios(scenariosFile.scenarios);
  let scenarios = scenariosFile.scenarios;
  if (args.only) scenarios = scenarios.filter((s) => args.only?.includes(s.id));
  if (scenarios.length === 0) throw new Error("no scenarios selected");

  const bundle = buildBundle(loadRecipes(), "bench");

  // One shared catalog for the run (identity + first card + billing address).
  const catalog = await listTokens();
  if (!catalog.cards.length) {
    throw new Error("token catalog has no cards — seed a card before benchmarking");
  }

  const opts: RunOptions = { buy: args.buy, maxBuyPrice: args.maxPrice };
  console.log(
    `Benchmark: ${scenarios.length} scenario(s), mode=${args.buy ? "BUY" : "dry"}, maxPrice=$${args.maxPrice}\n`
  );

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    // Per-scenario catalog: use the card registered for the merchant when there
    // is one; otherwise prefer an UNSCOPED (general-purpose) card. A card scoped
    // to another merchant would be rejected by the proxy as merchant_blocked, so
    // falling back to the raw catalog[0] would make the result depend on catalog
    // ordering. Unscoped cards have no `websites`.
    const unscoped = catalog.cards.filter((c) => !c.websites || c.websites.length === 0);
    let cat = catalogFromTokens(unscoped.length ? { ...catalog, cards: unscoped } : catalog);
    try {
      const scoped = await tokensForUrl(scenario.url, { catalog });
      if (scoped.cards.length) cat = catalogFromTokens({ ...catalog, cards: scoped.cards });
    } catch {
      /* keep the unscoped-preferred catalog */
    }

    // Fresh browser per scenario so a wedged page never taints the next. Retry
    // once on a transient infra error (a cold-start browser/context that closed
    // under us) — a genuine site blocker classifies without throwing, so it is
    // not retried.
    let result = await runOnce(scenario, cat, bundle, opts);
    if (result.level === "none" && /page|context|browser|pageId/i.test(result.blocker ?? "")) {
      console.log(`  … transient infra error, retrying ${scenario.id}`);
      result = await runOnce(scenario, cat, bundle, opts);
    }

    results.push(result);
    const mark = result.pass ? "PASS" : "FAIL";
    console.log(
      `  ${mark}  ${result.id.padEnd(32)} ${result.level.padEnd(6)} ` +
        `${result.blocker ?? result.outcome ?? ""}`
    );
  }

  const summary = summarize(results);
  console.log(
    `\n${summary.passed}/${summary.total} passed · autonomy score ${summary.autonomyScore}`
  );
  if (Object.keys(summary.blockers).length) {
    console.log("blockers:");
    for (const [k, n] of Object.entries(summary.blockers).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${n}×  ${k}`);
    }
  }

  const report = {
    // Timestamp is stamped by the caller's shell (BENCH_STAMP) so the module
    // stays deterministic; falls back to a fixed marker when unset.
    ranAt: process.env.BENCH_STAMP ?? "unknown",
    mode: args.buy ? "buy" : "dry",
    summary,
    results,
  };
  const outPath = join(ROOT, "bench/last-run.json");
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nreport → ${outPath}`);

  // Non-zero exit when any scenario failed, so CI/automation can gate on it.
  process.exit(summary.passed === summary.total ? 0 : 1);
}

// Run only when invoked directly (not when imported by a test).
if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.stack : e);
    process.exit(2);
  });
}

export { parseArgs, validateScenarios };
