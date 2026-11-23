# T-0019 · Record risk and prompt size in history, and flag low-risk cards over $1 in metrics

<!-- Written by Rivetari runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-23 07:33 intake: card drafted with 3 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-23 07:33 intake: intake confirmed; card sha256 6ef962a6e17c8b09af4943c6364c31dfebe0ed72943b8a25af91f578baf2a018 (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 07:33 route: assembly proposed; sha256 3737da17cb2223cad927c7477fe4d798e4429def6cc8b8475349c69cd210012f; skills none; proof test-run; awaiting approval (rivetari router (for arynbht@gmail.com))
- 2026-11-23 07:33 route: route approved; assembly sha256 3737da17cb2223cad927c7477fe4d798e4429def6cc8b8475349c69cd210012f (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 07:33 isolate: worktree .worktrees/T-0019 · branch feature/t-0019 from origin/main (9ac4aca420d0) · port 5176 · db rivetari_t0019 · env sha256 154ab3f01326a9cef67e0b098fb629d7b6fdddab9dc9e10d5d61942b526ddd83 (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 07:34 build: build started · skills spine only · budget 8 steps / 60k ctx · 52 repo file(s) in context · 349670 tokens · $0.49 · 10 turns (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 07:37 build: build done · commit 1ca8c566aecb · 7 file(s) this round · 2305407 tokens · $1.35 · 43 turns · I added the risk and prompt-size fields to closed tasks' history rows and the new cost section to `rivetari metrics`. The new tests pass alongside the existing ship, findings and metrics tests (35 in (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 07:37 prove: proof deferred · test-run: the judge's tier 1 run on the change is the proof (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 07:46 prove: proof passed · test-run (the judge's tier 1 run) (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 07:46 judge: judge passed · round 1 · head 1ca8c566aecb · record sha256 7948aa33577fdd576b0bf4a04ac2868924a49900a87f001b16f9ce7ae7af49e7 (rivetari judge (for arynbht@gmail.com))
- 2026-11-23 07:47 ship: draft PR opened: #191 https://github.com/arynbht/Rivetari/pull/191 · feature/t-0019 at 1ca8c566aecb → main (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 07:47 close: worktree removed · branch feature/t-0019 kept (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 07:47 close: ledger sealed · abandoned (rivetari runtime (for arynbht@gmail.com))

## Plan

- 2026-11-23 07:34 1. In packages/runtime/src/ship/close.ts, add two optional fields to TaskHistoryRow: `risk?: string` and `prompt_tokens?: number`. Add an exported pure helper `promptTokens(task): number | undefined`. It looks only at entries where beat is build, section is timeline and the text starts with `build started`. On those it takes every `~N prompt tokens` figure, allowing commas in N (#189 hasn't landed, so its exact placement on the line is unknown), and returns the largest, or undefined when there is none. It never reads USAGE_AT, so a `~N prompt tokens` note can't change the token or cost totals.
- 2026-11-23 07:34 2. In closeTask's row, set `risk: task.card.risk` and add `prompt_tokens` only when promptTokens returns a number, so JSON.stringify leaves the key out when no line carries a figure. Leave the existing fields, the order of the close steps and the write-once history check as they are.
- 2026-11-23 07:34 3. Add packages/runtime/src/ship/history-cost.test.ts (a new file, so no existing test changes). Follow ship.test.ts's setup: a temp RIVETARI_CONFIG_DIR and a git repo with newTask (risk: low) then confirmTask. Append build-started timeline entries to the ledger with `task.ledger.append`, then `closeTask(..., { abandon: "..." })`. Assert the row and the history.jsonl line have risk 'low' and prompt_tokens equal to the largest figure across two build-started lines. Also assert prompt_tokens is absent from both when no line has a figure. Add a unit test for promptTokens that shows figures on other beats and lines are ignored. (A1)
- 2026-11-23 07:34 4. Make the metrics cost logic testable without GitHub. In packages/cli/src/commands/metrics.ts, add exported `costFlags(rows: TaskHistoryRow[])`, which returns rows where `risk === 'low'` and `cost_usd > 1`, so a row with no risk is never flagged. Add `renderCost(rows)`, which prints a 'Cost' heading, then one line per flagged row with the task id, `$cost_usd.toFixed(2)` and prompt_tokens (or 'n/a'), or a plain line such as '  no low-risk task cost over $1' when there are none. Import the TaskHistoryRow type and historyRows from @arynbht/rivetari-runtime; both are already exported.
- 2026-11-23 07:34 5. In runMetrics, load the rows once with `historyRows(root)` and pass them to `findingsMetrics(root, rows)` so history isn't read twice. Append renderCost's output after renderFindings on both text paths (`--findings` and the full GitHub path), and add a `cost` key holding the flagged rows to both JSON outputs. Leave existing output lines unchanged so metrics.test.ts still passes untouched.
- 2026-11-23 07:34 6. Add packages/cli/src/commands/metrics-cost.test.ts. Write .rivetari/history.jsonl with: a low-risk row at $1.50 with prompt_tokens, a low-risk row at $0.80, a medium-risk row at $3, and a row with no risk field at $5. Run `runMetrics(dir, { findings: true }, { token: null })` with stdout spied, as metrics.test.ts does. Assert the flagged row's id, $1.50 and prompt_tokens are printed and that the other three ids are not in the cost section (A2, A3). Add a second test where nothing qualifies and assert the none line. Add direct costFlags and renderCost cases for a low-risk row with no prompt_tokens and a row with no risk.
- 2026-11-23 07:34 7. Add .changeset/history-risk-prompt-cost.md bumping @arynbht/rivetari-runtime (minor) and @arynbht/rivetari (minor). Write it in plain sentences in the house voice, saying what close now records and what `rivetari metrics` now flags. Then run `pnpm action:build` and commit the rebuilt packages/action/dist/, because packages/runtime/src and packages/cli changed.
- 2026-11-23 07:34 8. Check: build the workspace (`pnpm -r build` or `tsc --build`). Then run `pnpm vitest related --run` on close.ts, history-cost.test.ts, metrics.ts and metrics-cost.test.ts, plus `pnpm run lint` and `pnpm run typecheck`. Confirm the diff adds no code comments or suppressions, and touches nothing outside the card's paths.

## Decisions

- 2026-11-23 07:33 routed to docs, testing, observability: docs (touches **/*.md (.changeset/*.md); skill native-writing triggers on **/*.md (.changeset/*.md)), testing (touches **/*.test.* (packages/runtime/src/ship/history-cost.test.ts)), observability ("metrics" in the title)
- 2026-11-23 07:33 native-writing matched but isn't available (not locked, not synced, or blocked at sync)

## Proof

- 2026-11-23 07:46 tests passed (npm test, exit 0, in the judge's tier 1 run on the change) · new tests: packages/cli/src/commands/metrics-cost.test.ts: lists each low-risk task over $1 with its cost and prompt tokens, and nothing else; packages/cli/src/commands/metrics-cost.test.ts: says so plainly when no low-risk task cost over $1; packages/cli/src/commands/metrics-cost.test.ts: never flags a row written before risk was recorded; packages/cli/src/commands/metrics-cost.test.ts: prints n/a for a flagged task with no prompt size; packages/runtime/src/ship/history-cost.test.ts: writes the card's risk and the largest prompt figure on the build-started lines; packages/runtime/src/ship/history-cost.test.ts: leaves prompt_tokens out when no build-started line carries a figure; packages/runtime/src/ship/history-cost.test.ts: reads only the build-started timeline lines; packages/runtime/src/ship/history-cost.test.ts: is undefined when no line carries a figure
- 2026-11-23 07:46 output: …to increase limit (node:6572) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 24 close listeners added to [Socket]. MaxListeners is 12. Use emitter.setMaxListeners() to increase limit (node:6572) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 24 finish listeners added to [Socket]. MaxListeners is 12. Use emitter.setMaxListeners() to increase limit
- 2026-11-23 07:46 evidence: the judge's test run on the evidence branch: https://github.com/arynbht/Rivetari/blob/evidence/T-0019/test-run.txt?raw=true

## Judge

- 2026-11-23 07:46 tier 1 round 1: pass · 9/9 pass
- 2026-11-23 07:46 review round 1: approve; 0 blocking, 2 suggestion(s) (claude-opus-5-5) · 2370 tokens · $0.13
- 2026-11-23 07:46 acceptance A1: met — close.ts sets `risk` from the card and spreads `prompt_tokens` only when `promptTokens` finds a figure. history-cost.test.ts checks the largest figure (18,400 over 9,200), that the field is left out w…
- 2026-11-23 07:46 acceptance A2: met — `renderCost` lists id, cost and prompt tokens for low-risk rows over $1, and prints 'no low-risk task cost over $1' when there are none. Both cases are tested through `runMetrics`.
- 2026-11-23 07:46 acceptance A3: met — `costFlags` requires `risk === "low"`. A row with no risk and cost 12 is tested and not flagged.
- 2026-11-23 07:47 judge review posted: https://github.com/arynbht/Rivetari/pull/191#pullrequestreview-6018042139

## Outcome

- 2026-11-23 07:47 abandoned: base moved: #190 (PR #191 is left as it is) · 15m · 2657k tokens · $1.97
