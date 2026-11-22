# T-0007 · Say everything the guard hook refuses in its help text

<!-- Written by the factory runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-22 19:50 intake: card drafted with 3 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-22 19:50 intake: intake confirmed; card sha256 6ad41b5f294b516ca2a12453c3d2b2bea5eec422464af386411a9d7c8dde9ab1 (factory runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-22 19:50 route: assembly proposed; sha256 01ccee5fcf6a3b7b5d67d8aaed929fede532cc12bd0f4536318cda6918dcea19; skills none; proof test-run; awaiting approval (factory router (for arynbht@gmail.com))
- 2026-11-22 19:50 route: route approved; assembly sha256 01ccee5fcf6a3b7b5d67d8aaed929fede532cc12bd0f4536318cda6918dcea19 (factory runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-22 19:50 isolate: worktree .worktrees/T-0007 · branch fix/t-0007 from origin/main (42de90a69339) · port 5174 · db software_factory_dev_t0007 · env sha256 bbc90d87436c2dd1d9970c082b4cf5019b31c53d02524323e135c86436da68fd (factory runtime (for arynbht@gmail.com))
- 2026-11-22 19:51 build: build started · skills spine only · budget 8 steps / 60k ctx · 38 repo file(s) in context · 207621 tokens · $0.50 · 7 turns (factory runtime (for arynbht@gmail.com))
- 2026-11-22 19:55 build: build done · commit da6961cc1f00 · 5 file(s) this round · 567160 tokens · $0.60 · 15 turns · I rewrote the help text for `factory hook guard` so it lists everything the guard refuses. Lint, typecheck and the full test suite pass (100 files, 742 tests). (factory runtime (for arynbht@gmail.com))
- 2026-11-22 19:57 prove: proof passed · test-run (factory runtime (for arynbht@gmail.com))
- 2026-11-22 20:02 judge: judge passed · round 1 · head da6961cc1f00 · record sha256 276d7a051ee9bdf775aa8fd227afaed15f1155bb55ec3fd579f657ae8d50b66e (factory judge (for arynbht@gmail.com))
- 2026-11-22 20:02 ship: draft PR opened: #173 https://github.com/arynbht/software-factory/pull/173 · fix/t-0007 at da6961cc1f00 → main (factory runtime (for arynbht@gmail.com))
- 2026-11-22 20:24 close: worktree C:\Users\arynb\Documents\Projects\Software Factory - Dev\.worktrees\T-0007 kept: it couldn't be removed; remove it by hand · branch fix/t-0007 kept (factory runtime (for arynbht@gmail.com))
- 2026-11-22 20:24 close: ledger sealed · merged (factory runtime (for arynbht@gmail.com))

## Plan

- 2026-11-22 19:51 1. Read the hook-related code to confirm what the guard refuses. `packages/cli/src/commands/hook.ts` has `guardReason` and the `gitReason` around lines 327-378, and the Bash write checks. The guard refuses edits to `.factory/**`, edits to the primary checkout on the default branch, shell commands that write those paths (redirects, tee, cp, mv, rm, sed -i), and in a factory repo a force push or remote delete, `git reset --hard`, `git clean -f` and `git branch -D`. Don't change hook.ts.
- 2026-11-22 19:51 2. In `packages/cli/src/cli.ts`, rewrite only the `.description(...)` of `hook.command("guard")` as one plain sentence covering all of it. Suggested text: "PreToolUse: refuse edits to .factory/** and to the primary checkout on the default branch, shell commands that write them, and in a factory repo a force push or remote delete, git reset --hard, git clean -f and git branch -D". Leave the `.action` and every other command as they are.
- 2026-11-22 19:51 3. Add the new test file `packages/cli/src/cli.test.ts` (vitest, same style as `commands/hook.test.ts`). Import `buildProgram` from `./cli.js`. Find `hook` and then `guard` with `program.commands.find(c => c.name() === ...)`. Get `helpInformation()` and collapse whitespace (`.replace(/\s+/g, " ")`), because Commander wraps long descriptions. Covers A1: the guard's help contains `.factory/**`, `primary checkout on the default branch`, `force push`, `git reset --hard`, `git clean -f` and `git branch -D`.
- 2026-11-22 19:51 4. In the same test file, cover A2: the collapsed `helpInformation()` of the `hook` command has a `guard` entry whose text contains the guard command's `description()`, collapsed the same way. Don't edit `packages/cli/src/commands/hook.test.ts` or any other existing test (A3).
- 2026-11-22 19:51 5. Add `.changeset/guard-help-text.md` with `"@arynbht/factory": patch`. In one plain sentence, say that `factory hook guard --help` and `factory hook --help` now name everything the guard refuses, including shell writes and the destructive git commands, so someone whose git command was refused can tell it came from the guard. Say the guard's behaviour is unchanged.
- 2026-11-22 19:51 6. Run `pnpm action:build` and commit the rebuilt `packages/action/dist/`. AGENTS.md requires this for any change under packages/cli, or CI's bundle check fails.
- 2026-11-22 19:51 7. Run `pnpm run lint`, `pnpm run typecheck` and `pnpm run test`, or at least `pnpm --filter @arynbht/factory test`. Confirm the new cli.test.ts passes and the existing hook.test.ts passes unchanged, which is A3. Check `git diff --stat` to make sure only cli.ts, the new cli.test.ts, the changeset and `packages/action/dist/**` changed.

## Decisions

- 2026-11-22 19:50 routed to docs, testing: docs (touches **/*.md (.changeset/*.md); skill native-writing triggers on **/*.md (.changeset/*.md)), testing (touches **/*.test.* (packages/cli/src/cli.test.ts))
- 2026-11-22 19:50 native-writing matched but isn't available (not locked, not synced, or blocked at sync)

## Proof

- 2026-11-22 19:57 tests passed (pnpm run test, exit 0) · new tests: packages/cli/src/cli.test.ts: names everything the guard refuses; packages/cli/src/cli.test.ts: is listed under factory hook --help with the same description
- 2026-11-22 19:57 output: …: in the working copy of 'README.md', LF will be replaced by CRLF the next time Git touches it warning: in the working copy of 'README.md', LF will be replaced by CRLF the next time Git touches it warning: in the working copy of 'README.md', LF will be replaced by CRLF the next time Git touches it warning: in the working copy of 'README.md', LF will be replaced by CRLF the next time Git touches it
- 2026-11-22 19:57 evidence: the test run on the evidence branch: https://github.com/arynbht/software-factory/blob/evidence/T-0007/test-run.txt?raw=true

## Judge

- 2026-11-22 20:02 tier 1 round 1: pass · 9/9 pass
- 2026-11-22 20:02 review round 1: approve; 0 blocking, 0 suggestion(s) (claude-opus-5-5) · 1190 tokens · $0.08
- 2026-11-22 20:02 acceptance A1: met — The guard description in packages/cli/src/cli.ts:123 names .factory/**, the primary checkout on the default branch, force push, remote delete, git reset --hard, git clean -f and git branch -D. The new…
- 2026-11-22 20:02 acceptance A2: met — The second test checks that the flattened `factory hook --help` contains `guard <guard's own description>`, so the listing and the subcommand help can't drift apart.
- 2026-11-22 20:02 acceptance A3: met — Only the description string changed and runHookGuard is untouched. No existing test is modified; cli.test.ts is a new file. The test run is the proof that the hook tests still pass.
- 2026-11-22 20:02 judge review posted: https://github.com/arynbht/software-factory/pull/173#pullrequestreview-6014210196

## Outcome

- 2026-11-22 20:24 PR #173 merged by arynbht 2026-11-22 20:24 · 34m · 776k tokens · $1.18
