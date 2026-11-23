---
"@arynbht/rivetari-desktop": minor
---

Answer a task's stop and open its PR from the Tasks tab.

Picking a task that waits on a stop (the build's or the judge's) shows an answer
form: allow or deny, with a note. The main process records it through the same
runtime calls as `rivetari task answer` (pull the tasks branch, take the lease,
append the answer under git's user.email, push), and the tab updates from the
watcher. A shipped task's PR link opens the https URL its ledger records in the
browser. Both actions refuse a second click while the first runs and show their
result or error in place.
