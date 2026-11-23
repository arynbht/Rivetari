---
"@arynbht/rivetari-catalog": minor
"@arynbht/rivetari-engine": minor
"@arynbht/rivetari-runtime": minor
"@arynbht/rivetari": minor
---

Add a `ci` block to the profile. `ci.budget_minutes_per_month` sets the GitHub Actions minutes the repo means to spend in a month: `rivetari doctor` warns once the month reaches 75% of it, and the status issue shows the month so far against it. Minutes are counted per job and rounded up, as GitHub bills. A closed task's history row records the minutes and runs its PR's CI used (`ci_minutes`, `ci_runs`).

`ci.trust_judge` decides whether shipping a task the judge passed posts a `rivetari/judge` check run on its head commit, with the judge record's sha256 and the ledger hash, which CI can trust to skip lint, typecheck and tests. Unset, it's true on repos owned by the account Rivetari's App is registered to and false on anyone else's. The App now asks for `checks: write`.
