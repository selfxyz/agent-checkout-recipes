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
- **HTTP:** deployments serve the synced registry at
  `GET <API_URL>/v1/recipes?url=<page url>` — returns the matching merchant and
  platform recipes for the page you are on (no auth; recipes are open data).
  Without `?url=` it returns the full index.
- **SDK:** `recipesForUrl(url)` from `@selfxyz/agent-pay-playwright` wraps that
  endpoint. It sends only the host + path fingerprint (query and fragment are
  stripped), since the endpoint is unauthenticated and publicly cacheable and a
  hosted-checkout URL can carry session/capability tokens. Host matching is
  `www.`/trailing-dot insensitive.

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
