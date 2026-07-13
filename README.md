# Checkout Recipe Registry

An open registry of machine-readable **checkout recipes**: how to complete a real
purchase, unattended, on e-commerce platforms and specific merchants. Agents are
still bad at buying things in a browser — popups, AJAX carts that silently no-op,
payment iframes, wallet-button traps, challenge walls. Recipes turn each solved
site into a deterministic replay instead of a re-improvisation.

This directory is self-contained on purpose (own schema, validator, tests,
benchmark) so it can be split into a standalone open-source repo.

## What's in a recipe

- **Platform recipes** (`recipes/platforms/*.json`) — how a whole platform's
  checkout works (Shopify, WooCommerce+Stripe, Stripe Payment Links, …): detection
  fingerprints, the card-entry surface, per-phase steps, named selectors, gotchas.
  Ids match the `Platform` union in `packages/agent-sdk/playbooks.ts`, which
  implements the executable strategies.
- **Merchant recipes** (`recipes/merchants/*.json`) — one store pinned down: which
  platform recipe applies, selector overrides discovered on a real run, dead-end
  classification (Turnstile, PayPal-only guest flow, …), and the verification
  trail. This is the durable form of the per-merchant flow cache.

Statuses are strict: **verified** requires out-of-band evidence of a real purchase
(merchant email receipt — never just a confirmation page); **partial** means the
card fill is proven; **unverified** is derived from platform structure;
**dead-end** cannot complete unattended (the recipe says exactly why).

## Consuming the registry

- **Files:** read the JSON under `recipes/`, or build the aggregate:
  `bun run build` → `dist/registry.json` (full bundle) and `dist/RECIPES.md`
  (one agent-readable document of every recipe).
- **SDK (preferred):** `recipesForUrl(url)` from `@selfxyz/agent-pay-playwright`
  returns the matching merchant + platform recipes for a page. It automatically
  sends only a **host + path fingerprint** — query, fragment, and hosted-checkout
  session tokens (Stripe `cs_…`, Shopify `/checkouts/…`) are stripped — because
  the endpoint is unauthenticated and (for the index) cacheable. Host matching is
  `www.`/trailing-dot insensitive. Prefer this over calling the endpoint directly.
- **HTTP:** deployments serve the synced registry at `GET <API_URL>/v1/recipes`.
  Pass `?url=<fingerprint>` to get the recipes for a page — **send only
  `scheme://host/path`, not the raw page URL**: the request URL is not
  authenticated and can reach client/proxy/API logs before the server's
  `no-store`, so never put a checkout session token in it (strip the query,
  fragment, and any `/checkouts/…` or `cs_…` token, exactly as the SDK does).
  Per-URL responses are `no-store`. With no `?url=` it returns the full index
  (public, short-cached).

Agents should fetch the recipe for a page **before** improvising Playwright on
it, and follow `packages/agent-sdk/checkout-playbooks.md` for the recon →
classify → playbook → cache loop and the failure taxonomy
(RETRYABLE / FIXABLE / DEAD-END).

## Benchmark

`bench/` measures how autonomously an agent can buy across the registry's
scenarios — see [bench/README.md](bench/README.md). Benchmark runs are the
verification engine for recipe statuses.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Short version: add a JSON file under
`recipes/`, run `bun run validate` and `bun test`, include evidence for any
status upgrade.

## Safety invariants (non-negotiable)

- Fill only **mock tokens** (Self Agent Pay); recipes never contain, request, or
  read back real card numbers, CVVs, or passwords.
- On a detected challenge (3DS / OTP / CAPTCHA): stop and hand off to the human.
  Recipes must never encode solving or bypassing a challenge.
- Submit a payment **once**; classify the outcome instead of retrying a submit.
