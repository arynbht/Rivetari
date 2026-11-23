---
"@arynbht/rivetari-desktop": minor
---

Replace the Build tab with a read-only Tasks tab. It shows every Rivetari task in the repo from the runtime's `watchTasks`: a "Needs you" list of tasks waiting on a person and why (a stop-and-ask, a judge escalation, a card to confirm, a route to approve, a record that fails verification), a table with each task's beat, lease holder, build and judge rounds and cost, and, for the selected task, its next step, PR link and ledger, which updates as the runtime writes it. Nothing in the tab acts on a task. The Build tab's request-to-write-agent flow, superseded by tasks, is gone along with its IPC.
