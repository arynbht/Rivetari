---
"@arynbht/rivetari-catalog": minor
"@arynbht/rivetari-engine": minor
"@arynbht/rivetari-runtime": minor
"@arynbht/rivetari": minor
---

The profile takes `autonomy: supervised | review-at-pr | unattended`, default `supervised`. At `review-at-pr` the card is confirmed and the route approved without asking, unless the route has a borderline sector or touches a sensitive path. Stops split into hard ones, which still pause the round (protected paths outside existing tests, rewritten history, a secret, a non-local `DATABASE_URL`, a new dependency whose license isn't on the OSI list or can't be read), and soft ones the build goes on past and flags (a new OSI-licensed dependency, a changed existing test, a schema change). The judge is told about flagged decisions, and the draft PR lists them under "Decisions you would have been asked" with the lockfile, schema or test diff inline. A high-risk task keeps every gate at any level. At `unattended`, `rivetari task run --all` runs every routed task in turn and parks any that would ask, which session start lists under "Needs you". Every PR body now carries the card and the route.
