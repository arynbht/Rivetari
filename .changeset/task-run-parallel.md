---
"@arynbht/rivetari-runtime": minor
"@arynbht/rivetari": minor
---

Add `rivetari task run --parallel N`: run up to N tasks at once (the ids given, or every confirmed, route-approved task), each in its own worktree with its own lease and ledger as a single run has. Two tasks whose `touches` could name the same file (paths or globs) don't run together: the later one waits for the one it overlaps with, and a card with no touches runs alone. Every line starts with its task id, a summary says how each task ended, and the exit code is 0 when all shipped, 2 when any waits on a person, 1 when any errored. `--all` takes `--parallel` too. The default stays 1. The runtime exports `runParallel`, `touchesOverlap`, `parallelExitCode` and `oneAtATime`, and `runTask` takes an `isolating` lock so parallel tasks never pick the same port.
