---
"@arynbht/rivetari-runtime": minor
"@arynbht/rivetari-engine": minor
"@arynbht/rivetari": minor
---

Rivetari v2 step 7a: the judge, ship and close beats. `rivetari task judge <id>`
runs tier 1 and then the scoped review on the task's branch (never the worktree),
only on the commit the last build round made. Blocking findings or failed checks go
back to the agent with the repro, at most twice. A protected change, or blocking
findings in round 3, stop and ask a person. `rivetari task ship <id>` pushes the
judged branch and opens a draft PR whose body comes from the card, ledger, proof and
the judge's sealed record. `rivetari task close <id>` waits for a person to merge or
close the PR (or `--abandon`), records the outcome with duration, tokens and cost,
removes the worktree, appends a task row to `.rivetari/history.jsonl` and seals the
ledger.
