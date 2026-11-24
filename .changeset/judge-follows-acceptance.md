---
"@arynbht/rivetari-runtime": patch
"@arynbht/rivetari-engine": patch
"@arynbht/rivetari-catalog": patch
"@arynbht/rivetari": patch
---

The judge's verdict now follows the card's acceptance criteria. A criterion the reviewer marks unmet always blocks, without the false-positive gate; an empty change fails without a review; and a criterion nobody verified sends the round to a person with the reason at every autonomy level, supervised included, instead of passing. The gate gets every criterion's full text for every finding, so a defect tied to a criterion is no longer dropped as "no criterion text given", and a confirmed finding against a criterion marks it unmet. The review sees tier 1's checks from the same round, and a criterion that only says lint, typecheck or tests pass takes its status from them.

A judge record now keeps the judged head's tree. `rivetari review --pr` carries the earlier verdict to a head with an identical tree (a merge commit that adds nothing), says so in the review, and carries the `rivetari/judge` check to it where the token can post one; `--fresh` reviews anyway.

A failed `claude` call now says what it printed (its JSON error on stdout when stderr is empty), a call that failed for a passing reason is retried once, a crashed review leaves its reason in the ledger, and `rivetari task run` prints a summary line when a beat fails.

Reviews cost less and more evenly: the model and effort follow the derived risk and the change's size (the smaller model at medium effort for low-risk changes of at most 300 source lines, the strong model at high effort for high risk or the repo's sensitive list, medium effort otherwise; `ai.judge_small_model` in the profile picks the smaller model), big test files are sent as their first part plus their test names, lockfiles as line counts, the gate's diff is capped, and every round prints its tokens and cost.
