---
"@arynbht/rivetari-engine": minor
"@arynbht/rivetari-runtime": minor
---

Every `claude -p` call now has a time limit, and `rivetari task run` has a wall-clock budget, so a hung call can't keep a task running all night. Each call (the build agent, the judge's review through the CLI transport, the audit swarm and the write-agent) is killed after 20 minutes, or `RIVETARI_CALL_TIMEOUT_MINUTES`; on Windows the whole process tree is killed, not just the cmd.exe shim. One `rivetari task run` gets 90 minutes, or `RIVETARI_TASK_BUDGET_MINUTES`, and when the budget runs out during a call that call is killed. Either limit stops the task as a stop-and-ask with the new `timeout` trigger: the ledger names the limit that fired and its value, `rivetari task run` exits 2, and answering it runs the build or judge beat again. A judge stopped this way never reaches a verdict, so allowing it judges again instead of shipping.
