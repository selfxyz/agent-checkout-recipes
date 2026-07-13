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
} from "@selfxyz/agent-pay-playwright/playbooks.ts";
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
    // Hosted / overlay checkouts (Stripe Checkout & Payment Links, Lemon Squeezy,
    // Paddle, Gumroad): the entry URL may already BE the hosted checkout, or a
    // merchant `/buy` link may have redirected to it, or it may be a product page
    // that needs a Buy/Checkout click. The SDK exposes no page.url() to tell which
    // (a redirect wouldn't be visible in scenario.url anyway), so PROBE the DOM
    // for an actual PAYMENT SURFACE — NOT generic order text, which a product page
    // with an express-pay CTA also has. If present we're on the checkout;
    // otherwise drive the storefront CTA. (PWYW platforms: seed the price first so
    // the paid card path mounts.)
    case "stripe-payment-link":
    case "stripe-checkout":
    case "lemonsqueezy":
    case "paddle":
    case "gumroad": {
      if (platform === "gumroad" || platform === "lemonsqueezy") {
        await seedCustomPrice(page, scenario);
      }
      if (await paymentSurfacePresent(page)) return true;
      return openStorefrontCheckout(page, scenario, merchant);
    }
    // Wizard storefronts: click through add-to-cart → checkout; fillCheckout's
    // advanceWizard handles the rest.
    default:
      return openStorefrontCheckout(page, scenario, merchant);
  }
}

const visible = (page: any, sel: string, t: number): Promise<boolean> =>
  page
    .waitForSelector(sel, { timeout: t, state: "visible" })
    .then(() => true)
    .catch(() => false);

const EMPTY_CART_SEL = "text=/your (cart|bag|basket) is empty|cart is empty|no items in your/i";
// A POSITIVE checkout-context signal: an order summary / line item / total, or a
// checkout-wizard advance affordance (a Continue/Next step button). Deliberately
// NOT a bare email input — a login or newsletter page reached from a no-op'd
// add-to-cart also has one. Split into a CSS-selector list and a `text=` probe:
// a `text=` engine selector mixed into a comma-separated CSS list is INVALID and
// throws, silently failing the whole probe (a bug from the campaign notes).
// CHECKOUT-SPECIFIC order context only — a line item / order summary / total, or
// a checkout-scoped advance affordance ("Continue to payment/shipping"). NOT a
// bare Continue/Next button, which a login/newsletter/interstitial page also has
// and would over-report a reached checkout.
const ORDER_CONTEXT_CSS =
  "[class*='line-item' i], [class*='order-summary' i], [class*='order-total' i]";
const ORDER_CONTEXT_TEXT =
  "text=/order summary|subtotal|order total|place order|pay now|continue to (payment|shipping)|proceed to (payment|checkout)/i";

const STRIPE_FRAME_SEL =
  'iframe[title="Secure payment input frame"], iframe[title="Secure card number input frame"],' +
  ' iframe[title="Secure card payment input frame"]';
// Direct card inputs across the platforms fillCheckout handles directly: Stripe
// hosted (#cardNumber), FastSpring (ccNumber), and the generic cc-number.
const CARD_INPUT_SEL =
  'input[autocomplete="cc-number"], input[name="cardNumber"], input[name*="cardnumber" i],' +
  ' input[name*="ccNumber" i], #cardNumber';
// Overlay checkout iframes that page-level selectors can't pierce, so their mere
// presence is the positive "checkout reached" signal (fillCheckout handles them).
const OVERLAY_FRAME_SEL = 'iframe[src*="buy.paddle.com"], iframe[src*="lemonsqueezy.com"]';

// Whether an actual PAYMENT SURFACE is present — a Stripe card frame, direct card
// inputs, or an overlay checkout iframe. Deliberately excludes generic order/pay
// TEXT (a product page with an express-pay CTA has "Pay now" without being a
// checkout), so it's the safe "are we already ON the hosted checkout?" probe.
async function paymentSurfacePresent(page: any): Promise<boolean> {
  return (
    (await visible(page, STRIPE_FRAME_SEL, 800)) ||
    (await visible(page, CARD_INPUT_SEL, 800)) ||
    (await visible(page, OVERLAY_FRAME_SEL, 800))
  );
}

// Whether a successful add-to-cart + Checkout click actually landed on a REAL
// checkout with an item. Requires a POSITIVE signal — a payment surface (Stripe
// frame / direct card input / Paddle overlay) or an order context / wizard step
// (order summary / line item / Continue-Next affordance) — so a no-op'd
// add-to-cart, or a Checkout click that lands on a login / product / newsletter
// page, is NOT scored as a reached checkout. Polls with short per-probe timeouts
// so a slow multi-step wizard's first step still has time to render one of these;
// an explicit empty-cart message short-circuits to not-reached. No positive
// signal within the budget = not reached. (NOT a bare email input, which a
// login/newsletter page also has.)
async function checkoutReached(page: any): Promise<boolean> {
  const deadline = Date.now() + 14_000;
  while (Date.now() < deadline) {
    // Check the explicit empty-cart signal FIRST: a no-op'd add-to-cart can land
    // on a page showing BOTH "cart is empty" and a generic subtotal/order-total
    // template element, and that must read as not-reached.
    if (await visible(page, EMPTY_CART_SEL, 300)) return false;
    if (await visible(page, STRIPE_FRAME_SEL, 300)) return true;
    if (await visible(page, CARD_INPUT_SEL, 300)) return true;
    if (await visible(page, OVERLAY_FRAME_SEL, 300)) return true;
    if (await visible(page, ORDER_CONTEXT_CSS, 300)) return true;
    if (await visible(page, ORDER_CONTEXT_TEXT, 300)) return true;
    await timer(500);
  }
  return false;
}

// Seed a pay-what-you-want price into an explicit price field (Gumroad / Lemon
// Squeezy) before the buy CTA, so the flow goes to the PAID card path instead of
// a free/validation state. Only the scenario's declared price is entered; a
// missing field is a harmless no-op.
async function seedCustomPrice(page: any, scenario: Scenario): Promise<void> {
  if (scenario.price === undefined) return;
  for (const sel of [
    'input[name="custom_price"]',
    'input[aria-label*="price" i]',
    'input[placeholder*="price" i]',
    'input[name*="price" i]',
  ]) {
    if (await visible(page, sel, 700)) {
      await page.fill(sel, scenario.price.toFixed(2)).catch(() => {});
      await page.press(sel, "Tab").catch(() => {});
      await timer(600);
      return;
    }
  }
}

// Open a generic storefront's checkout: click Add-to-cart, then Checkout, and
// report whether a REAL checkout (payment surface or order context with an item)
// was actually reached.
async function openStorefrontCheckout(
  page: any,
  scenario: Scenario,
  merchant?: MerchantRecipe
): Promise<boolean> {
  const id = scenario.id;
  const overrides = merchant?.overrides ?? {};
  const addSelectors = [
    overrides.addToCart,
    '[data-hook="add-to-cart-button"]',
    ".snipcart-add-item",
    'button:has-text("Add to Cart")',
    'button:has-text("Add to cart")',
    'button:has-text("Add to Bag")',
    'button:has-text("Buy now")',
    'button:has-text("I want this")',
    'a:has-text("I want this")',
    // A plain "Buy" opens the overlay on some Paddle/overlay product pages that
    // expose no separate Checkout link. EXACT text (:text-is) so it never matches
    // an express-wallet button like "Buy with PayPal"/"Buy with Shop Pay" and
    // divert the run into a wallet flow. Last, so specific CTAs win first.
    'button:text-is("Buy")',
    'a:text-is("Buy")',
  ].filter((s): s is string => Boolean(s));
  for (const sel of addSelectors) {
    const present = await page
      .waitForSelector(sel, { timeout: 1500, state: "visible" })
      .then(() => true)
      .catch(() => false);
    if (!present) continue;
    // Only stop on a click that actually LANDS — a covered/disabled candidate
    // that times out must fall through to the next selector, not break the loop
    // and leave the cart empty.
    const clicked = await page
      .click(sel, { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (!clicked) continue;
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
    // Only treat the checkout as reached if the click actually LANDS — a disabled
    // or popup-covered button that times out must fall through to the next
    // selector (and finally the payment-surface probe), not be reported as a
    // reached checkout the run then scores at "cart".
    const clicked = await page
      .click(sel, { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (!clicked) continue;
    log(id, `checkout via ${sel}`);
    await timer(3500);
    // Verify the click actually landed on a real checkout (with an item), not an
    // empty-cart page from a silently-no-op'd add-to-cart.
    return checkoutReached(page);
  }
  // No Checkout affordance — some storefronts (Ecwid, Snipcart, Paddle) open the
  // checkout as an overlay right after add-to-cart. Same verification.
  return checkoutReached(page);
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
  // In a real-money buy run, an allowBuy scenario only passes if it actually
  // completed the purchase — a fill/challenge/decline/ambiguous outcome is a
  // failed buy, not a pass. So the effective target rises to "buy". In dry mode
  // (or for non-allowBuy scenarios) the declared target stands.
  const effectiveTarget: Scenario["target"] =
    opts.buy && scenario.allowBuy === true ? "buy" : scenario.target;
  const result = (level: Level, extra: Partial<ScenarioResult> = {}): ScenarioResult => {
    const deadEnd = extra.blocker?.startsWith("dead-end:")
      ? extra.blocker.slice("dead-end:".length)
      : undefined;
    const pass = scenario.expectDeadEnd
      ? deadEnd === scenario.expectDeadEnd
      : levelRank(level) >= levelRank(effectiveTarget);
    return {
      id,
      url: scenario.url,
      target: effectiveTarget,
      level,
      pass,
      durationMs: Date.now() - started,
      notes: scenario.notes,
      ...extra,
    };
  };

  // The furthest stage reached, so an exception mid-fill (e.g. a proxy
  // merchant_blocked / approval_denied during the card-number fill) is reported
  // at the stage it actually got to instead of resetting to "none" and skewing
  // the autonomy score.
  let reached: Level = "none";
  try {
    // The registry's verdict for this URL (local bundle — same data the hosted
    // /v1/recipes serves) is a HINT for platform/overrides, not a shortcut: a
    // dead-end scenario is still driven and classified LIVE below, so the
    // benchmark actually re-verifies the recipe status instead of trusting it
    // (a down or re-themed site must not keep "passing" on registry memory).
    const known = recipesForUrl(bundle, scenario.url);

    if (!(await gotoWithRetry(page, scenario.url, id))) {
      return result("none", { blocker: "error:navigation failed after 3 attempts" });
    }
    reached = "reach";
    await dismissConsent(page);
    await dismissPopup(page);

    // A bot wall (Cloudflare Turnstile / hCaptcha) can sit on the ENTRY page,
    // before any platform fingerprint loads — classify it up front so a
    // correctly-refused scenario is reported as dead-end:turnstile, not
    // failed as unknown-platform. Only the turnstile signal is safe this early:
    // paypal-only/stripe-config are checkout-stage signals and are classified on
    // the pristine checkout below (a product page can show PayPal express buttons
    // without being a dead-end).
    if ((await classifyCheckoutSignals(page)).turnstile) {
      return result("reach", { blocker: "dead-end:turnstile" });
    }

    // A merchant recipe's `platform: "custom"` is NOT an executable playbook
    // platform (ko-fi/payhip/itch.io), so ignore it as a hint and let live
    // detectPlatform run instead of driving through the generic path blind.
    const hinted = known.merchant?.platform ?? known.platform?.id;
    const platform =
      scenario.platform ??
      (hinted && hinted !== "custom" ? (hinted as Platform) : undefined) ??
      (await detectPlatform(page));
    log(id, `platform: ${platform}`);
    if (platform === "unknown") return result("reach", { blocker: "error:platform unknown" });
    reached = "detect";

    if (!(await driveToCheckout(page, platform, scenario, known.merchant))) {
      // A Checkout click can land on a bot wall (Turnstile/hCaptcha) or a
      // PayPal-only/config dead-end before any order/payment surface renders, so
      // checkoutReached returns false — classify it as the dead-end it is rather
      // than a generic could-not-reach failure.
      const de = gatewayDeadEnd((await classifyCheckoutSignals(page)).gateway);
      if (de) return result("detect", { platform, blocker: `dead-end:${de}` });
      return result("detect", { platform, blocker: "error:could not reach checkout" });
    }
    reached = "cart";

    // Classify the FRESHLY-reached checkout for a dead-end (Turnstile,
    // PayPal-only, Stripe misconfig) BEFORE filling — billing entry and payment-
    // method selection perturb the DOM, so a pristine read is both more accurate
    // and the point at which an agent should bail. A fillable Stripe surface
    // reads as stripe-inline here (not a dead-end) and proceeds to the fill.
    const preSignals = await classifyCheckoutSignals(page);
    const preDeadEnd = gatewayDeadEnd(preSignals.gateway);
    if (preDeadEnd) return result("cart", { platform, blocker: `dead-end:${preDeadEnd}` });

    // Buy mode submits any scenario flagged `allowBuy` (independent of target —
    // e.g. a target:"fill" scenario can still be a real-money buy candidate).
    const wantBuy = opts.buy && scenario.allowBuy === true;
    if (wantBuy) {
      // Last-line guard before a REAL submit (validateScenarios enforces the same
      // up front): a defined, positive, finite, USD price at/under the cap. A
      // non-USD or non-positive price is blocked because the dollar cap can't be
      // compared to it (the bench can't read the live total to convert).
      const currencyOk = (scenario.currency ?? "USD").toUpperCase() === "USD";
      const priceOk =
        typeof scenario.price === "number" &&
        Number.isFinite(scenario.price) &&
        scenario.price > 0 &&
        scenario.price <= opts.maxBuyPrice;
      if (!priceOk || !currencyOk) {
        return result("cart", {
          platform,
          blocker: `error:buy blocked by price guard (price=${scenario.price} ${scenario.currency ?? "USD"}, cap=$${opts.maxBuyPrice})`,
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
      // Replay the merchant recipe's selector overrides (terms/placeOrder/
      // paymentMethod) during the fill, not just for navigation — otherwise a
      // verified recipe that corrected a selector runs the generic path.
      overrides: known.merchant?.overrides,
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
      // Reached the CVV leg — number + expiry landed, so at least "fill".
      return result(levelRank("fill") > levelRank(reached) ? "fill" : reached, {
        blocker: "challenge:cvv_entry_required",
      });
    }
    // Report the furthest stage reached, not "none": a fill-time failure at a
    // reached checkout must score as cart/fill, not as if the page never loaded.
    return result(reached, { blocker: `error:${code ?? message.slice(0, 160)}` });
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
    // A pass is full progress — including a correct dead-end refusal, which
    // reaches only "detect" but IS the right outcome (the benchmark contract:
    // dead-end classification is autonomy too). Only a genuine shortfall scores
    // by how far it got.
    depth += r.pass ? 1 : Math.min(1, levelRank(r.level) / levelRank(r.target));
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
