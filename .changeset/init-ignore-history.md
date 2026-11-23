---
"@arynbht/rivetari": patch
---

`rivetari init` now adds `history.jsonl` to `.rivetari/.gitignore`, so the history that task close writes locally no longer shows as untracked; repos initialised before this aren't touched.
