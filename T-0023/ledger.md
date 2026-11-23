# T-0023 · Count cache tokens in the CLI transport's usage

<!-- Written by Rivetari runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-23 09:08 intake: card drafted with 4 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-23 09:08 intake: intake confirmed; card sha256 573106059d6b64ab084176bfdd6d3ca30c0d1b086a24f4302935fedd92645818 (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 09:08 route: assembly proposed; sha256 ff2f595d1c8f7dab81e727745146044f3577285d526329f4222d727f5b76c75e; skills none; proof test-run; awaiting approval (rivetari router (for arynbht@gmail.com))
- 2026-11-23 09:08 route: route approved; assembly sha256 ff2f595d1c8f7dab81e727745146044f3577285d526329f4222d727f5b76c75e (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 09:08 isolate: worktree .worktrees/T-0023 · branch fix/t-0023 from origin/main (2b401948e6b9) · port 5176 · db rivetari_t0023 · env sha256 fb45b98e8e4969117b546e80b0ed68543bddc108efd4dcba9fd590cae3656e90 (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 09:09 build: build started · skills spine only · budget 8 steps / 60k ctx · 7 repo file(s) in context · 247479 tokens · $0.38 · 9 turns (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 09:16 build: build done · commit 2577f1484e35 · 9 file(s) this round · 717756 tokens · $0.60 · 21 turns · The CLI transport now counts cache tokens, and the judge's token total and cost estimate include them. The 414 tests related to the changed files pass, and lint and typecheck are clean. That partial t (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 09:16 prove: proof deferred · test-run: the judge's tier 1 run on the change is the proof (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 09:25 prove: proof passed · test-run (the judge's tier 1 run) (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 09:25 judge: judge passed · round 1 · head 2577f1484e35 · record sha256 fa62b68a3c174839ef397d96c262e2ea326bf36282443cf99906973a6c394c2f (rivetari judge (for arynbht@gmail.com))
- 2026-11-23 09:25 ship: draft PR opened: #194 https://github.com/arynbht/Rivetari/pull/194 · fix/t-0023 at 2577f1484e35 → main (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 09:41 close: worktree removed · branch fix/t-0023 deleted (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 09:41 close: ledger sealed · merged (rivetari runtime (for arynbht@gmail.com))

## Plan

- 2026-11-23 09:09 1. In packages/engine/src/ai/types.ts, add `cacheCreationTokens?: number | undefined` and `cacheReadTokens?: number | undefined` to AiUsage. Write no new code comments, because the diff.no-new-comments rule fails the round on any added comment, JSDoc included. Use `| undefined` because tsconfig.base.json turns on exactOptionalPropertyTypes.
- 2026-11-23 09:09 2. In parseClaudeJson in packages/engine/src/ai/claude-cli.ts, read `usage.cache_creation_input_tokens` and `usage.cache_read_input_tokens`. Add `cacheCreationTokens` and `cacheReadTokens` to the returned usage with conditional spreads, only when the CLI's usage has the key. A result without cache fields then still equals exactly `{ inputTokens, outputTokens }`, which keeps the existing toEqual in claude-cli.test.ts passing unchanged.
- 2026-11-23 09:09 3. In estimateCost in packages/engine/src/ai/usage.ts, add `((usage.cacheCreationTokens ?? 0) / 1e6) * inp * 1.25` and `((usage.cacheReadTokens ?? 0) / 1e6) * inp * 0.1` to the input/output sum. Leave the unknown-model 0 path and the existing input/output arithmetic unchanged.
- 2026-11-23 09:09 4. In runTier2's `complete` in packages/runtime/src/judge/tier2.ts, make `usage.tokens` add `res.usage.cacheCreationTokens ?? 0` and `res.usage.cacheReadTokens ?? 0` to input plus output, following the four-key sum in build.ts claudeAgent. Keep the `res.costUsd ?? estimateCost(...)` order so a reported cost still wins, and leave the appendUsage entry shape unchanged.
- 2026-11-23 09:09 5. Add packages/engine/src/ai/cache-usage.test.ts (vitest). A1: parseClaudeJson with both cache_* fields returns them. A3: estimateCost('claude-sonnet-4-6', 1M cache creation) ≈ 3.75 and 1M cache read ≈ 0.3, plus a combined case. A4: a result with no cache fields gives toEqual `{inputTokens, outputTokens}` with no cache keys, and the same estimateCost as before.
- 2026-11-23 09:09 6. A2 needs runTier2, and engine can't import runtime, so add a new packages/runtime/src/judge/tier2-cache-usage.test.ts. This file is outside the card's touches; mention that in the PR. Rebuild the temp-git-repo change and fake AiClient pattern from tier2.test.ts without editing that file. The fake returns usage `{inputTokens:10, outputTokens:5, cacheCreationTokens:1000, cacheReadTokens:20000}`, and the test asserts `result.usage.tokens` equals 21015 times the number of calls.
- 2026-11-23 09:09 7. Add .changeset/cli-cache-usage.md with patch bumps for "@arynbht/rivetari-engine" and "@arynbht/rivetari-runtime" and one plain sentence: the CLI transport now counts cache creation and cache read tokens, and the judge's token total and cost estimate include them. Then run `pnpm action:build` and commit the rebuilt packages/action/dist/.
- 2026-11-23 09:09 8. Run `pnpm build`. Run `pnpm vitest related --run` on packages/engine/src/ai/claude-cli.ts, packages/engine/src/ai/usage.ts, packages/engine/src/ai/types.ts, packages/runtime/src/judge/tier2.ts and the two new test files. Then run `pnpm run lint` and `pnpm run typecheck`. Check with `git diff --stat main` that no test file that existed at base changed and that the diff adds no comments.

## Decisions

- 2026-11-23 09:08 routed to testing, docs: testing (touches **/*.test.* (packages/engine/src/ai/cache-usage.test.ts); "test" in the description), docs (touches **/*.md (.changeset/cli-cache-usage.md); skill native-writing triggers on **/*.md (.changeset/cli-cache-usage.md))
- 2026-11-23 09:08 native-writing matched but isn't available (not locked, not synced, or blocked at sync)

## Proof

- 2026-11-23 09:25 tests passed (npm test, exit 0, in the judge's tier 1 run on the change) · new tests: packages/engine/src/ai/cache-usage.test.ts: parseClaudeJson returns cache creation and cache read tokens; packages/engine/src/ai/cache-usage.test.ts: a result with no cache fields gives the same usage as before; packages/engine/src/ai/cache-usage.test.ts: estimateCost prices cache creation at 1.25x and cache reads at 0.1x the input rate; packages/engine/src/ai/cache-usage.test.ts: estimateCost is unchanged for usage without cache tokens; packages/runtime/src/judge/tier2-cache-usage.test.ts: includes cache creation and cache read tokens; packages/runtime/src/judge/tier2-cache-usage.test.ts: keeps the reported cost over the estimate; packages/runtime/src/judge/tier2-cache-usage.test.ts: totals a result without cache fields as before
- 2026-11-23 09:25 output: …to increase limit (node:6624) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 24 close listeners added to [Socket]. MaxListeners is 12. Use emitter.setMaxListeners() to increase limit (node:6624) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 24 finish listeners added to [Socket]. MaxListeners is 12. Use emitter.setMaxListeners() to increase limit
- 2026-11-23 09:25 evidence: the judge's test run on the evidence branch: https://github.com/arynbht/Rivetari/blob/evidence/T-0023/test-run.txt?raw=true

## Judge

- 2026-11-23 09:25 tier 1 round 1: pass · 9/9 pass
- 2026-11-23 09:25 review round 1: approve; 0 blocking, 2 suggestion(s) (claude-opus-5-5) · 1733 tokens · $0.11
- 2026-11-23 09:25 acceptance A1: met — cache-usage.test.ts checks that parseClaudeJson returns both cache fields.
- 2026-11-23 09:25 acceptance A2: met — tier2-cache-usage.test.ts expects 21_015 tokens, which includes the cache creation and cache read tokens.
- 2026-11-23 09:25 acceptance A3: met — estimateCost adds inp*1.25 and inp*0.1 for the cache tokens, and the tests cover both rates.
- 2026-11-23 09:25 acceptance A4: met — The new tests cover the no-cache usage, total and cost. Every test file in the diff is new.
- 2026-11-23 09:25 judge review posted: https://github.com/arynbht/Rivetari/pull/194#pullrequestreview-6019161072

## Outcome

- 2026-11-23 09:41 PR #194 merged by arynbht 2026-11-23 09:41 · 33m · 967k tokens · $1.09
