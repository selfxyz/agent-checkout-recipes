# Contributing as an agent

Installable version of this flow (plus lookup and execution):
`npx skills add selfxyz/agent-checkout-recipes` —
[skills/checkout-recipes/SKILL.md](skills/checkout-recipes/SKILL.md).

You just solved (or failed to solve) a checkout. Record it in one call — no
fork, no PR, no GitHub account. Needs your agent API key
(`SELF_AGENT_PAY_API_KEY`) and the API base (`SELF_AGENT_PAY_API_URL`).

```bash
curl -sX POST "$SELF_AGENT_PAY_API_URL/v1/recipes" \
  -H "Authorization: Bearer $SELF_AGENT_PAY_API_KEY" \
  -H 'content-type: application/json' -d '{
    "recipe": {
      "id": "shop.example.com",
      "kind": "merchant",
      "hosts": ["shop.example.com"],
      "platform": "woocommerce",
      "status": "partial",
      "overrides": { "terms": "label:has-text(\"I agree\")" },
      "gotchas": ["Country selector defaults to UK; set it before the state field."],
      "exampleProductUrl": "https://shop.example.com/product/thing"
    },
    "note": "Reached the filled Stripe Payment Element; did not submit."
  }'
# -> {"id":"…","status":"pending"}

curl -s -H "Authorization: Bearer $SELF_AGENT_PAY_API_KEY" \
  "$SELF_AGENT_PAY_API_URL/v1/recipes/submissions/<id>"   # -> { status, verdict }
```

- `id` is the primary host; `platform` is a `recipes/platforms/<id>.json` id, or
  `"custom"` when no platform playbook applies.
- `status` is `partial` | `unverified` | `dead-end` — never `verified`.
- A dead end instead: `"status": "dead-end"` plus
  `"deadEnd": { "type": "paypal-only", "details": "…" }`.
- Completed a real purchase? Add `"verificationRequested": true` and put the
  receipt evidence in `note`; a maintainer upgrades the live recipe.
- Only record what you actually used — full shape in `schema/recipe.schema.json`,
  or copy a neighbouring file under `recipes/`.

If you have the Playwright SDK (it ships with the product; not on npm yet),
`submitRecipe(recipe, { note })` and `recipeSubmission(id)` do the same, and the
`submit_checkout_recipe` MCP tool submits and waits for the verdict.

## Rules that will get your submission rejected if broken

1. **Set the status you can actually defend** — see the table in
   [README.md](README.md). Do not claim `verified`; only a maintainer can grant
   it, and only against out-of-band receipt evidence. If you completed a real
   purchase, pass `verificationRequested: true` with the evidence in `note` —
   the maintainer upgrades the status.
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
