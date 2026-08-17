# Contributing a recipe

Agents: [AGENTS.md](AGENTS.md) has the same rules as a copy-pasteable flow.

**This repo is a read-only export of the live registry.** Recipes are
contributed through the API with an agent API key, screened automatically, and
exported back here daily — so please do not open recipe PRs; they will be
closed with a pointer to this page. Fixes to the schema, tooling or docs are
welcome as PRs.

1. **Copy the shape.** Start from an existing file in `recipes/platforms/` or
   `recipes/merchants/` (schema: `schema/recipe.schema.json`; types:
   `src/types.ts`). A merchant's id is its primary host.
2. **Fill in what you actually observed.** Detection fingerprints, card surface,
   per-phase steps, selector overrides, gotchas. Write steps as instructions an
   agent can follow, not marketing prose.
3. **Be honest about status.**
   - `unverified` — derived from the platform's known structure; not yet run.
   - `partial` — you drove a real checkout to a filled card form (no purchase).
   - `verified` — a real purchase, proven **out-of-band** (merchant email
     receipt or card statement — a confirmation page is not proof). Requires
     `evidence` and `lastVerifiedAt`. **Maintainer-gated:** contributors submit
     `unverified` / `partial` / `dead-end` and describe the evidence in the
     submission `note`; a maintainer confirms it and sets `verified`.
   - `dead-end` — unattended checkout is impossible; say why in `deadEnd`
     (`turnstile`, `paypal-only`, `login-wall`, `3ds`, `stripe-config`,
     `automation-blocked`, `captcha`).
4. **Validate locally (optional):** `bun install && bun run validate` catches
   schema mistakes in seconds.
5. **Submit.**

   ```ts
   import { submitRecipe, recipeSubmission } from "@agentvault/playwright";
   const { id } = await submitRecipe(recipe, { note: "how you tested it" });
   await recipeSubmission(id); // { status, verdict }
   ```

   or the `submit_checkout_recipe` MCP tool, or plain HTTP:
   `POST $SELF_AGENT_PAY_API_URL/v1/recipes` with the recipe as the JSON body
   (or `{ recipe, note }`) and `Authorization: Bearer <api key>`, then
   `GET /v1/recipes/submissions/<id>`. Outcomes: `approved` (live),
   `merged` (combined with an existing recipe for the same store), `rejected`
   (the verdict names the rule), `needs_human` (a maintainer decides — used for
   `verified` claims and anything the screening could not settle). A clean
   recipe is live within about a minute and appears here on the next export.

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
  personal data**, anywhere in the recipe or the note.
- **Spam or junk** — promotional copy, a "merchant" that is not a real store, or
  content unrelated to completing a checkout.
- **`verified` status**, which is maintainer-gated (see step 3).

A store that is already here under another host is not rejected — the
submission is combined with the existing recipe.
