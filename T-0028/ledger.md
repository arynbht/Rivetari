# T-0028 · Have init ignore .rivetari/history.jsonl

<!-- Written by Rivetari runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-23 21:17 intake: card drafted with 3 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-23 21:17 intake: intake confirmed; card sha256 1687fcdde9b62e430c15debe350449b80bc0e12f8799b1e5ed8e85fdafa0aa35 (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 21:17 route: assembly proposed; sha256 9d5b8f0889813472ca15e3b5ff4b56c8909433f5bb02c226b10a13d0c6191740; skills none; proof test-run; awaiting approval (rivetari router (for arynbht@gmail.com))
- 2026-11-23 21:17 route: route approved; assembly sha256 9d5b8f0889813472ca15e3b5ff4b56c8909433f5bb02c226b10a13d0c6191740 (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 21:18 isolate: worktree .worktrees/T-0028 · branch fix/t-0028 from origin/main (f92f1c0e625b) · port 5177 · db rivetari_t0028 · env sha256 4f3219184c4dfd30cf103c795b3521ed260c194f826e8fa9467da9676546efb3 (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 21:18 build: build started · skills spine only · budget 8 steps / 15k ctx · ~17567 prompt tokens · 5 repo file(s) in context · 162461 tokens · $0.36 · 3 turns (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 21:19 build: build done · commit 6015f62ee7cd · 4 file(s) this round · 1 decision(s) flagged for the PR (autonomy review-at-pr) · 694088 tokens · $0.60 · 15 turns · `rivetari init` now writes `history.jsonl` to `.rivetari/.gitignore`, so the history file task close writes locally no longer shows as untracked in `git status`. The 4 related test files pass (18 test (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 21:19 prove: proof deferred · test-run: the judge's tier 1 run on the change is the proof (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 21:42 prove: proof passed · test-run (the judge's tier 1 run) (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 21:42 judge: judge passed · round 1 · head 6015f62ee7cd · record sha256 a6f01ac587ad8cd06b0d985ed70bf148c07d9544a48d3669a4a468655d7c2376 (rivetari judge (for arynbht@gmail.com))
- 2026-11-23 21:42 ship: draft PR opened: #216 https://github.com/arynbht/Rivetari/pull/216 · fix/t-0028 at 6015f62ee7cd → main (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 22:08 close: worktree removed · branch fix/t-0028 deleted (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 22:08 close: ledger sealed · merged (rivetari runtime (for arynbht@gmail.com))

## Plan

- 2026-11-23 21:18 1. In packages/cli/src/commands/init.ts, add "history.jsonl" to the list passed to ignoreInRivetari in runInit, after "cache/" and before "*.bak", so a fresh init writes 'tasks/\nai-usage.log\ncache/\nhistory.jsonl\n*.bak\n*.bak.*\n'. Don't add any code comments.
- 2026-11-23 21:18 2. In packages/cli/src/commands/init.test.ts, change only the expected .rivetari/.gitignore string in the 'writes config + workflow and runs the first audit' test to 'tasks/\nai-usage.log\ncache/\nhistory.jsonl\n*.bak\n*.bak.*\n'. Leave the rest of that file as it is (A3).
- 2026-11-23 21:18 3. Create packages/cli/src/commands/init-history-ignore.test.ts in the style of init.test.ts: a mkdtemp dir cleaned up in afterEach, stdout mocked, a 30s timeout, and runInit(dir, { type: 'cli', yes: true }, { token: null }). Run git the way hook.test.ts does, with execFileSync('git', args, { cwd, encoding: 'utf8' }). Add no code comments.
- 2026-11-23 21:18 4. Test A1: after init, split .rivetari/.gitignore into lines and check it contains 'history.jsonl' plus 'tasks/', 'ai-usage.log', 'cache/', '*.bak' and '*.bak.*'.
- 2026-11-23 21:18 5. Test A2: run `git init` in the temp dir, then runInit, then write a JSONL row to .rivetari/history.jsonl the way close does. Assert that `git status --porcelain --untracked-files=all` has no line naming .rivetari/history.jsonl and that `git check-ignore -q .rivetari/history.jsonl` exits 0. As a control, check that .rivetari/profile.yml still shows as untracked.
- 2026-11-23 21:18 6. Add .changeset/init-ignore-history.md with a '"@arynbht/rivetari": patch' frontmatter and one plain sentence: rivetari init now adds history.jsonl to .rivetari/.gitignore, so the history task close writes locally no longer shows as untracked, and repos initialised before this aren't touched.
- 2026-11-23 21:18 7. Run `pnpm vitest related --run packages/cli/src/commands/init.ts packages/cli/src/commands/init.test.ts packages/cli/src/commands/init-history-ignore.test.ts` from the worktree root, building the workspace packages first if the cli imports need it. Fix any failures without touching other existing tests.
- 2026-11-23 21:18 8. Run `pnpm run lint` and `pnpm run typecheck`, and confirm the diff touches only the four files on the card and adds no comments or suppressions.

## Decisions

- 2026-11-23 21:17 risk low: no high or medium signal in the touches
- 2026-11-23 21:17 routed to testing, docs: testing (touches **/*.test.* (packages/cli/src/commands/init.test.ts); "test" in the description), docs (touches **/*.md (.changeset/init-ignore-history.md); skill native-writing triggers on **/*.md (.changeset/init-ignore-history.md))
- 2026-11-23 21:17 native-writing matched but isn't available (not locked, not synced, or blocked at sync)

## Stop-and-ask

- 2026-11-23 21:19 flagged: protected_path: packages/cli/src/commands/init.test.ts — modifies a test that existed at base

## Proof

- 2026-11-23 21:42 tests passed (npm test, exit 0, in the judge's tier 1 run on the change) · new tests: packages/cli/src/commands/init-history-ignore.test.ts: lists history.jsonl in .rivetari/.gitignore beside the other entries; packages/cli/src/commands/init-history-ignore.test.ts: keeps a history.jsonl written by close out of git status
- 2026-11-23 21:42 output: … increase limit (node:37080) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 24 close listeners added to [Socket]. MaxListeners is 12. Use emitter.setMaxListeners() to increase limit (node:37080) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 24 finish listeners added to [Socket]. MaxListeners is 12. Use emitter.setMaxListeners() to increase limit
- 2026-11-23 21:42 evidence: the judge's test run on the evidence branch: https://github.com/arynbht/Rivetari/blob/evidence/T-0028/test-run.txt?raw=true

## Judge

- 2026-11-23 21:42 tier 1 round 1: pass · 9/9 pass
- 2026-11-23 21:42 tier 1 note: checked every workspace package: .changeset/init-ignore-history.md is outside every workspace package
- 2026-11-23 21:42 protected: packages/cli/src/commands/init.test.ts — modifies a test that existed at base (allowed at build)
- 2026-11-23 21:42 review round 1: approve; 0 blocking, 3 suggestion(s) (claude-opus-5-5) · 10792 tokens · $0.10
- 2026-11-23 21:42 acceptance A1: met — init.ts adds history.jsonl to the ignoreInRivetari list. The new test and the updated exact-content assertion in init.test.ts both check it.
- 2026-11-23 21:42 acceptance A2: met — The new test runs git init and rivetari init, writes .rivetari/history.jsonl, then checks it is missing from git status --untracked-files=all and that git check-ignore succeeds.
- 2026-11-23 21:42 acceptance A3: met — The only change to init.test.ts is the expected .gitignore string at line 123, which gains history.jsonl\n. The card explicitly allows this change to a protected path.
- 2026-11-23 21:42 judge review posted: https://github.com/arynbht/Rivetari/pull/216#pullrequestreview-6029990709

## Outcome

- 2026-11-23 22:08 PR #216 merged by arynbht 2026-11-23 22:07 · 51m · 867k tokens · $1.06
