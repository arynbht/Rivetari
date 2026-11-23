# T-0024 · Verify the autonomy ledger before the trust ladder reads it

<!-- Written by Rivetari runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-23 09:42 intake: card drafted with 5 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-23 09:42 intake: intake confirmed; card sha256 fb0b8d368a83fac5ee3c4202aef5d266bbbff187f059e19eceaf909ee2f0d073 (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 09:42 route: assembly proposed; sha256 5eb1b9c296b888407cdd0399a5fd069354ec70e8356498518cad49a2a4dc9d36; skills none; proof test-run; awaiting approval (rivetari router (for arynbht@gmail.com))
- 2026-11-23 09:43 route: assembly proposed; sha256 5eb1b9c296b888407cdd0399a5fd069354ec70e8356498518cad49a2a4dc9d36; skills none; proof test-run; awaiting approval (rivetari router (for arynbht@gmail.com))
- 2026-11-23 09:43 route: route approved; assembly sha256 5eb1b9c296b888407cdd0399a5fd069354ec70e8356498518cad49a2a4dc9d36 (arynbht@gmail.com (--yes))
- 2026-11-23 09:44 isolate: worktree .worktrees/T-0024 · branch fix/t-0024 from origin/main (e715d3272439) · port 5176 · db rivetari_t0024 · env sha256 039168c1c36ff77209f7b4937d0f04b7b3de5432ca375c601ef2e4dcc405a2fe (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 09:44 build: build started · skills spine only · budget 12 steps / 60k ctx · 7 repo file(s) in context · 337043 tokens · $0.55 · 7 turns (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 10:49 build: build done · commit acbdc7e7b8a4 · 8 file(s) this round · 2653485 tokens · $1.88 · 45 turns · The trust ladder now checks the autonomy ledger before it trusts it. If the ledger fails that check, the repo runs supervised and the failure is shown to people. The new tests for A1–A4, the existing (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 10:49 prove: proof deferred · test-run: the judge's tier 1 run on the change is the proof (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 11:07 prove: proof passed · test-run (the judge's tier 1 run) (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 11:08 judge: judge passed · round 1 · head acbdc7e7b8a4 · record sha256 8cef540079ea97450bcf36c645121ad4f13b830bc27f99adca1493435a7bfe33 (rivetari judge (for arynbht@gmail.com))
- 2026-11-23 11:08 ship: draft PR opened: #195 https://github.com/arynbht/Rivetari/pull/195 · fix/t-0024 at acbdc7e7b8a4 → main (rivetari runtime (for arynbht@gmail.com))

## Plan

- 2026-11-23 09:44 1. In packages/runtime/src/task/ladder.ts, add a helper that opens the autonomy ledger, calls rerenderView(), then verify(), and returns { entries, problems }. It catches a key that can't be read (Ledger.open/ledgerKey throwing, e.g. a bad RIVETARI_LEDGER_KEY) and ledger.jsonl that isn't valid JSON lines (entries() throwing), and turns each into a problem string. Use the same ENTRY regex parsing as autonomyEntries, and leave autonomyEntries' exported behaviour unchanged.
- 2026-11-23 09:44 2. Change ladder() to use that helper. Add a `verification: string[]` field to LadderState (empty when the ledger is intact). When there are problems, read entries as [] (so entry, rulesAtEntry and since-entry numbers don't trust a forged record), set effective to 'supervised' whatever is configured, and set fallback to a sentence saying the autonomy ledger failed verification. configured still reports the profile's level.
- 2026-11-23 09:44 3. Make enforceFallback() return the state without calling record() when state.verification is non-empty, so nothing is appended to a ledger that fails verification and nothing throws. Leave setAutonomy and record as they are: append() still refuses with 'fails verification', which keeps the existing ladder.test.ts expectation.
- 2026-11-23 09:44 4. In packages/cli/src/commands/metrics.ts renderLadder(), when l.verification is non-empty, add lines after the Autonomy line. They say the autonomy ledger failed verification, list each problem, and say the repo runs supervised. Add nothing for an intact ledger. JSON output carries the field through LadderState.
- 2026-11-23 09:44 5. In packages/cli/src/commands/hook.ts sessionStartText(), call ladder(root) with a .catch(() => null) and add the same three kinds of lines (failed verification, each problem, runs supervised) only when verification is non-empty. Import ladder from @arynbht/rivetari-runtime, and keep the guard line first.
- 2026-11-23 09:44 6. Add packages/runtime/src/task/ladder-verify.test.ts (temp repo plus RIVETARI_CONFIG_DIR, as in ladder.test.ts). A1: override to review-at-pr, then edit a signed entry's text in ledger.jsonl. Expect configured review-at-pr, effective supervised, and a verification problem naming 'entry 1'.
- 2026-11-23 09:44 7. In the same runtime test file, A2: after an override, replace ledger.md's header with one naming the factory runtime. Expect ladder() to rewrite ledger.md to the fresh render, verify() to be ok, verification to be [], and effective to be review-at-pr. A3: put a non-JSON line in ledger.jsonl, and separately set RIVETARI_LEDGER_KEY to an invalid value. In both cases ladder() and enforceFallback() resolve and report effective supervised, and ledger.jsonl is byte-identical afterwards.
- 2026-11-23 09:44 8. Add packages/cli/src/commands/ladder-verify.test.ts for A4. Build a repo with a tampered autonomy ledger. Assert that renderLadder(await ladder(dir)) and sessionStartText(dir) contain the failed-verification line, the problem text and 'runs supervised'. Assert that an intact ledger, and a repo with no ledger, produce none of those lines. Edit no existing test file (A5).
- 2026-11-23 09:44 9. Add .changeset/verify-autonomy-ledger.md with patch bumps for @arynbht/rivetari-runtime and @arynbht/rivetari. Write one plain sentence saying that the trust ladder verifies the autonomy ledger, re-renders a stale view, and runs supervised when verification fails. Add no code comments anywhere in the diff.
- 2026-11-23 09:44 10. Run `pnpm action:build` and keep the rebuilt packages/action/dist/ in the change.
- 2026-11-23 09:44 11. Run `pnpm vitest related --run` on ladder.ts, metrics.ts, hook.ts and the two new test files (after the build). Then run `pnpm run typecheck` and `pnpm run lint`, and fix anything red without adding suppressions.

## Decisions

- 2026-11-23 09:42 routed to testing, docs: testing (touches **/*.test.* (packages/runtime/src/task/ladder-verify.test.ts); "test" in the description), docs (touches **/*.md (.changeset/verify-autonomy-ledger.md); skill native-writing triggers on **/*.md (.changeset/verify-autonomy-ledger.md))
- 2026-11-23 09:42 under the threshold, for the approver: infra, observability
- 2026-11-23 09:42 native-writing matched but isn't available (not locked, not synced, or blocked at sync)
- 2026-11-23 09:43 routed to testing, docs: testing (touches **/*.test.* (packages/runtime/src/task/ladder-verify.test.ts); "test" in the description), docs (touches **/*.md (.changeset/verify-autonomy-ledger.md); skill native-writing triggers on **/*.md (.changeset/verify-autonomy-ledger.md))
- 2026-11-23 09:43 under the threshold, for the approver: infra, observability
- 2026-11-23 09:43 native-writing matched but isn't available (not locked, not synced, or blocked at sync)

## Proof

- 2026-11-23 11:07 tests passed (npm test, exit 0, in the judge's tier 1 run on the change) · new tests: packages/cli/src/commands/ladder-verify.test.ts: is named, with its problems, in rivetari metrics and the session-start text; packages/cli/src/commands/ladder-verify.test.ts: prints none of it for an intact ledger, or for a repo with no ledger yet; packages/runtime/src/task/ladder-verify.test.ts: runs supervised when a signed entry was edited, and names the entry; packages/runtime/src/task/ladder-verify.test.ts: re-renders a view whose header names the factory runtime, then stays at review-at-pr; packages/runtime/src/task/ladder-verify.test.ts: treats a ledger.jsonl line that isn't JSON as failed verification, and appends nothing; packages/runtime/src/task/ladder-verify.test.ts: treats a ledger key that can't be read as failed verification, and appends nothing; packages/runtime/src/task/ladder-verify.test.ts: adds no verification problems for an intact ledger
- 2026-11-23 11:07 output: … increase limit (node:20024) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 24 close listeners added to [Socket]. MaxListeners is 12. Use emitter.setMaxListeners() to increase limit (node:20024) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 24 finish listeners added to [Socket]. MaxListeners is 12. Use emitter.setMaxListeners() to increase limit
- 2026-11-23 11:07 evidence: the judge's test run on the evidence branch: https://github.com/arynbht/Rivetari/blob/evidence/T-0024/test-run.txt?raw=true

## Judge

- 2026-11-23 11:07 tier 1 round 1: pass · 9/9 pass
- 2026-11-23 11:08 review round 1: approve; 0 blocking, 5 suggestion(s) (claude-opus-5-5) · 21289 tokens · $0.24
- 2026-11-23 11:08 acceptance A1: met — The runtime test edits entry 1. It asserts configured review-at-pr, effective supervised, and an 'entry 1: contents don't match its seal' problem.
- 2026-11-23 11:08 acceptance A2: met — The test rewrites the header to name the factory runtime. It asserts ledger.md is re-rendered, verify().ok is true, verification is empty and effective is review-at-pr.
- 2026-11-23 11:08 acceptance A3: met — Tests cover a non-JSON line and RIVETARI_LEDGER_KEY=not-a-key. ladder() and enforceFallback() resolve, report supervised, and leave ledger.jsonl byte-identical.
- 2026-11-23 11:08 acceptance A4: met — The CLI test checks renderLadder and sessionStartText for the failure line, the entry problem and 'runs supervised'. It checks none of it appears for intact or absent ledgers.
- 2026-11-23 11:08 acceptance A5: met — Only new test files are added.
- 2026-11-23 11:08 judge review posted: https://github.com/arynbht/Rivetari/pull/195#pullrequestreview-6020605420
