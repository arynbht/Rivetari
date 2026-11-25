---
"@arynbht/rivetari-engine": patch
---

The `claude` CLI transport falls back when the installed CLI doesn't know `--effort`: the call runs again without it, and later calls skip it. An older CLI no longer makes every review fail.
