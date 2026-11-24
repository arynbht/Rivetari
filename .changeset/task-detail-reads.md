---
"@arynbht/rivetari-runtime": minor
---

`loadJudgeRounds(repoPath, task)` reads every judge round of a task, oldest first, each record checked against the hash its own verdict entry sealed; a round whose record is missing or changed is kept with the reason instead of throwing, so the desktop shell can show a task's judge findings round by round. `taskPlan(task)` (the build's latest plan) and `allowedDecisions(task)` (the stops a person allowed) are now exported and read only the task's ledger entries, so a watcher's view of a task will do. `loadJudgeRecord` behaves as before. `watchTasks` takes an `onRead` callback, told after each full read (the branch's view merged in) has landed and its events have been emitted, so a listener can tell a local-first list catching up with the branch from what happens next.
