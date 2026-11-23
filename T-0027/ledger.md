# T-0027 · Tell task PRs not to commit the action bundle

<!-- Written by Rivetari runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-23 17:22 intake: card drafted with 2 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-23 17:23 intake: intake confirmed; card sha256 b95381b6f9c67e5ac7578965abafcff7c4d5e6b38bd3a39451d38fbf6dbb8eaf (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 17:23 route: assembly proposed; sha256 572bc9fa4e3d03991bbacc9755ce0a72c97f66e940ac3a692455324f07e3e4d6; skills none; proof test-run; awaiting approval (rivetari router (for arynbht@gmail.com))
- 2026-11-23 17:23 route: route approved; assembly sha256 572bc9fa4e3d03991bbacc9755ce0a72c97f66e940ac3a692455324f07e3e4d6 (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 17:23 isolate: worktree .worktrees/T-0027 · branch chore/t-0027 from origin/main (29f786decd08) · port 5177 · db rivetari_t0027 · env sha256 20b19d6670f2762c40d9a5b8de57aede20053893db2de655a89b75e4b3fd341d (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 17:23 build: build started · fast path (low risk, 1 source file(s)): planned from the card's criteria, no plan call · budget 8 steps / 60k ctx (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 17:23 build: build done · commit b937886bbdab · 1 file(s) this round · 162192 tokens · $0.17 · 6 turns · I've replaced the action-bundle rule in the "This repo" section of `AGENTS.md`, and nothing else in the file changed. (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 17:23 prove: proof deferred · test-run: the judge's tier 1 run on the change is the proof (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 17:42 prove: proof passed · test-run (the judge's tier 1 run) (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 17:42 judge: judge passed · round 1 · head b937886bbdab · record sha256 db4009ef21100b336b097c8b568072d234268bb9d809bc0d4b359f5f0053ed99 (rivetari judge (for arynbht@gmail.com))
- 2026-11-23 17:42 ship: draft PR opened: #197 https://github.com/arynbht/Rivetari/pull/197 · chore/t-0027 at b937886bbdab → main (rivetari runtime (for arynbht@gmail.com))

## Plan

- 2026-11-23 17:23 1. A1: AGENTS.md's This repo section no longer asks for pnpm action:build with a committed dist, and says task PRs don't commit packages/action/dist or the copied assets, that CI builds the bundle on every PR, that the Version Packages PR rebuilds it, and that the action should be pinned to a release commit
- 2026-11-23 17:23 2. A2: the change touches only AGENTS.md and commits nothing under packages/action

## Decisions

- 2026-11-23 17:23 routed to docs, workflow: docs (touches **/*.md (AGENTS.md); skill native-writing triggers on **/*.md (AGENTS.md)), workflow ("ci" in the description; "workflow" in the description; "release" in the description)
- 2026-11-23 17:23 native-writing matched but isn't available (not locked, not synced, or blocked at sync)

## Proof

- 2026-11-23 17:42 tests passed (npm test, exit 0, in the judge's tier 1 run on the change) · new tests: none
- 2026-11-23 17:42 output: …to increase limit (node:9720) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 24 close listeners added to [Socket]. MaxListeners is 12. Use emitter.setMaxListeners() to increase limit (node:9720) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 24 finish listeners added to [Socket]. MaxListeners is 12. Use emitter.setMaxListeners() to increase limit
- 2026-11-23 17:42 evidence: the judge's test run on the evidence branch: https://github.com/arynbht/Rivetari/blob/evidence/T-0027/test-run.txt?raw=true

## Judge

- 2026-11-23 17:42 tier 1 round 1: pass · 9/9 pass
- 2026-11-23 17:42 review round 1: approve; 0 blocking, 1 suggestion(s) (claude-sonnet-5-5) · 7191 tokens · $0.03
- 2026-11-23 17:42 acceptance A1: met — The old action:build/committed dist rule is replaced. The new bullet says task PRs don't commit packages/action/dist or the copied assets (controls, gates, templates, prompts, skill), CI builds the bu…
- 2026-11-23 17:42 acceptance A2: met — The diff touches only AGENTS.md and has no changes under packages/action. The rest of AGENTS.md is unchanged.
- 2026-11-23 17:42 judge review posted: https://github.com/arynbht/Rivetari/pull/197#pullrequestreview-6026518454
