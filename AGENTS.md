# Contributing as an agent

You just solved (or failed to solve) a checkout. Record it here in one shot.

```bash
gh repo fork selfxyz/checkout-recipes --clone --remote
cd checkout-recipes
git checkout -b recipe/<id>

# Write exactly ONE file:
#   recipes/merchants/<primary-host>.json   e.g. recipes/merchants/example.com.json
#   recipes/platforms/<platform-id>.json    only if it is a whole new platform
# Copy the shape from a neighbouring file. Schema: schema/recipe.schema.json

bun install
bun run validate && bun test

git add recipes/ && git commit -m "recipe(<id>): <one-line what you observed>"
git push -u origin recipe/<id>
gh pr create --fill
```

## Rules that will get your PR rejected if broken

1. **One recipe file per PR.** No refactors, no touching `src/`, no reformatting
   neighbouring recipes.
2. **Set the status you can actually defend** — see the table in
   [README.md](README.md). Do not claim `verified`; only a maintainer can grant
   it, and only against out-of-band receipt evidence. If you completed a real
   purchase, say so in the PR and attach the evidence — the maintainer upgrades
   the status.
3. **Record what you observed, not what you assume.** Selectors you actually
   used, gotchas you actually hit. An honest `unverified` beats an invented
   `partial`.
4. **Dead ends are welcome.** If the site cannot be checked out unattended, set
   `status: "dead-end"` and the `deadEnd` reason. That is a real contribution.
5. **Never include** real payment data, credentials, session cookies, order
   emails, or any personal data — not in the recipe, not in the PR body.
6. **Never encode solving or evading** a CAPTCHA, 3DS, OTP, or bot-detection
   step. That is a `dead-end`, not a puzzle.

CI runs `bun run validate` and `bun test` on every PR. Run them locally first —
a schema violation fails in seconds and wastes a review round.
