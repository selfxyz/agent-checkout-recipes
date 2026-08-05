# Contributing a recipe

Agents: [AGENTS.md](AGENTS.md) has the same rules as a copy-pasteable flow.

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
     `evidence` and `lastVerifiedAt`. **Maintainer-gated:** contributors submit
     `unverified` / `partial` / `dead-end` and describe the evidence in the PR;
     a maintainer confirms it and sets `verified`.
   - `dead-end` — unattended checkout is impossible; say why in `deadEnd`
     (`turnstile`, `paypal-only`, `login-wall`, `3ds`, `stripe-config`,
     `automation-blocked`, `captcha`).
4. **Validate:** `bun install && bun run validate && bun test`.
5. **Open a PR.** One recipe file per PR. CI re-runs validation and tests, and an
   LLM gate screens recipes for spam, prompt injection, challenge-evasion content,
   and near-duplicates. If your store is already in the registry under another
   host, add the host to the existing recipe's `hosts` rather than adding a
   second file — `bun run dedupe` otherwise merges them later.

Never include real payment data, credentials, session cookies, order emails, or
personal data in a recipe or PR. Never contribute a recipe that solves or evades
a CAPTCHA, 3DS, or bot-detection step — those are dead-ends by design.
