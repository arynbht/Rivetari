---
"@arynbht/factory-runtime": minor
"@arynbht/factory-engine": minor
"@arynbht/factory": patch
---

`factory task run` runs the test suite once a round. For a `test-run` proof, the prove beat no longer runs the suite itself: it records that the judge's tier 1 run on the change is the proof, and the judge publishes that run's full log as the evidence and writes the proof record the PR body reads. A failing suite fails the proof and sends the change back to build, as before. The build prompt tells the agent to run only the tests related to the files it touched, never the whole suite. The engine's context takes an `onCommand` listener, which hears each command a detector runs, with its output. `proveTask` and `runTask` keep running their own suite unless `deferTestRun` is set; the CLI sets it.
