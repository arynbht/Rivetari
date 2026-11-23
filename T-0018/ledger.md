# T-0018 · Reject a touches glob that matches more than 20 files at intake

<!-- Written by Rivetari runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-23 07:19 intake: card drafted with 3 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-23 07:19 intake: intake confirmed; card sha256 748cba8c626c8f6b50358f0d1406559fee2babf2263765627198c3aa409f05a9 (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 07:19 route: assembly proposed; sha256 4907ecd262d5c1154132a395714ff8e10f44bd1d64d41a6480e9bdb2913e0940; skills none; proof test-run; awaiting approval (rivetari router (for arynbht@gmail.com))
- 2026-11-23 07:19 route: route approved; assembly sha256 4907ecd262d5c1154132a395714ff8e10f44bd1d64d41a6480e9bdb2913e0940 (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 07:19 isolate: worktree .worktrees/T-0018 · branch fix/t-0018 from origin/main (9ac4aca420d0) · port 5175 · db rivetari_t0018 · env sha256 365132c6db433f08e6c76187aefd56d9dad08ebf303c673f96084d36effcd31a (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 07:20 build: build started · skills spine only · budget 8 steps / 60k ctx · 53 repo file(s) in context · 357087 tokens · $0.56 · 7 turns (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 07:23 build: build done · commit 150fcefcf1dc · 9 file(s) this round · 1384920 tokens · $1.05 · 30 turns · Intake now refuses a touches glob that matches more than 20 tracked files, before an id is reserved. The new tests, the existing intake and CLI tests, typecheck and lint all pass. I didn't run the ful (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 07:23 prove: proof deferred · test-run: the judge's tier 1 run on the change is the proof (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 07:31 prove: proof passed · test-run (the judge's tier 1 run) (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 07:32 judge: judge passed · round 1 · head 150fcefcf1dc · record sha256 d3f0dcaf16d90b0c6e02d918877d18ad62fd6a7791f8ad62cb5f2a9b2ada5f92 (rivetari judge (for arynbht@gmail.com))
- 2026-11-23 07:32 ship: draft PR opened: #190 https://github.com/arynbht/Rivetari/pull/190 · fix/t-0018 at 150fcefcf1dc → main (rivetari runtime (for arynbht@gmail.com))

## Plan

- 2026-11-23 07:20 1. Add packages/runtime/src/task/touches.ts. Export TOUCHES_CAP = 20 and an async checkTouches(repoPath, touches). It lists the repo's tracked files with simpleGit(repoPath).raw(["ls-files", "-z"]), the way router/task-route.ts already does, and checks only entries that picomatch.scan reports as globs, matching them with picomatch(glob, { dot: true }). A glob that matches more than 20 files throws CardError with one issue per glob. Each issue names the glob, the number of files it matches and the first 5 of them, and asks for the files by name or a narrower glob. Plain paths, globs matching 20 or fewer files and globs matching nothing are accepted. A directory that isn't a git repo (checked with checkIsRepo) has no tracked files, so its globs are accepted. Any other git failure is rethrown with context, so the check fails closed.
- 2026-11-23 07:20 2. In packages/runtime/src/task/tasks.ts, call checkTouches(repoPath, card.touches) in newTask right after parseCard and before ignoreTasks or mkdir, so nothing is written for a refused card. Also re-export checkTouches and TOUCHES_CAP from packages/runtime/src/index.ts next to the tasks.js exports. index.ts isn't in the card's touches, but this is a one-line export the CLI needs.
- 2026-11-23 07:20 3. In packages/cli/src/commands/task.ts runTaskNew, call checkTouches(repo, card.touches ?? []) after the existing parseCard pre-check and before reserveTaskId. This covers both --touches and --from YAML, since `input` already merges the two. The existing guarded() wrapper prints the CardError and returns 1 without reserving an id.
- 2026-11-23 07:20 4. Add packages/runtime/src/task/touches-cap.test.ts. It builds a temp git repo with 25 tracked files matching a glob and a few others, and checks that checkTouches and newTask reject the broad glob with a message naming the glob, the count 25 and 'name the files'. It checks that a plain path, a glob matching 3 files, a glob matching exactly 20 files and a glob matching no tracked file are accepted (A2), and that newTask leaves no .rivetari/tasks folder behind for a refused card.
- 2026-11-23 07:20 5. Add packages/cli/src/commands/task-touches-cap.test.ts using the same team() origin-and-clone setup as task.test.ts, with 25 committed *.test.ts files. Test A1: runTaskNew with touches ['packages/**/*.test.ts'] returns 1, the error names the glob, the count and asks to name the files or narrow the glob, and `git branch --list rivetari/tasks` is empty. Test A3: the same card given with --from (a YAML file) returns 1 without reserving an id. Test A2 at the CLI: a plain path, a narrow glob and a glob for a new file all draft T-0001, T-0002 and so on.
- 2026-11-23 07:20 6. Add .changeset/touches-cap.md with a minor bump for @arynbht/rivetari-runtime and a patch bump for @arynbht/rivetari, saying that intake refuses a touches glob matching more than 20 tracked files before an id is reserved, and what it accepts.
- 2026-11-23 07:20 7. Run `pnpm vitest related --run` on packages/runtime/src/task/touches.ts, tasks.ts and packages/cli/src/commands/task.ts plus the two new test files, then `pnpm run typecheck` and `pnpm run lint`. Fix any failures without editing existing tests and without adding comments.
- 2026-11-23 07:20 8. Run `pnpm action:build` and commit the rebuilt packages/action/dist/ together with the source, the tests and the changeset.

## Decisions

- 2026-11-23 07:19 routed to testing, docs: testing (touches **/*.test.* (packages/runtime/src/task/touches-cap.test.ts); "test" in the description), docs (touches **/*.md (.changeset/*.md); skill native-writing triggers on **/*.md (.changeset/*.md))
- 2026-11-23 07:19 native-writing matched but isn't available (not locked, not synced, or blocked at sync)

## Proof

- 2026-11-23 07:31 tests passed (npm test, exit 0, in the judge's tier 1 run on the change) · new tests: packages/cli/src/commands/task-touches-cap.test.ts: refuses --touches 'packages/**/*.test.ts' before reserving an id; packages/cli/src/commands/task-touches-cap.test.ts: gives a card from --from YAML the same check; packages/cli/src/commands/task-touches-cap.test.ts: drafts a card naming a plain path, a narrow glob and a glob for new files; packages/runtime/src/task/touches-cap.test.ts: refuses a glob matching more than the cap, naming it, its count and some files; packages/runtime/src/task/touches-cap.test.ts: refuses the card in newTask and writes nothing for it; packages/runtime/src/task/touches-cap.test.ts: accepts a plain path, a narrow glob, a glob at the cap and a glob matching nothing; packages/runtime/src/task/touches-cap.test.ts: accepts any glob in a folder that isn't a git repo
- 2026-11-23 07:31 output: … increase limit (node:17252) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 24 close listeners added to [Socket]. MaxListeners is 12. Use emitter.setMaxListeners() to increase limit (node:17252) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 24 finish listeners added to [Socket]. MaxListeners is 12. Use emitter.setMaxListeners() to increase limit
- 2026-11-23 07:31 evidence: the judge's test run on the evidence branch: https://github.com/arynbht/Rivetari/blob/evidence/T-0018/test-run.txt?raw=true

## Judge

- 2026-11-23 07:31 tier 1 round 1: pass · 9/9 pass
- 2026-11-23 07:32 review round 1: approve; 0 blocking, 4 suggestion(s) (claude-opus-5-5) · 3975 tokens · $0.17
- 2026-11-23 07:32 acceptance A1: met — The CLI test seeds 25 matching files and checks for exit 1, the glob in the message, the count, the narrow/name request, and no rivetari/tasks branch. The check runs before reserveTaskId.
- 2026-11-23 07:32 acceptance A2: met — The CLI test drafts a card with a plain path, one with a 10-file glob and one with a glob matching nothing. The runtime test also accepts a glob matching exactly 20 files.
- 2026-11-23 07:32 acceptance A3: met — The CLI test with --from YAML refuses the over-cap glob and reserves no id.
- 2026-11-23 07:32 judge review posted: https://github.com/arynbht/Rivetari/pull/190#pullrequestreview-6017889870
