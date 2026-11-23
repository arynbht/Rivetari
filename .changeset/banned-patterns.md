---
"@arynbht/rivetari-runtime": minor
"@arynbht/rivetari-engine": patch
"@arynbht/rivetari": minor
---

A repo can ban patterns, and the judge fails a change that adds one. The list lives in `.rivetari/banned.json`; `rivetari init` seeds it with defaults for the stack (eval, new Function, debugger and raw innerHTML for Node; eval, exec, pickle loads, shell=True and breakpoint() for Python), and `rivetari banned seed|add|allow|list` maintains it. Tier 1 checks the change's added lines against the base's list, so a change can't loosen the rules it's judged by, and the tier 2 reviewer sees the list as part of the contract. Each entry counts once in the trust ladder's rule count; an entry a lint rule already enforces is marked `covered_by` and isn't counted twice. The stop detector no longer treats a test file that names a secret as data as a secret; real key shapes in test files still stop the round. Each build round's tokens, turns and whether it was a retry are recorded in the task's history row, and a build round with flagged decisions now counts towards the task's token totals again.
