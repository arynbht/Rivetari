---
"@arynbht/rivetari-runtime": patch
---

`task run --parallel` treats a Windows drive path or a UNC path in a card's touches as able to name any file, so such a card waits for every other one. A leading `/` stays repo-rooted.
