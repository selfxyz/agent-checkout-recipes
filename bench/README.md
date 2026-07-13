# Autonomy benchmark

Measures how autonomously Agent Pay can complete a purchase across the registry's
merchants — the objective signal behind recipe statuses. It runs the same
executable playbooks the SDK ships (`packages/agent-sdk/playbooks.ts`), so it
measures the real ship path, not a fork.

## The autonomy ladder

Each scenario is scored by the furthest level it reaches unattended:

| Level    | Meaning                                                        |
| -------- | ------------------------------------------------------------- |
| `none`   | couldn't even load the entry URL                              |
| `reach`  | loaded, but platform undetected                               |
| `detect` | platform identified                                           |
| `cart`   | reached the checkout/payment surface (item in cart)           |
| `fill`   | filled the card form with mock tokens (no submit)             |
| `buy`    | submitted once and got an order confirmation (buy mode only)  |

A scenario **passes** when it reaches its `target` — or, for a `expectDeadEnd`
scenario, when it **drives the site and classifies that dead-end live** (refusing
a PayPal-only or Turnstile-walled store is autonomy too). Registry recipe data is
only a *hint* for platform/overrides; every scenario, dead-end included, is
exercised end-to-end, so a down or re-themed site fails instead of passing on
memory. Dead-ends the harness can't detect live (e.g. a Shop Pay login-wall,
which needs a page URL the SDK doesn't expose) stay in the registry as recorded
data rather than as bench scenarios. The run also prints an **autonomy score**:
the mean per-scenario progress toward target (a pass counts as full progress), so
stalling at `cart` everywhere still scores above failing to detect platforms.

## Running

Needs a live proxy + a seeded card, like the demos (`SELF_AGENT_PAY_API_KEY`,
`SELF_AGENT_PAY_PROXY_URL`, `SELF_AGENT_PAY_API_URL`).

```bash
bun run bench                      # dry: reach → fill, NEVER submits
bun run bench -- --buy             # also submit allowBuy scenarios, ≤ --max-price
bun run bench -- --only brushespack-woo
bun run bench -- --max-price 2
```

Dry mode is safe to run anytime — it never places an order. Buy mode settles
**real money** on scenarios flagged `allowBuy` (any target). Verify a buy via the
merchant **email receipt**, never a confirmation page. Results are written to
`bench/last-run.json`.

`--max-price` (default $3) is a **static declared-price** pre-check: it blocks a
scenario whose recorded `price` exceeds the cap. It is *not* a live-total guard —
the SDK exposes no text extraction (`page.evaluate` is disabled for security), so
the benchmark cannot read the checkout total to catch a merchant price hike or
added shipping/tax. The authoritative over-cap protection is the proxy enforcing
the **funding card's** server-side controls (`perTxnCap` / `confirmAbove`) against
the amount it scrapes from the page. For a buy run, use a funding card whose
`perTxnCap` is set at or below your intended ceiling.

## Adding a scenario

Add an entry to `bench/scenarios.json` (see its `$comment` for the fields) and,
ideally, the corresponding recipe under `recipes/`. Set `target` to what the site
should reach unattended; set `expectDeadEnd` for a store that can't be completed.
