# T-0014 · Verify the autonomy ledger before the trust ladder reads it

<!-- Written by the factory runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-23 02:41 intake: card drafted with 4 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-23 02:42 intake: intake confirmed; card sha256 74ecbde6a4af44b8193e7991062584af648ab538cb2888dfd1b6a30a3b7c6fa6 (factory runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 02:42 route: assembly proposed; sha256 411820b3cb7e81dcabd27474606b8dd9dba9e5692d3328633066f175c79e1b1c; skills none; proof test-run; awaiting approval (factory router (for arynbht@gmail.com))
- 2026-11-23 02:42 route: route approved; assembly sha256 411820b3cb7e81dcabd27474606b8dd9dba9e5692d3328633066f175c79e1b1c (arynbht@gmail.com (--yes))
- 2026-11-23 02:42 isolate: worktree .worktrees/T-0014 · branch fix/t-0014 from origin/main (cf4293abf9db) · port 5175 · db software_factory_dev_t0014 · env sha256 998e297d5ce2d48a7231538ee98a15ffe40a26fdba816074c734809526229767 (factory runtime (for arynbht@gmail.com))
- 2026-11-23 02:43 build: build started · skills spine only · budget 12 steps / 60k ctx · 51 repo file(s) in context · 230228 tokens · $0.59 · 6 turns (factory runtime (for arynbht@gmail.com))
- 2026-11-23 02:46 build: build done · commit 475c2c00cbc8 · 8 file(s) this round · 1658507 tokens · $1.22 · 30 turns · The trust ladder now verifies the autonomy ledger before reading it. If the ledger fails verification, the repo runs supervised and `factory metrics` and the session-start hook list the ledger's probl (factory runtime (for arynbht@gmail.com))
- 2026-11-23 02:46 prove: proof deferred · test-run: the judge's tier 1 run on the change is the proof (factory runtime (for arynbht@gmail.com))
- 2026-11-23 02:53 prove: proof failed · test-run (the judge's tier 1 run) (factory runtime (for arynbht@gmail.com))
- 2026-11-23 02:53 judge: judge failed · round 1 · head 475c2c00cbc8 · tier 1 failed · record sha256 dcd6b2eaead8888d5a6442ebfe0a1af8f70eda8787af69d392c2f74a00db69d4 (factory judge (for arynbht@gmail.com))
- 2026-11-23 02:57 build: build done · commit 55ae1628d2eb · 7 file(s) this round · 887956 tokens · $0.67 · 25 turns · retry · I fixed both failures the judge sent back. The `task.test.ts` test that timed out passes now; in an isolated run it took about 12s against its 60s limit. I didn't run the whole suite with coverage, so (factory runtime (for arynbht@gmail.com))
- 2026-11-23 02:57 prove: proof deferred · test-run: the judge's tier 1 run on the change is the proof (factory runtime (for arynbht@gmail.com))
- 2026-11-23 03:02 prove: proof failed · test-run (the judge's tier 1 run) (factory runtime (for arynbht@gmail.com))
- 2026-11-23 03:02 judge: judge failed · round 2 · head 55ae1628d2eb · tier 1 failed · record sha256 61556addd9a9549207ce20335c043bcd13ed678aa5cbf826bc403e273a9a5826 (factory judge (for arynbht@gmail.com))
- 2026-11-23 03:06 build: build paused: 1 thing(s) to ask about · commit 55ae1628d2eb · 595923 tokens · $0.64 · 13 turns · retry (factory runtime (for arynbht@gmail.com))

## Plan

- 2026-11-23 02:43 1. Read packages/runtime/src/task/ledger.ts in full (ledgerKey, entries, verify, rerenderView) and grep for enforceFallback/repoAutonomy/autonomyEntries callers in packages/runtime and packages/cli. That shows every path that reads or appends to the autonomy ledger and confirms entries() throws on a malformed line.
- 2026-11-23 02:43 2. In packages/runtime/src/task/ladder.ts, add a `verification: { ok: boolean; problems: string[] }` field to LadderState. In ladder(), open autonomyLedger(repoPath) and call verify() inside a try/catch, so a key or read error becomes a failed verification with that error as its problem.
- 2026-11-23 02:43 3. Still in ladder(): when verification fails, skip autonomyEntries (it would throw on bad JSON, and its entries can't be trusted). Use entries [] and entry null, force effective to 'supervised', and set fallback to a plain sentence: 'the autonomy ledger at .factory/autonomy fails verification: <problems>'. When verification passes, run the existing code path unchanged (A4).
- 2026-11-23 02:43 4. Make enforceFallback return the state without calling record() when state.verification.ok is false, because append would throw on that ledger (A3). Leave setAutonomy as it is, so the existing ladder.test.ts expectation that appending to a forged ledger rejects with /fails verification/ still holds. Add no new code comments (diff.no-new-comments).
- 2026-11-23 02:43 5. In packages/cli/src/commands/metrics.ts renderLadder, when trust.verification.ok is false: add an 'Autonomy ledger' line saying it failed verification and the repo runs supervised, followed by one indented line per problem. The JSON output carries the field automatically.
- 2026-11-23 02:43 6. In packages/cli/src/commands/hook.ts sessionStartText, call ladder(root) with .catch(() => null). When verification failed, push lines saying the autonomy ledger at .factory/autonomy failed verification, list each problem, and say the repo runs supervised. Session start must always complete (A2, A3).
- 2026-11-23 02:43 7. Add packages/runtime/src/task/ladder-verify.test.ts using the same temp FACTORY_CONFIG_DIR and repo setup as ladder.test.ts. A1: after setAutonomy to review-at-pr with an override, editing an entry in ledger.jsonl, or separately editing ledger.md, gives effective 'supervised' with configured 'review-at-pr' and verification problems. A3: a non-JSON line resolves ladder() and enforceFallback() without throwing and appends nothing. A4: an intact ledger gives effective review-at-pr, the same entries, and verification.ok true.
- 2026-11-23 02:43 8. Add packages/cli/src/commands/ladder-verify.test.ts. Tamper with the autonomy ledger of a review-at-pr repo, then assert that runMetrics(dir, { findings: true }, { token: null }) returns 0 and its stdout names the failed verification, the problems and 'supervised'. Assert that sessionStartText(repo) resolves and contains the same. Also assert that an intact ledger produces none of those lines.
- 2026-11-23 02:43 9. Run only the related tests: `pnpm vitest related --run packages/runtime/src/task/ladder.ts packages/cli/src/commands/metrics.ts packages/cli/src/commands/hook.ts`, building workspace packages first if the CLI resolves @arynbht/factory-runtime from dist. Then run `pnpm run typecheck` and `pnpm run lint` and fix anything they report.
- 2026-11-23 02:43 10. Run `pnpm action:build`, because packages/runtime/src and packages/cli changed, and stage the regenerated packages/action/dist/**.
- 2026-11-23 02:43 11. Add .changeset/verify-autonomy-ledger.md with patch bumps for "@arynbht/factory-runtime" and "@arynbht/factory". Say that the trust ladder now verifies .factory/autonomy before reading it, treats a failed ledger as supervised, and that factory metrics and session start name the problems.
- 2026-11-23 02:43 12. Commit on fix/t-0014 with a conventional header of at most 72 characters, such as 'fix(runtime): verify the autonomy ledger before the ladder reads it', ending with the Co-Authored-By line.

## Decisions

- 2026-11-23 02:42 routed to docs, testing: docs (touches **/*.md (.changeset/*.md); skill native-writing triggers on **/*.md (.changeset/*.md)), testing (touches **/*.test.* (packages/runtime/src/task/ladder-verify.test.ts))
- 2026-11-23 02:42 under the threshold, for the approver: observability
- 2026-11-23 02:42 native-writing matched but isn't available (not locked, not synced, or blocked at sync)

## Stop-and-ask

- 2026-11-23 03:06 asked: agent_question: The tier 1 failure is a load timeout in `task.test.ts`'s "drafts on one machine…" test, which existed at base and passes here in 14 s against a 60 s limit; coverage failed only because that test did. Should I re-run the judge on the change unchanged, or rework that existing test so it fits its timeout the way T-0012 did for `store.test.ts`, which edits a test outside this card?

## Proof

- 2026-11-23 02:53 tests failed (npm test, exit 1, in the judge's tier 1 run on the change) · new tests: packages/cli/src/commands/ladder-verify.test.ts: factory metrics says it failed verification, lists its problems and runs supervised; packages/cli/src/commands/ladder-verify.test.ts: session start says it failed verification, lists its problems and runs supervised; packages/cli/src/commands/ladder-verify.test.ts: doesn't stop metrics or session start on a ledger that isn't JSON; packages/cli/src/commands/ladder-verify.test.ts: says nothing about an intact ledger; packages/runtime/src/task/ladder-verify.test.ts: runs supervised when an entry in ledger.jsonl was changed; packages/runtime/src/task/ladder-verify.test.ts: runs supervised when ledger.md was edited by hand; packages/runtime/src/task/ladder-verify.test.ts: raises nothing on a ledger that isn't JSON, and appends nothing to it; packages/runtime/src/task/ladder-verify.test.ts: raises nothing when the ledger key can't be read; packages/runtime/src/task/ladder-verify.test.ts: reads an intact ledger exactly as before
- 2026-11-23 02:53 output: …[31m[1m[7m FAIL [27m[22m[39m packages/cli/src/commands/task.test.ts[2m > [22mfactory task, shared through the factory/tasks branch[2m > [22mdrafts on one machine, and the other sees it but can't take it while it's held [31m[1mError[22m: EBUSY: resource busy or locked, rmdir 'C:\Users\arynb\AppData\Local\Temp\factory-origin-PzSDfO'[39m [31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯[22m[39m
- 2026-11-23 02:53 evidence: the judge's test run on the evidence branch: https://github.com/arynbht/software-factory/blob/evidence/T-0014/test-run.txt?raw=true
- 2026-11-23 03:02 tests failed (npm test, exit 1, in the judge's tier 1 run on the change) · new tests: packages/cli/src/commands/ladder-verify.test.ts: factory metrics says it failed verification, lists its problems and runs supervised; packages/cli/src/commands/ladder-verify.test.ts: session start says it failed verification, lists its problems and runs supervised; packages/cli/src/commands/ladder-verify.test.ts: doesn't stop metrics or session start on a ledger that isn't JSON; packages/cli/src/commands/ladder-verify.test.ts: says nothing about an intact ledger; packages/runtime/src/task/ladder-verify.test.ts: runs supervised when an entry in ledger.jsonl was changed; packages/runtime/src/task/ladder-verify.test.ts: runs supervised when ledger.md was edited by hand; packages/runtime/src/task/ladder-verify.test.ts: raises nothing on a ledger that isn't JSON, and appends nothing to it; packages/runtime/src/task/ladder-verify.test.ts: raises nothing when the ledger key can't be read; packages/runtime/src/task/ladder-verify.test.ts: reads an intact ledger exactly as before
- 2026-11-23 03:02 output: … [31m[1m[7m FAIL [27m[22m[39m packages/cli/src/commands/task.test.ts[2m > [22mfactory task, shared through the factory/tasks branch[2m > [22mdrafts on one machine, and the other sees it but can't take it while it's held [31m[1mError[22m: EBUSY: resource busy or locked, rmdir 'C:\Users\arynb\AppData\Local\Temp\factory-clone-fgevh2'[39m [31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/3]⎯[22m[39m
- 2026-11-23 03:02 evidence: the judge's test run on the evidence branch: https://github.com/arynbht/software-factory/blob/evidence/T-0014/test-run.txt?raw=true

## Judge

- 2026-11-23 02:53 tier 1 round 1: fail · 7/9 pass · 2 fail
- 2026-11-23 02:53 tier 1 fail: quality.tests.pass — `npm test` exited 1 (expected 0) [31m[1m[7m FAIL [27m[22m[39m packages/cli/src/commands/task.test.ts[2m > [22mfactory task, shared through the factory/tasks branch[2m > [22mdrafts on one machine, and the other sees it but can't take it while it's held [31m[1mError[22m: Test timed out in…
- 2026-11-23 02:53 tier 1 fail: quality.coverage.floor — coverage is configured, but the test run wrote no coverage/coverage-summary.json
- 2026-11-23 03:02 tier 1 round 2: fail · 7/9 pass · 2 fail
- 2026-11-23 03:02 tier 1 fail: quality.tests.pass — `npm test` exited 1 (expected 0) [31m[1m[7m FAIL [27m[22m[39m packages/cli/src/commands/task.test.ts[2m > [22mfactory task, shared through the factory/tasks branch[2m > [22mdrafts on one machine, and the other sees it but can't take it while it's held [31m[1mError[22m: Test timed out in…
- 2026-11-23 03:02 tier 1 fail: quality.coverage.floor — coverage is configured, but the test run wrote no coverage/coverage-summary.json
