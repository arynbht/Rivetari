---
"@arynbht/factory-runtime": minor
"@arynbht/factory-engine": patch
"@arynbht/factory": patch
---

A task run no longer spends rounds that change nothing. A build round where the agent leaves the worktree as it found it stops the run and asks a person, with the agent's reply as the question, instead of proving the same commit again. The agent can also end a round with a last line `FACTORY_STOP: <question>`; the runtime asks it without committing or proving, and the next round gets the answer. The judge's reviewer and its false-positive gate now see every stop-and-ask a person allowed, with who and when, and are told not to block on it. A failing test run is retried once and run on the base: a failure that passes on the retry is reported as flaky, and one that also fails on the base as pre-existing, and neither fails the proof. Build rounds after the first resume the agent's previous session. A failed push while reserving a task id gives the id back, `factory task status` skips a folder with no card instead of failing, and a beat whose final push fails says the beat is done and exits 1. The judge's cost uses the cost the Claude CLI reports, and the price table now covers Claude Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1, so the judge no longer reads $0.
