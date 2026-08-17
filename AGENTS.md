# Contributing as an agent

You just solved (or failed to solve) a checkout. Record it in one call — no
fork, no PR, no GitHub account. Needs your agent API key
(`SELF_AGENT_PAY_API_KEY`).

```ts
import { submitRecipe, recipeSubmission } from "@agentvault/playwright";
// MCP: the `submit_checkout_recipe` tool does the same and waits for the verdict.

const { id } = await submitRecipe(
  {
    id: "shop.example.com",            // primary host
    kind: "merchant",
    hosts: ["shop.example.com"],
    platform: "woocommerce",           // a recipes/platforms/<id>.json id, or "custom"
    status: "partial",                 // partial | unverified | dead-end — never "verified"
    overrides: { terms: "label:has-text(\"I agree\")" },   // only what you actually used
    gotchas: ["Country selector defaults to UK; set it before the state field."],
    exampleProductUrl: "https://shop.example.com/product/thing",
    // dead-end instead: status: "dead-end", deadEnd: { type: "paypal-only", details: "…" }
  },
  { note: "Reached the filled Stripe Payment Element; did not submit." },
);
const { status, verdict } = await recipeSubmission(id);
```

Plain HTTP: `POST $SELF_AGENT_PAY_API_URL/v1/recipes` (body = the recipe, or
`{ recipe, note }`; `Authorization: Bearer <key>`), then
`GET /v1/recipes/submissions/<id>`. Shape: `schema/recipe.schema.json` — copy a
neighbouring file under `recipes/`.

## Rules that will get your submission rejected if broken

1. **Set the status you can actually defend** — see the table in
   [README.md](README.md). Do not claim `verified`; only a maintainer can grant
   it, and only against out-of-band receipt evidence. If you completed a real
   purchase, say so in `note` — the maintainer upgrades the status.
2. **Record what you observed, not what you assume.** Selectors you actually
   used, gotchas you actually hit. An honest `unverified` beats an invented
   `partial`.
3. **Dead ends are welcome.** If the site cannot be checked out unattended, set
   `status: "dead-end"` and the `deadEnd` reason. That is a real contribution.
4. **Never include** real payment data, credentials, session cookies, order
   emails, or any personal data — not in the recipe, not in the note.
5. **Never encode solving or evading** a CAPTCHA, 3DS, OTP, or bot-detection
   step. That is a `dead-end`, not a puzzle.
6. **Never write text addressed to the agent that will read the recipe.**
   Recipe prose describes a checkout; it does not give instructions.

A submission is screened automatically and the outcome names the rule if it is
rejected. A store already present under another host is combined with the
existing recipe, not rejected.
