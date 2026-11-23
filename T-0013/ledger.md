# T-0013 · Record time per beat in history and show card-to-PR time in metrics

<!-- Written by the factory runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-23 02:03 intake: card drafted with 4 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-23 02:03 intake: intake confirmed; card sha256 0ad9e09f93182e7eb52fa2939d6482c06aa85ee047c4838df3787743fdc4eb97 (factory runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 02:03 route: assembly proposed; sha256 8e3062e3b99f1b6083a7cd6d4dafb576852e5598881a25ce7cd7acb8db493778; skills none; proof test-run; awaiting approval (factory router (for arynbht@gmail.com))
- 2026-11-23 02:04 route: route approved; assembly sha256 8e3062e3b99f1b6083a7cd6d4dafb576852e5598881a25ce7cd7acb8db493778 (arynbht@gmail.com (--yes))
- 2026-11-23 02:04 isolate: worktree .worktrees/T-0013 · branch feature/t-0013 from origin/main (24781e4d2135) · port 5175 · db software_factory_dev_t0013 · env sha256 cc026f895f34f0049bdbe0ca88a234e3875a9cd2565c07ec13a77d854e0e392f (factory runtime (for arynbht@gmail.com))
- 2026-11-23 02:05 build: build started · skills spine only · budget 8 steps / 60k ctx · 92 repo file(s) in context · 802875 tokens · $1.17 · 7 turns (factory runtime (for arynbht@gmail.com))
- 2026-11-23 02:10 build: build done · commit 95c7ed31dc36 · 9 file(s) this round · 4911125 tokens · $2.74 · 46 turns · I've added the per-beat timing to history rows and a "Card to PR" section to `factory metrics`. The new tests pass, and so do the existing ship and judge tests. Typecheck, lint and prettier are clean. (factory runtime (for arynbht@gmail.com))
- 2026-11-23 02:10 prove: proof deferred · test-run: the judge's tier 1 run on the change is the proof (factory runtime (for arynbht@gmail.com))
- 2026-11-23 02:15 prove: proof passed · test-run (the judge's tier 1 run) (factory runtime (for arynbht@gmail.com))
- 2026-11-23 02:37 judge: judge failed · round 1 · head 95c7ed31dc36 · tier 1 failed · record sha256 151b780215ccc85865eb2bcc933edb5ef2084342e7d6400cda41909f499b91c9 (factory judge (for arynbht@gmail.com))
- 2026-11-23 02:38 build: build paused: 1 thing(s) to ask about · commit 95c7ed31dc36 · 238597 tokens · $0.32 · 6 turns · retry (factory runtime (for arynbht@gmail.com))
- 2026-11-23 02:41 close: worktree C:\Users\arynb\Documents\Projects\Software Factory - Dev\.worktrees\T-0013 kept: it couldn't be removed; remove it by hand · branch feature/t-0013 kept (factory runtime (for arynbht@gmail.com))
- 2026-11-23 02:41 close: ledger sealed · abandoned (factory runtime (for arynbht@gmail.com))

## Plan

- 2026-11-23 02:05 1. In packages/runtime/src/ship/close.ts, add optional fields to TaskHistoryRow: `risk` (from task.card.risk), `card_to_pr_minutes` (number | null) and `beats` ({plan, build, prove, judge, ship} in minutes). Keep them optional so rows written before this change still type-check and load.
- 2026-11-23 02:05 2. In close.ts, add an exported pure `beatMinutes(task)` that walks the ledger entries in order. Each gap between consecutive entries goes to the beat of the entry that closes it: an entry with beat build and section plan counts as plan, and beats outside plan/build/prove/judge/ship are ignored. A gap from an `asked:` stop entry up to the `answered:` entry (the ANSWERED regex from task/tasks.ts) counts as waiting on a person and is left out. Round each beat to 0.1 minute.
- 2026-11-23 02:05 3. In close.ts, add an exported `cardToPrMinutes(task)`: the time from the first intake entry to the first ship entry that matches SHIPPED (`draft PR opened|updated: #n`), minus any asked-to-answered wait in between. Return null when there's no PR. In closeTask, write `risk`, `card_to_pr_minutes` and `beats` into the row.
- 2026-11-23 02:05 4. In packages/runtime/src/judge/findings.ts, add an exported pure `timingMetrics(rows, now)` that returns: (a) the median card_to_pr_minutes over low-risk rows that have it, against a TARGET of 10, plus the low-risk tasks over 10 (task, pr, minutes); (b) slow beats. A slow beat is a beat of a row dated within the last day whose minutes are more than 1.5 times that beat's median over rows dated in the 7 days before it. Rows without `beats` are skipped for medians and flags, and an old row with no new fields loads without error. Export it and its types from packages/runtime/src/index.ts.
- 2026-11-23 02:05 5. In packages/cli/src/commands/metrics.ts, add `renderTiming(t)` that prints a 'Card to PR' block: the low-risk median in minutes vs the 10-minute target (n/a when there are none), one line per low-risk task over target, and one line per slow beat naming the task, beat, minutes and 7-day median. Call it in both the `--findings` path and the full path using historyRows/timingMetrics with options.now, and include it in the JSON output.
- 2026-11-23 02:05 6. Add unit tests in new files. packages/runtime/src/ship/timing.test.ts covers beatMinutes and cardToPrMinutes on a hand-built Task with timestamped entries, including an asked/answered wait that's left out (A1), plus timingMetrics' median, the tasks over target, slow-beat flags and old rows without beats (A2–A4). packages/cli/src/commands/metrics-timing.test.ts writes history.jsonl rows (new and old) and checks the runMetrics --findings output text (A2, A3, A4). Also add a closeTask test asserting that the history row carries risk, card_to_pr_minutes and beats, in a new test file reusing ship.test.ts's setup pattern, without editing existing tests.
- 2026-11-23 02:05 7. Run `pnpm vitest related --run` on the touched files plus `pnpm run typecheck` and `pnpm run lint`. Make sure no code comments are added (diff.no-new-comments) and no suppressions.
- 2026-11-23 02:05 8. Run `pnpm action:build` and commit the rebuilt packages/action/dist. Add .changeset/beat-timing.md bumping @arynbht/factory-runtime minor and @arynbht/factory minor, describing the per-beat history fields and the card-to-PR and slow-beat output in metrics.

## Decisions

- 2026-11-23 02:03 routed to docs, testing, observability: docs (touches **/*.md (.changeset/*.md); skill native-writing triggers on **/*.md (.changeset/*.md)), testing (touches **/*.test.* (packages/**/*.test.ts)), observability ("metrics" in the title)
- 2026-11-23 02:03 under the threshold, for the approver: perf
- 2026-11-23 02:03 native-writing matched but isn't available (not locked, not synced, or blocked at sync)

## Stop-and-ask

- 2026-11-23 02:38 asked: agent_question: The judge's suite run timed out on the existing git-heavy test in `packages/runtime/src/task/store.test.ts` (30s limit; it passes in about 8s when run on its own), and nothing in this change touches that code. Should the judge re-run the suite as it is, or do you want me to raise that test's timeout or the shared `testTimeout` in `vitest.config.ts`?

## Proof

- 2026-11-23 02:15 tests failed on the change and on the base: pre-existing, not blamed on this change (npm test, exit 1, in the judge's tier 1 run on the change) · new tests: packages/cli/src/commands/metrics-timing.test.ts: prints the low-risk median against 10 minutes, the tasks over it, and slow beats; packages/cli/src/commands/metrics-timing.test.ts: still loads history written before beats were recorded, with nothing to show; packages/runtime/src/ship/timing.test.ts: gives each beat the gaps its own entries close, leaving out the wait for a person's answer; packages/runtime/src/ship/timing.test.ts: has no card-to-PR time before a PR is opened; packages/runtime/src/ship/timing.test.ts: closing a task writes risk, card-to-PR minutes and beats into its history row; packages/runtime/src/ship/timing.test.ts: takes the median card-to-PR time of low-risk tasks against 10 minutes, and names those over it; packages/runtime/src/ship/timing.test.ts: flags a recent beat over 1.5 times its median in the 7 days before; packages/runtime/src/ship/timing.test.ts: loads rows written before beats were recorded and leaves them out of the medians
- 2026-11-23 02:15 output: …[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/4]⎯[22m[39m [31m[1m[7m FAIL [27m[22m[39m packages/runtime/src/task/store.test.ts[2m > [22mthe task store[2m > [22mkeeps a second machine off a task until the lease expires or is released [31m[1mError[22m: EBUSY: resource busy or locked, rmdir 'C:\Users\arynb\AppData\Local\Temp\factory-clone-wYMS6i'[39m [31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/4]⎯[22m[39m
- 2026-11-23 02:15 evidence: the judge's test run on the evidence branch: https://github.com/arynbht/software-factory/blob/evidence/T-0013/test-run.txt?raw=true

## Judge

- 2026-11-23 02:15 tier 1 round 1: pass · 7/9 pass · 2 pre-existing
- 2026-11-23 02:37 tier 1 round 1: fail · 7/9 pass · 2 fail
- 2026-11-23 02:37 tier 1 fail: quality.tests.pass — `npm test` exited 1 (expected 0) [31m[1m[7m FAIL [27m[22m[39m packages/runtime/src/task/store.test.ts[2m > [22mthe task store[2m > [22mkeeps a second machine off a task until the lease expires or is released [31m[1mError[22m: Test timed out in 30000ms. If this is a long-running test, pa…
- 2026-11-23 02:37 tier 1 fail: quality.coverage.floor — coverage is configured, but the test run wrote no coverage/coverage-summary.json

## Outcome

- 2026-11-23 02:41 abandoned: branch predates the #183 test fix; redrafted on current main · 37m · 5953k tokens · $4.23
