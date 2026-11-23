# T-0021 · Decide keyword-only borderline sectors as not in, without holding the route

<!-- Written by Rivetari runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-23 08:25 intake: card drafted with 4 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-23 08:25 intake: intake confirmed; card sha256 e909b1462b11fcdf098e49db79b10a53ff3edb574536e03990cccee2b387db7e (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 08:25 route: assembly proposed; sha256 e90dda38a000ae8c16d6999c2d485b03ba2c36db9aee0412f0c099d9168fdb9d; skills none; proof infra-plan; awaiting approval (rivetari router (for arynbht@gmail.com))
- 2026-11-23 08:26 route: assembly proposed; sha256 e90dda38a000ae8c16d6999c2d485b03ba2c36db9aee0412f0c099d9168fdb9d; skills none; proof infra-plan; awaiting approval (rivetari router (for arynbht@gmail.com))
- 2026-11-23 08:26 route: route approved; assembly sha256 e90dda38a000ae8c16d6999c2d485b03ba2c36db9aee0412f0c099d9168fdb9d (arynbht@gmail.com (--yes))
- 2026-11-23 08:27 isolate: worktree .worktrees/T-0021 · branch fix/t-0021 from origin/main (2b401948e6b9) · port 5175 · db rivetari_t0021 · env sha256 9f3b061e404061672b4f3bdac7ec385878633e2194fde92375d834051a4b3ac0 (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 08:28 build: build started · skills spine only · budget 12 steps / 60k ctx · 6 repo file(s) in context · 295905 tokens · $0.54 · 9 turns (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 08:28 build: build paused: 1 thing(s) to ask about · commit 2b401948e6b9 · 195440 tokens · $0.35 · 5 turns (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 08:29 close: worktree removed · branch fix/t-0021 kept (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 08:29 close: ledger sealed · abandoned (rivetari runtime (for arynbht@gmail.com))

## Plan

- 2026-11-23 08:28 1. Before editing anything, raise a conflict with the person and stop with a RIVETARI_STOP line. The existing CLI test packages/cli/src/commands/task.test.ts:188 ('at review-at-pr, stops once at the route with the reason when a sector is borderline') expects the route to be held with 'borderline sector(s): ui'. Its card is 'Fix the login redirect' / 'After login the app lands on a blank page.', so ui scores exactly 1, from "page" in the description alone. No ui-sector manifest triggers on page, login, redirect or blank, so that ui is keyword-only. This fix would approve that route, which fails the test, and A4 (plus 'no existing test changes') forbids editing it. It is also outside the card's touches. Ask whether that test may be changed, for example to a borderline that scores from a path or manifest trigger, or how else to proceed. Make no edits until the answer comes.
- 2026-11-23 08:28 2. In packages/runtime/src/router/route.ts, record during scoring which sectors got points only from description keywords (the `"<word>" in the description` branch), with no path, title keyword, manifest trigger or IaC point. Do this with a per-sector flag or a reason-kind set rather than by parsing reason strings.
- 2026-11-23 08:28 3. In route.ts, add a field to Routing, e.g. `notIn: { sector: Sector; reason: string }[]`, with the reason 'scored only on description keywords'. It lists each borderline sector that is keyword-only. Leave `borderline` unchanged so those sectors still show for display and route.test.ts's perf expectation still holds. Add a JSDoc for the field in the file's style, and make sure the diff adds no `//` comments.
- 2026-11-23 08:28 4. In packages/runtime/src/router/task-route.ts routeTask, keep the existing 'under the threshold, for the approver: …' decision line exactly as it is, since task-route.test.ts asserts it. After it, append one decision entry for keyword-only sectors, e.g. 'decided not in: observability, perf (scored only on description keywords)', so the ledger's route line says each was decided not-in.
- 2026-11-23 08:28 5. In packages/runtime/src/task/autonomy.ts advanceTask, for a fresh route pass `routed.routing.borderline` minus the `routing.notIn` sectors to routeConcerns. Keep routeConcerns' signature and behaviour unchanged so autonomy.test.ts still passes.
- 2026-11-23 08:28 6. In autonomy.ts borderlineOf (the resume path, where assembly.yml already exists), also parse the latest route 'decided not in: … (…)' ledger line with a new regex and subtract those sectors from the borderline list. A task routed before approval and then resumed should not be held either. Ledgers written before this change have no such line, so their behaviour stays the same.
- 2026-11-23 08:28 7. If the new export or type is part of the runtime's public surface, export it from packages/runtime/src/index.ts next to routeConcerns. Check whether index.ts is in touches; if it isn't, skip this and keep the type reachable through route.ts.
- 2026-11-23 08:28 8. Write packages/runtime/src/task/keyword-borderline.test.ts as a new file, reusing the temp-repo and git setup pattern from autonomy.test.ts (profile with autonomy: review-at-pr, loadManifests, empty available). For A1: route() on a fix card 'Fix total so it sums' whose description mentions 'metrics', touching src/total.js. Expect observability in borderline, not in assembly.sectors, and in notIn with the description-keywords reason.
- 2026-11-23 08:28 9. In the new test file, cover A2. advanceTask on that card at review-at-pr gives waiting undefined, task.approved true, and a 'route approved without asking' entry, and the ledger contains the 'decided not in: observability' line. Add a resume case: routeTask first, then advanceTask, which reads the ledger through borderlineOf and is also approved.
- 2026-11-23 08:28 10. In the new test file, cover A3. A card touching src/styles/tokens.ts gets ui scored only from the frontend-design manifest path trigger. A repo whose files include infra/main.tf (not touched) gets infra scored only from IaC. In each case advanceTask leaves the route unapproved, waiting contains 'borderline sector(s): ui' / 'infra', and notIn does not list that sector.
- 2026-11-23 08:28 11. Run `pnpm vitest related --run` on route.ts, task-route.ts, autonomy.ts and the new test file, plus `pnpm run typecheck` and `pnpm run lint`. Confirm that route.test.ts, task-route.test.ts and autonomy.test.ts pass unmodified. Then check `git diff --stat` and confirm no test file that existed at base changed (A4).
- 2026-11-23 08:28 12. Run `pnpm action:build` and commit the rebuilt packages/action/dist/**. Add .changeset/keyword-borderline.md with '@arynbht/rivetari-runtime': minor and '@arynbht/rivetari': patch, a plain-sentence summary of the change. Make sure the diff adds no new comments or suppressions.

## Decisions

- 2026-11-23 08:25 routed to testing, docs, infra: testing (touches **/*.test.* (packages/runtime/src/task/keyword-borderline.test.ts); "test" in the description), docs (touches **/*.md (.changeset/keyword-borderline.md); skill native-writing triggers on **/*.md (.changeset/keyword-borderline.md)), infra ("iac" in the description; skill terraform-skill triggers on iac)
- 2026-11-23 08:25 under the threshold, for the approver: security, perf, workflow, observability
- 2026-11-23 08:25 native-writing matched but isn't available (not locked, not synced, or blocked at sync)
- 2026-11-23 08:25 terraform-skill matched but isn't available (not locked, not synced, or blocked at sync)
- 2026-11-23 08:25 infra: no vendored skill covers it; the agent works from the spine
- 2026-11-23 08:26 routed to testing, docs, infra: testing (touches **/*.test.* (packages/runtime/src/task/keyword-borderline.test.ts); "test" in the description), docs (touches **/*.md (.changeset/keyword-borderline.md); skill native-writing triggers on **/*.md (.changeset/keyword-borderline.md)), infra ("iac" in the description; skill terraform-skill triggers on iac)
- 2026-11-23 08:26 under the threshold, for the approver: security, perf, workflow, observability
- 2026-11-23 08:26 native-writing matched but isn't available (not locked, not synced, or blocked at sync)
- 2026-11-23 08:26 terraform-skill matched but isn't available (not locked, not synced, or blocked at sync)
- 2026-11-23 08:26 infra: no vendored skill covers it; the agent works from the spine

## Stop-and-ask

- 2026-11-23 08:28 asked: agent_question: Can I change the existing test packages/cli/src/commands/task.test.ts:188 (and add it to touches), for example so its card touches `src/styles/**` and `ui` holds the route through the frontend-design path trigger instead of the keyword "page"? Without that change, the fix makes that test fail, and A4 forbids editing it.

## Outcome

- 2026-11-23 08:29 abandoned: redrafted to name the one existing-test change bug 9 needs (task.test.ts:188's input) · 4m · 491k tokens · $0.89
