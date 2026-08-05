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
5. **Open a PR.** One recipe file per PR. CI re-runs validation and tests. A
   maintainer review then runs before merge and reports back on the PR; if it
   rejects a recipe you will be told which rule below it broke.

## What a recipe may not contain

Recipes are read and acted on by autonomous agents, so recipe text is an
instruction channel. These are rejected:

- **Instructions aimed at the reading agent** — anything telling it to ignore
  its rules, visit an unrelated URL, send data anywhere, reveal card or personal
  data, or do something other than complete this merchant's checkout. Selectors
  or URLs pointing at domains unrelated to the recipe's own hosts count too.
- **Challenge solving or evasion** — CAPTCHA, 3DS/OTP, or bot detection. Those
  are `dead-end` by design; record them, never defeat them.
- **Real payment data, credentials, session cookies, order emails, or anyone's
  personal data**, anywhere in the recipe or the PR.
- **Spam or junk** — promotional copy, a "merchant" that is not a real store, or
  content unrelated to completing a checkout.
- **Duplicates** — if your store is already here under another host, add the host
  to the existing recipe's `hosts` instead of adding a second file.
- **`verified` status**, which is maintainer-gated (see step 3).
