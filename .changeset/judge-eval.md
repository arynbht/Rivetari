---
"@arynbht/rivetari": minor
"@arynbht/rivetari-runtime": minor
---

`rivetari judge eval` judges a corpus of labelled changes with today's judge and reports caught, missed and false blocks, per case and as a JSON result. Each case replays a real change as a two-commit repo through the task judge's own tier 1, review and decision; checks it can't run offline are replayed from the recorded run and say so, and a check with neither is not run, never a pass.
