# T-0009 · Skip generated files when looking for new check suppressions

<!-- Written by the factory runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-22 21:45 intake: card drafted with 3 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-22 21:46 intake: intake confirmed; card sha256 0d352309a3e5ccb35c0372d87ca0e08dc706e90246bb18a9bcf3a871c5dffb79 (factory runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-22 21:46 route: assembly proposed; sha256 0af484bbdca0729e02a26538ba19ec088b6334fb6bfc8169490320fd27224e0c; skills none; proof test-run; awaiting approval (factory router (for arynbht@gmail.com))
- 2026-11-22 21:46 route: route approved; assembly sha256 0af484bbdca0729e02a26538ba19ec088b6334fb6bfc8169490320fd27224e0c (arynbht@gmail.com (--yes))
- 2026-11-22 21:46 isolate: worktree .worktrees/T-0009 · branch fix/t-0009 from origin/main (ac2b17f69f6c) · port 5174 · db software_factory_dev_t0009 · env sha256 03a32bdd0f6da3689658a57c79819c6cf56bad43ec3b70b3b030d00a4289c2a5 (factory runtime (for arynbht@gmail.com))
- 2026-11-22 21:47 build: build started · skills spine only · budget 8 steps / 60k ctx · 54 repo file(s) in context · 783905 tokens · $0.99 · 10 turns (factory runtime (for arynbht@gmail.com))
- 2026-11-22 21:54 build: build paused: 2 thing(s) to ask about · commit 59582d368250 · 3140684 tokens · $1.86 · 41 turns (factory runtime (for arynbht@gmail.com))

## Plan

- 2026-11-22 21:47 1. Move GENERATED, isGeneratedPath and generatedPaths from packages/runtime/src/judge/tier2.ts into packages/runtime/src/judge/protected.ts, unchanged, and have tier2.ts import them from protected.js and re-export them. tier1 can't import from tier2: tier2 already imports parseNameStatus from tier1, and .dependency-cruiser.mjs has a no-circular rule. tier2.ts isn't named in the card's touches, so mention that in the PR.
- 2026-11-22 21:47 2. In protected.ts, give findProtected an optional fourth parameter `generated: ReadonlySet<string>` and skip the SUPPRESSION scan of added lines for those paths. Path-based findings (factory state, lint and CI config, existing tests, scripts) stay as they are. Update the doc comment to say why: a rebuilt bundle re-adds minified lines that carry the runtime's own suppression pattern.
- 2026-11-22 21:47 3. In diff-rules.ts, add a `generated?: ReadonlySet<string>` option to DiffRuleOptions and drop lines from those paths in suppressionHits, next to the allowedSuppressions filter. Source files and test files that aren't generated are still checked for suppressions and skipped tests.
- 2026-11-22 21:47 4. In agent/stops.ts, import generatedPaths from ../judge/protected.js. Compute `generated` once from [...added.keys()] before the findProtected call, pass it to findProtected, and reuse it in the secret loop that follows so there's one lookup and one comment.
- 2026-11-22 21:47 5. In judge/tier1.ts runTier1, after parseAddedLines, compute generatedPaths(repo, [...added.keys()]) from protected.js. Pass it to findProtected, which then doesn't make the verdict needs-human for a suppression in a generated file, and as the `generated` option to diffRules for diff.no-new-suppressions.
- 2026-11-22 21:47 6. Add new test files only; existing ones like agent.test.ts and protected.test.ts are protected. packages/runtime/src/agent/stops.test.ts runs findStops on a temp git repo with a minimal assembly (stop_and_ask: []). A1: an added `// eslint-disable-next-line` in packages/action/dist/index.js gives no protected_path stop. A3: the same line in src/a.ts gives a protected_path stop with reason suppression. A linguist-generated file listed in .gitattributes is skipped too.
- 2026-11-22 21:47 7. Add packages/runtime/src/judge/generated-suppressions.test.ts. A2: diffRules passes diff.no-new-suppressions when the only suppression-shaped line is in a path in `generated`, and findProtected with the same set returns no suppression finding. A3: an eslint-disable in src/b.ts still fails diff.no-new-suppressions and still gives a suppression finding. Add a .changeset/generated-suppressions.md patch for @arynbht/factory-runtime that explains the T-0008 stop. Run `pnpm action:build` and commit the rebuilt packages/action/dist.
- 2026-11-22 21:47 8. Run pnpm run lint, pnpm run typecheck, pnpm run test (at least the runtime package) and the boundaries check, so no-circular confirms the move broke the tier1/tier2 cycle. Fix anything new that fails, then confirm git diff stays within the card's touches plus tier2.ts.

## Decisions

- 2026-11-22 21:46 routed to docs, testing: docs (touches **/*.md (.changeset/*.md); skill native-writing triggers on **/*.md (.changeset/*.md)), testing (touches **/*.test.* (packages/runtime/src/**/*.test.ts))
- 2026-11-22 21:46 under the threshold, for the approver: security
- 2026-11-22 21:46 native-writing matched but isn't available (not locked, not synced, or blocked at sync)

## Stop-and-ask

- 2026-11-22 21:54 asked: protected_path: packages/action/dist/index.js — adds a check suppression: `)}`]}var VG=ue(fn(),1);var t0=ue(fn(),1),mt={factoryState:[".factory/**"],skillRegistry:[".factory/skills.lock",".facto
- 2026-11-22 21:54 asked: protected_path: packages/runtime/src/agent/stops.test.ts — adds a check suppression: it("still stops for an eslint-disable added in a source file", async () => {
