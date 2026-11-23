---
"@arynbht/rivetari-runtime": minor
---

Add `watchTasks` and `readTasks`, a read-only view of every task in a repo for the desktop shell. Each task is read the way `rivetari task status` shows it (the `rivetari/tasks` branch's copy, unless this machine's holds work the branch hasn't had, or the task is only here), with its beat, next step, lease, build and judge rounds, tokens and cost, PR, whether it waits on a person and why, and its ledger entries. `watchTasks` emits a snapshot, then `added`, `changed` (with the new ledger entries) and `removed` events by polling, and `stop()` ends it. Nothing is fetched, no ref moves and nothing under `.rivetari/` is written: records are loaded from scratch copies outside the repo.
