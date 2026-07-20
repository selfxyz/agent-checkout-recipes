## Recipe

<!-- Which file did you add or change? e.g. recipes/merchants/example.com.json -->

- File:
- Platform:
- Status claimed: <!-- unverified | partial | dead-end (verified is maintainer-set) -->

## How it was tested

<!-- What did you actually run? Which steps did you drive by hand or with an
     agent? Where did it stop, and why? Be specific — "worked" is not testing. -->

## Evidence class

Tick the one that matches. Be conservative; an honest lower class is worth more
than an inflated one.

- [ ] **none** — derived from platform structure, never run against the site
- [ ] **run-to-card-form** — drove a real checkout to a filled card form, no purchase
- [ ] **dead-end observed** — hit the blocker recorded in `deadEnd` (say which)
- [ ] **real purchase, out-of-band proof** — merchant email receipt or card
      statement (a confirmation page is not proof). Describe it below; a
      maintainer verifies before setting `verified`.

<!-- Evidence detail: -->

## Checklist

- [ ] `bun run validate` and `bun test` pass locally
- [ ] One recipe file; no unrelated changes
- [ ] No real card data, credentials, cookies, order emails, or personal data
- [ ] Does not encode solving or evading a CAPTCHA / 3DS / OTP / bot detection
