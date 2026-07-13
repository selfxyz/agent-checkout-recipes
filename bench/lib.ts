// Benchmark library: the autonomy ladder, scenario driving, and outcome
// classification. The runner (run.ts) owns process concerns (CLI, env, report
// files); this module owns per-scenario behavior.
//
// The executable checkout strategies come from the SDK's bundled playbooks —
// the benchmark measures how far THEY get, so it must not fork its own copies.
import {
  type Catalog,
  type Platform,
  addToCart,
  addToCartShopify,
  classifyCheckoutSignals,
  classifyOutcome,
  detectPlatform,
  dismissConsent,
  dismissPopup,
  fillCheckout,
} from "../../packages/agent-sdk/playbooks";
import { recipesForUrl } from "../src/registry";
import type { DeadEndType, MerchantRecipe, RegistryBundle } from "../src/types";

// How far a scenario got, in order. Each level implies the ones before it.
export const LEVELS = ["none", "reach", "detect", "cart", "fill", "buy"] as const;
export type Level = (typeof LEVELS)[number];
export const levelRank = (l: Level): number => LEVELS.indexOf(l);

export interface Scenario {
  id: string;
  // Entry URL: a product page, or the checkout itself for hosted platforms.
  url: string;
  // Force a platform instead of detecting (rarely needed).
  platform?: Platform;
  // The level this scenario is expected to reach unattended.
  target: Exclude<Level, "none" | "reach">;
  // When the site is a known dead-end, the bench PASSES iff it classifies that
  // dead-end (correct refusal is autonomy too).
  expectDeadEnd?: DeadEndType;
  // Order total, forwarded on the card fill (approval thresholds compare it)
  // and used as the buy-mode price guard.
  price?: number;
  currency?: string;
  // buy level runs only when the runner is in buy mode AND this is true.
  allowBuy?: boolean;
  notes?: string;
}

export interface ScenarioResult {
  id: string;
  url: string;
  target: Scenario["target"];
  level: Level;
  // pass = reached target, or correctly classified the expected dead-end.
  pass: boolean;
  // What stopped the run, when it stopped early: "dead-end:<type>",
  // "challenge:<types>", "declined", "gateway:<signal>", "error:<message>".
  blocker?: string;
  platform?: string;
  // Buy mode only: the post-submit classification from classifyOutcome.
  outcome?: string;
  durationMs: number;
  notes?: string;
}

const log = (id: string, msg: string) => console.log(`[${id}] ${msg}`);

// Map a fillCheckout gateway signal / checkout classification to a dead-end
// type, when it is one.
function gatewayDeadEnd(gateway: string): DeadEndType | undefined {
  if (gateway === "turnstile") return "turnstile";
  if (gateway === "paypal-only-no-guest-card") return "paypal-only";
  if (gateway === "stripe-minimum-or-config") return "stripe-config";
  return undefined;
}

// Navigate with the RETRYABLE policy: up to 3 attempts before giving up.
async function gotoWithRetry(page: any, url: string, id: string): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ok = await page
      .goto(url, { waitUntil: "domcontentloaded", timeout: 45000 })
      .then(() => true)
      .catch((e: Error) => {
        log(id, `goto attempt ${attempt} failed: ${e.message.slice(0, 120)}`);
        return false;
      });
    if (ok) return true;
  }
  return false;
}

const timer = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Drive from the entry URL to the checkout/payment surface for the platform.
// Returns true when the flow may proceed to filling (cart seeded / checkout
// page reached); hosted-checkout platforms need no driving.
async function driveToCheckout(
  page: any,
  platform: Platform,
  scenario: Scenario,
  merchant?: MerchantRecipe
): Promise<boolean> {
  const id = scenario.id;
  switch (platform) {
    case "woocommerce": {
      if (!(await addToCart(page, scenario.url, (m) => log(id, m)))) return false;
      const checkout = new URL("/checkout/", scenario.url).toString();
      if (!(await gotoWithRetry(page, checkout, id))) return false;
      await timer(2500);
      return true;
    }
    case "shopify": {
      const how = await addToCartShopify(page, scenario.url, (m) => log(id, m));
      if (!how) return false;
      if (!(await gotoWithRetry(page, new URL("/checkout", scenario.url).toString(), id)))
        return false;
      await timer(3000);
      return true;
    }
    // Hosted checkouts: the entry URL IS the payment surface.
    case "stripe-payment-link":
    case "stripe-checkout":
    case "lemonsqueezy":
    case "gumroad":
    case "paddle":
      return true;
    // Wizard storefronts: click through add-to-cart → checkout; fillCheckout's
    // advanceWizard handles the rest.
    default: {
      const overrides = merchant?.overrides ?? {};
      const addSelectors = [
        overrides.addToCart,
        '[data-hook="add-to-cart-button"]',
        ".snipcart-add-item",
        'button:has-text("Add to Cart")',
        'button:has-text("Add to cart")',
        'button:has-text("Add to Bag")',
        'button:has-text("Buy now")',
      ].filter((s): s is string => Boolean(s));
      for (const sel of addSelectors) {
        const present = await page
          .waitForSelector(sel, { timeout: 1500, state: "visible" })
          .then(() => true)
          .catch(() => false);
        if (!present) continue;
        await page.click(sel, { timeout: 8000 }).catch(() => {});
        log(id, `add-to-cart via ${sel}`);
        await timer(2500);
        break;
      }
      for (const sel of [
        overrides.checkout,
        'a:has-text("Check Out")',
        'a:has-text("Checkout")',
        'button:has-text("Check Out")',
        'button:has-text("Checkout")',
        'a:has-text("Go to Checkout")',
        '[href*="/checkout"]',
      ].filter((s): s is string => Boolean(s))) {
        const present = await page
          .waitForSelector(sel, { timeout: 1500, state: "visible" })
          .then(() => true)
          .catch(() => false);
        if (!present) continue;
        await page.click(sel, { timeout: 8000 }).catch(() => {});
        log(id, `checkout via ${sel}`);
        await timer(3500);
        return true;
      }
      // Some storefronts (Ecwid, Snipcart) open the checkout as an overlay right
      // after add-to-cart; treat a visible card/billing surface as success.
      const signals = await classifyCheckoutSignals(page);
      return signals.stripeInline;
    }
  }
}

export interface RunOptions {
  buy: boolean;
  // Hard cap for any single buy, on top of the per-scenario price (defense in
  // depth under the card's own limits).
  maxBuyPrice: number;
}

// Run one scenario on a fresh page. Never throws — every failure becomes a
// classified result.
export async function runScenario(
  page: any,
  scenario: Scenario,
  cat: Catalog,
  bundle: RegistryBundle,
  opts: RunOptions
): Promise<ScenarioResult> {
  const started = Date.now();
  const id = scenario.id;
  const result = (level: Level, extra: Partial<ScenarioResult> = {}): ScenarioResult => {
    const deadEnd = extra.blocker?.startsWith("dead-end:")
      ? extra.blocker.slice("dead-end:".length)
      : undefined;
    const pass = scenario.expectDeadEnd
      ? deadEnd === scenario.expectDeadEnd
      : levelRank(level) >= levelRank(scenario.target);
    return {
      id,
      url: scenario.url,
      target: scenario.target,
      level,
      pass,
      durationMs: Date.now() - started,
      notes: scenario.notes,
      ...extra,
    };
  };

  try {
    // The registry's verdict for this URL (local bundle — same data the hosted
    // /v1/recipes serves). A recorded dead-end is a result, not an attempt.
    const known = recipesForUrl(bundle, scenario.url);
    if (known.merchant?.deadEnd) {
      log(id, `registry dead-end: ${known.merchant.deadEnd.type}`);
      return result("detect", {
        blocker: `dead-end:${known.merchant.deadEnd.type}`,
        platform: known.merchant.platform,
      });
    }

    if (!(await gotoWithRetry(page, scenario.url, id))) {
      return result("none", { blocker: "error:navigation failed after 3 attempts" });
    }
    await dismissConsent(page);
    await dismissPopup(page);

    const platform =
      scenario.platform ??
      (known.merchant?.platform as Platform | undefined) ??
      (known.platform?.id as Platform | undefined) ??
      (await detectPlatform(page));
    log(id, `platform: ${platform}`);
    if (platform === "unknown") return result("reach", { blocker: "error:platform unknown" });

    if (!(await driveToCheckout(page, platform, scenario, known.merchant))) {
      return result("detect", { platform, blocker: "error:could not reach checkout" });
    }

    // Buy mode submits any scenario flagged `allowBuy` (independent of target —
    // e.g. a target:"fill" scenario can still be a real-money buy candidate).
    const wantBuy = opts.buy && scenario.allowBuy === true;
    if (wantBuy) {
      if (scenario.price === undefined || scenario.price > opts.maxBuyPrice) {
        return result("cart", {
          platform,
          blocker: `error:buy blocked by price guard (price=${scenario.price}, cap=${opts.maxBuyPrice})`,
        });
      }
      // NOTE: this cap checks the scenario's DECLARED price only. The SDK exposes
      // no text extraction (page.evaluate is disabled for security), so the
      // benchmark cannot read the live checkout total to catch a merchant price
      // hike or added shipping/tax. The authoritative over-cap protection is the
      // proxy enforcing the FUNDING CARD's server-side controls (perTxnCap /
      // confirmAbove) against the amount it scrapes from the top page — which is
      // why the declared amount/currency is forwarded on the fill below. Keep a
      // low --max-price AND a funding card with a tight perTxnCap for buy runs.
      log(
        id,
        `BUY mode: submitting once (declared ${scenario.price} ${scenario.currency ?? "USD"})`
      );
    }

    const filled = await fillCheckout(page, platform, cat, {
      log: (m) => log(id, m),
      place: wantBuy,
      amount: scenario.price,
      currency: scenario.currency,
    });

    if (!filled.filled) {
      const gateway = filled.gateway ?? "unknown";
      const deadEnd = gatewayDeadEnd(gateway);
      return result("cart", {
        platform,
        blocker: deadEnd ? `dead-end:${deadEnd}` : `gateway:${gateway}`,
      });
    }
    if (filled.gateway === "place-order-failed") {
      return result("fill", { platform, blocker: "error:place-order click failed" });
    }
    if (!wantBuy) return result("fill", { platform });

    const outcome = await classifyOutcome(page, 90000);
    log(id, `outcome: ${outcome}`);
    if (outcome === "SUCCESS") return result("buy", { platform, outcome });
    if (outcome.startsWith("CHALLENGE"))
      return result("fill", { platform, outcome, blocker: `challenge:${outcome.slice(10)}` });
    return result("fill", { platform, outcome, blocker: outcome.toLowerCase() });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const code = (e as { code?: string }).code;
    // A CVV refusal means the fill reached the CVV leg (number + expiry already
    // landed) and stopped for the owner to enter the code live — the furthest
    // unattended autonomy reaches, so this is a "fill". Match the code and the
    // prose message (the proxy flattens the code to "error" on some frame-fill
    // paths, but the message is stable).
    if (
      code === "cvv_entry_required" ||
      /cvv_entry_required|security code \(CVV\)|Live CVV entry/i.test(message)
    ) {
      return result("fill", { blocker: "challenge:cvv_entry_required" });
    }
    return result("none", { blocker: `error:${code ?? message.slice(0, 160)}` });
  }
}

// Aggregate results into the report scores.
export function summarize(results: ScenarioResult[]): {
  passed: number;
  total: number;
  autonomyScore: number;
  blockers: Record<string, number>;
} {
  const blockers: Record<string, number> = {};
  let depth = 0;
  for (const r of results) {
    if (r.blocker) {
      const key = r.blocker.split(":").slice(0, 2).join(":");
      blockers[key] = (blockers[key] ?? 0) + 1;
    }
    depth += Math.min(1, levelRank(r.level) / levelRank(r.target));
  }
  const passed = results.filter((r) => r.pass).length;
  return {
    passed,
    total: results.length,
    // Mean of per-scenario progress toward its target (1 = reached it), so a
    // run that stalls at "cart" everywhere scores better than one that can't
    // even detect platforms — pass-rate alone would hide that difference.
    autonomyScore: results.length ? Math.round((depth / results.length) * 100) / 100 : 0,
    blockers,
  };
}
