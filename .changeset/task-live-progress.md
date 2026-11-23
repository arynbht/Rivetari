---
"@arynbht/rivetari-runtime": minor
"@arynbht/rivetari-engine": minor
"@arynbht/rivetari-desktop": minor
---

A running task now shows that it's alive. While `rivetari task run` runs a beat it writes a small progress file beside the task's directory, `.rivetari/tasks/<id>.progress.json`: the beat, when it started, when it last did something, and for the build the agent's turns, tokens and last tool so far. It's written atomically, at most every 2 seconds, and removed when the beat ends; it's never part of the ledger, the tasks branch or anything the judge hashes, and a file left by a process that died is ignored. The build agent reads `claude -p` as `--output-format stream-json --verbose` so it can count turns while the call runs, and still returns the same reply, cost, turns and turn limit from the final result. `spawnWithLimit` takes an `onLine` callback that hears stdout line by line. `watchTasks` puts each running task's progress on its view (`progress`), polls it on its own so it stays live during a slow read, counts a ledger entry as activity, and with `localFirst` lists this machine's copies at once before merging the tasks branch's view in; the branch read now loads up to 8 tasks at a time. `loadTask` takes `readOnly`.

In the desktop Tasks tab each running task shows "Running: build · 12 min · turn 18 · last activity 20 s ago", updated every second, and "No activity for N min" in amber after five quiet minutes; "Next: …" shows only when nothing is running. The list appears from the local copies first (about 50 ms for this repo's 31 tasks, down from about 11 s) and no longer carries every task's ledger: the open task's ledger is fetched on its own (`tasks:ledger`) and again when it grows.
