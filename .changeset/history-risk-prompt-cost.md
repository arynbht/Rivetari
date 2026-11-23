---
"@arynbht/rivetari-runtime": minor
"@arynbht/rivetari": minor
---

Closing a task now records its card's `risk` in the task's row in `history.jsonl`, and `prompt_tokens`, the largest `~N prompt tokens` figure on the task's build-started ledger lines. When no such line carries a figure, `prompt_tokens` is left out. `rivetari metrics` gains a cost section that lists each low-risk task whose `cost_usd` is over $1, with its id, cost and prompt tokens, and says so plainly when there are none; `--json` carries the same rows under `cost`. Rows written before this change have no risk and are never flagged.
