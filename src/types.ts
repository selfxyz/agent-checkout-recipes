// Checkout-recipe registry types. These are the single source of truth for the
// recipe shape; `schema/recipe.schema.json` mirrors them for editor tooling and
// a test asserts the two stay in sync.

// How far a recipe has been proven. "verified" requires out-of-band evidence of
// a real purchase (merchant email receipt), never just a confirmation page.
export const RECIPE_STATUSES = ["verified", "partial", "unverified", "dead-end"] as const;
export type RecipeStatus = (typeof RECIPE_STATUSES)[number];

// The executable playbook platforms — a platform recipe's `id` must be one of
// these (consumers map them to their own executable playbook/strategy per
// platform). A merchant recipe's `platform` is one
// of these or the literal "custom" (no executable playbook).
export const EXECUTABLE_PLATFORMS = [
  "shopify",
  "woocommerce",
  "stripe-checkout",
  "stripe-payment-link",
  "lemonsqueezy",
  "paddle",
  "gumroad",
  "bigcommerce",
  "squarespace",
  "wix",
  "ecwid",
  "snipcart",
  "fastspring",
  "bigcartel",
] as const;
export type ExecutablePlatform = (typeof EXECUTABLE_PLATFORMS)[number];

// The card-entry surface a checkout renders. Determines which fill strategy a
// consumer applies.
export const CARD_SURFACES = [
  "stripe-payment-element", // one iframe titled "Secure payment input frame"
  "stripe-split", // legacy split cardnumber/exp/cvc iframes
  "shopify-card-fields", // Shopify's card-fields-* split iframes
  "direct-inputs", // plain inputs on the payment domain (Stripe hosted, Paddle, FastSpring)
  "varies", // platform hosts multiple PSPs; recon per merchant
] as const;
export type CardSurface = (typeof CARD_SURFACES)[number];

// Why a merchant cannot be completed unattended (the DEAD-END failure class).
export const DEAD_END_TYPES = [
  "turnstile", // Cloudflare Turnstile / hCaptcha wall
  "captcha", // other CAPTCHA
  "paypal-only", // no guest card path (e.g. WooCommerce PayPal PPCP guestEnabled:false)
  "login-wall", // checkout requires an account and none is on file
  "3ds", // issuer always steps up to 3DS/SCA for this merchant
  "stripe-config", // merchant misconfig (minimum amount / no valid payment method)
  "automation-blocked", // site breaks under automation (add-to-cart no-ops, bot walls)
] as const;
export type DeadEndType = (typeof DEAD_END_TYPES)[number];

export interface DetectSignals {
  // Host patterns: exact ("svgkingdom.com") or wildcard ("*.myshopify.com").
  hosts?: string[];
  // Regex sources tested against the full page URL.
  urlPatterns?: string[];
  // DOM probes checked in attached state (script/meta/link tags never render).
  selectors?: string[];
}

// Ordered, human/agent-readable instructions for each checkout phase. Prose, not
// selectors — the machine-usable selectors live in `selectors`/`overrides`.
export interface RecipeSteps {
  addToCart?: string;
  contact?: string;
  billing?: string;
  payment: string;
  placeOrder: string;
  outcome: string;
}

interface RecipeBase {
  id: string;
  status: RecipeStatus;
  // ISO date (YYYY-MM-DD) of the last real-world verification run.
  lastVerifiedAt?: string;
  // Out-of-band proof for "verified" (e.g. "order #35675, email receipt").
  evidence?: string;
  gotchas?: string[];
  notes?: string;
}

// A platform recipe describes how a whole e-commerce platform's checkout works
// (Shopify, WooCommerce+Stripe, ...). `id` is the stable key an agent dispatches
// its platform-specific checkout strategy on.
export interface PlatformRecipe extends RecipeBase {
  kind: "platform";
  name: string;
  detect: DetectSignals;
  cardSurface: CardSurface;
  // Where the CVV token goes, e.g. "payment-frame:input[name=cvc]".
  cvvTarget: string;
  steps: RecipeSteps;
  // Named, machine-usable selectors (addToCart, terms, placeOrder, ...). Values
  // are a selector or an ordered fallback list.
  selectors?: Record<string, string | string[]>;
}

// A merchant recipe pins down one store: which platform recipe applies, the
// selector overrides discovered on a real run, and its verification trail. This
// is the durable form of the "per-merchant flow cache" in checkout-playbooks.md.
export interface MerchantRecipe extends RecipeBase {
  kind: "merchant";
  // Hosts this recipe matches (a host matches itself and its subdomains).
  hosts: string[];
  // Platform recipe id, or "custom" when no platform recipe applies.
  platform: string;
  cardSurface?: CardSurface;
  cvvTarget?: string;
  // Selector overrides keyed like PlatformRecipe.selectors.
  overrides?: Record<string, string>;
  // Present when the merchant is a DEAD-END for unattended checkout.
  deadEnd?: { type: DeadEndType; details?: string };
  // A product URL known to be cheap and purchasable, for benchmark runs.
  exampleProductUrl?: string;
}

export type Recipe = PlatformRecipe | MerchantRecipe;

// The built artifact (dist/registry.json): every recipe plus build metadata.
export interface RegistryBundle {
  version: string;
  generatedAt: string;
  platforms: PlatformRecipe[];
  merchants: MerchantRecipe[];
}
