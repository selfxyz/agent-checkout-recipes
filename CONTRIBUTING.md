# Contributing a recipe

1. **Copy the shape.** Start from an existing file in `recipes/platforms/` or
   `recipes/merchants/` (schema: `schema/recipe.schema.json`; types:
   `src/types.ts`). Filename must be `<id>.json`; a merchant's id is its primary
   host.
2. **Fill in what you actually observed.** Detection fingerprints, card surface,
   per-phase steps, selector overrides, gotchas. Write steps as instructions an
   agent can follow, not marketing prose.
3. **Be honest about status.**
   - `unverified` — derived from the platform's known structure; not yet run.
   - `partial` — you drove a real checkout to a filled card form (no purchase).
   - `verified` — a real purchase, proven **out-of-band** (merchant email
     receipt or card statement — a confirmation page is not proof). Requires
     `evidence` and `lastVerifiedAt`.
   - `dead-end` — unattended checkout is impossible; say why in `deadEnd`
     (`turnstile`, `paypal-only`, `login-wall`, `3ds`, `stripe-config`,
     `automation-blocked`, `captcha`).
4. **Validate:** `bun run validate && bun test .` from `registry/`.
5. **Benchmark it (optional but preferred):** add a scenario in
   `bench/scenarios.json` and run `bun run bench` at the highest level you can
   support (see bench/README.md). Attach the result line to your PR.
6. **Open a PR.** CI re-runs validation and tests. A maintainer syncs merged
   recipes to the hosted `/v1/recipes` endpoint.

Never include real payment data, credentials, session cookies, or personal data
in a recipe or PR. Never contribute a recipe that solves or evades a CAPTCHA,
3DS, or bot-detection step — those are dead-ends by design.
