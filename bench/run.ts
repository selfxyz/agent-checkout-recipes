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
import { type RunOptions, type Scenario, type ScenarioResult, runScenario, summarize } from "./lib";

function parseArgs(argv: string[]): { buy: boolean; only?: string[]; maxPrice: number } {
  let buy = false;
  let maxPrice = 3;
  let only: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--buy") buy = true;
    else if (a === "--only") only = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--max-price") {
      const raw = argv[++i] ?? "";
      maxPrice = Number(raw);
      // Fail closed on a mistyped cap (e.g. "$3", ""): a NaN cap makes the
      // `price > maxPrice` guard always false, which would let every priced buy
      // through instead of blocking it.
      if (!Number.isFinite(maxPrice) || maxPrice <= 0) {
        throw new Error(`--max-price must be a positive number (got "${raw}")`);
      }
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
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    return await runScenario(page, scenario, cat, bundle, opts);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ROOT = join(import.meta.dir, "..");
  const scenariosFile = JSON.parse(readFileSync(join(ROOT, "bench/scenarios.json"), "utf8")) as {
    scenarios: Scenario[];
  };
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

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(2);
});
