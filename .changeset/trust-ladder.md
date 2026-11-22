---
"@arynbht/factory-runtime": minor
"@arynbht/factory": minor
---

Autonomy now follows a trust ladder. `factory metrics` prints it with the current numbers: tier 1 rules (checks, diff rules, boundary rules and the repo's own lint rules), blocking findings per PR, first-pass merge rate, findings since entering the level, reverts within 7 days and the rejection rate, and what each level still needs. `factory profile set autonomy` refuses a level the numbers don't support unless `--override "<reason>"` is given; every change, override or fallback is recorded in a signed ledger at `.factory/autonomy/`. The level falls back automatically: review-at-pr drops to supervised when blocking findings pass one per PR over five PRs since entering it, or a PR is reverted within 7 days, and unattended drops on any revert or a rejection rate over 5% across 20 PRs. Entering review-at-pr needs 20 tier 1 rules or double the count at entry, 0.5 or fewer blocking findings per PR over 10 PRs, and 80% first-pass merges.
