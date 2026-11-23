# T-0010 · Let a confirmed card be amended before isolate

<!-- Written by the factory runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-23 01:15 intake: card drafted with 3 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-23 01:15 intake: intake confirmed; card sha256 e0c50a614455ff7f726a934b5b273bb74588c4c726fdd155fc3bb0adf9e3d884 (factory runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 01:15 route: assembly proposed; sha256 8cd772713b490ed28560278d09e3b2a1091416d81d79e7a6422c6383ab1cd8a3; skills none; proof test-run; awaiting approval (factory router (for arynbht@gmail.com))
- 2026-11-23 01:15 route: route approved; assembly sha256 8cd772713b490ed28560278d09e3b2a1091416d81d79e7a6422c6383ab1cd8a3 (factory runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 01:16 isolate: worktree .worktrees/T-0010 · branch fix/t-0010 from origin/main (03bb3e56dc76) · port 5174 · db software_factory_dev_t0010 · env sha256 9d15c6a507918d441fb6abc0c40d041834505a952a2a16a5a20b6430db39c076 (factory runtime (for arynbht@gmail.com))
- 2026-11-23 01:17 build: build started · skills spine only · budget 12 steps / 60k ctx · 46 repo file(s) in context · 283286 tokens · $0.48 · 7 turns (factory runtime (for arynbht@gmail.com))
- 2026-11-23 01:21 build: build done · commit 8cbb2842c1d1 · 5 file(s) this round · 2037497 tokens · $1.28 · 35 turns · A person can now amend a confirmed card up to isolate. After isolate it stays fixed. The new tests for A1, A2 and A3 all pass, along with the existing tests that depend on `tasks.ts`. I ran only those (factory runtime (for arynbht@gmail.com))
- 2026-11-23 01:21 prove: proof deferred · test-run: the judge's tier 1 run on the change is the proof (factory runtime (for arynbht@gmail.com))
- 2026-11-23 01:26 prove: proof passed · test-run (the judge's tier 1 run) (factory runtime (for arynbht@gmail.com))
- 2026-11-23 01:26 judge: judge failed · round 1 · head 8cbb2842c1d1 · tier 1 failed · record sha256 b5968b35b8ad20083e7411ea73174b19352e1262df08b68fd0c953058982e998 (factory judge (for arynbht@gmail.com))
- 2026-11-23 01:28 build: build done · commit 6127477a7ab9 · 3 file(s) this round · 259270 tokens · $0.35 · 9 turns · retry · I fixed the one thing the judge sent back: the "Missing means not routed yet…" comment in `packages/runtime/src/task/tasks.ts`. (factory runtime (for arynbht@gmail.com))
- 2026-11-23 01:28 prove: proof deferred · test-run: the judge's tier 1 run on the change is the proof (factory runtime (for arynbht@gmail.com))
- 2026-11-23 01:33 prove: proof passed · test-run (the judge's tier 1 run) (factory runtime (for arynbht@gmail.com))
- 2026-11-23 01:33 judge: judge passed · round 2 · head 6127477a7ab9 · record sha256 1be2dc9d744795ad2f86abe43c6030626f160be085242c39ca6db3cf4eb0b51d (factory judge (for arynbht@gmail.com))
- 2026-11-23 01:34 ship: draft PR opened: #181 https://github.com/arynbht/software-factory/pull/181 · fix/t-0010 at 6127477a7ab9 → main (factory runtime (for arynbht@gmail.com))

## Plan

- 2026-11-23 01:17 1. In packages/runtime/src/task/tasks.ts add an AMENDED pattern next to CONFIRMED (/^intake amended; card sha256 ([0-9a-f]{64}) \(was ([0-9a-f]{64})\)$/). Add a helper that returns the latest card seal from the ledger: its hash and its entry index, where a seal is a CONFIRMED or AMENDED entry and the last one wins.
- 2026-11-23 01:17 2. Change loadTask so it checks card.yml against the latest seal's hash, not the first. `confirmed` stays true whenever any seal exists. The existing 'card.yml changed after intake was confirmed' problem still fires when the file differs from the latest hash.
- 2026-11-23 01:17 3. In loadTask, count only a route approval that comes after the latest card seal. `approved` is false when the newest APPROVED entry predates the amendment, and the 'assembly.yml changed after the route was approved' check compares against that current approval only. This way a stale approval neither counts nor raises a false problem once the amended card is re-routed.
- 2026-11-23 01:17 4. Make nextStep return `route: \`factory task route <id>\`` when the task is confirmed, not approved, and has no 'assembly proposed; sha256' entry after the latest card seal, even if an old assembly.yml is still on disk. Use a local regex matching task-route.ts's PROPOSED, since task-route.ts is outside the card's touches. Once the amended card has been re-routed, nextStep keeps today's 'review assembly.yml, then approve' step.
- 2026-11-23 01:17 5. Rework confirmTask. If the task isn't confirmed yet, behave as today. If it is confirmed: read card.yml and hash it. If the hash equals the latest seal, keep throwing 'already confirmed' so the existing test still passes. If the task is closed (last entry isSeal) or any entry's beat is isolate or later (BEATS index >= isolate), throw a TaskError saying the card is fixed after isolate, e.g. `task <id>'s card is fixed after isolate; abandon and redraft it to change it`. Leave the problem in place.
- 2026-11-23 01:17 6. For the amend path, still refuse every verification problem other than the card-changed one, so a forged ledger or an edited assembly can't be amended past. Then append beat 'intake', section 'timeline', text `intake amended; card sha256 <new> (was <old>)`, by options.by, at options.now, and return loadTask. The card was already re-validated by parseCard in loadTask. Update the confirmTask doc comment to say what it now does.
- 2026-11-23 01:17 7. Check every caller of confirmTask and task.confirmed/approved (autonomy.ts, task-route.ts ready(), the cli task confirm, which prints 'confirmed; next: route') to confirm they behave correctly after an amendment. routeTask's ready() then accepts the amended task because approved is false. Don't edit files outside the card's touches.
- 2026-11-23 01:17 8. Add packages/runtime/src/task/amend.test.ts, set up like tasks.test.ts: a temp FACTORY_CONFIG_DIR and repo, plus a git repo with a commit for the isolate case. For A1: newTask, confirmTask, edit card.yml, confirmTask with a second `by`; expect the 'intake amended; card sha256 <new> (was <old>)' entry by that person with the right hashes, loadTask().problems empty, and a second confirm with no edit still throwing 'already confirmed'.
- 2026-11-23 01:17 9. For A2 in amend.test.ts: confirm, routeTask and approveRoute with an injected RouteContext (as in router/task-route.test.ts), then edit the card and confirm again. Expect approved false, no problems, and nextStep matching /^route: `factory task route/. Then routeTask and approveRoute again; expect approved true, no problems, and nextStep at isolate.
- 2026-11-23 01:17 10. For A3 in amend.test.ts: take the task through route, approve and isolateTask in a real git repo (or an isolate ledger entry written through task.ledger.append if isolate setup is too heavy). Edit card.yml; expect confirmTask to reject with /fixed after isolate/, and loadTask().problems to still contain 'card.yml changed after intake was confirmed' with no amendment entry appended.
- 2026-11-23 01:17 11. Run `pnpm vitest related --run packages/runtime/src/task/tasks.ts packages/runtime/src/task/amend.test.ts`, plus `pnpm run typecheck` and `pnpm run lint` for the runtime. Add no code comments in new lines, so diff.no-new-comments passes; rewording the confirmTask doc comment in place is fine.
- 2026-11-23 01:17 12. Run `pnpm action:build` and commit the rebuilt packages/action/dist. Add .changeset/amend-card.md ('@arynbht/factory-runtime': minor) explaining in plain sentences that a confirmed card can be amended until isolate, that the ledger records who amended it with the new and old hash, that the route has to be proposed and approved again, and that confirm refuses after isolate.

## Decisions

- 2026-11-23 01:15 routed to docs, testing: docs (touches **/*.md (.changeset/*.md); "docs" in the description; skill native-writing triggers on **/*.md (.changeset/*.md)), testing (touches **/*.test.* (packages/runtime/src/task/amend.test.ts))
- 2026-11-23 01:15 native-writing matched but isn't available (not locked, not synced, or blocked at sync)

## Proof

- 2026-11-23 01:26 tests failed on the change and on the base: pre-existing, not blamed on this change (npm test, exit 1, in the judge's tier 1 run on the change) · new tests: packages/runtime/src/task/amend.test.ts: records the amendment, who made it and both hashes, and verifies; packages/runtime/src/task/amend.test.ts: drops the earlier route approval: route is next, and the new assembly can be approved; packages/runtime/src/task/amend.test.ts: refuses to confirm an edited card and still reports the edit
- 2026-11-23 01:26 output: …[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯[22m[39m [31m[1m[7m FAIL [27m[22m[39m packages/runtime/src/task/store.test.ts[2m > [22mthe task store[2m > [22mkeeps a second machine off a task until the lease expires or is released [31m[1mError[22m: EBUSY: resource busy or locked, rmdir 'C:\Users\arynb\AppData\Local\Temp\factory-clone-yN1l1i'[39m [31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯[22m[39m
- 2026-11-23 01:26 evidence: the judge's test run on the evidence branch: https://github.com/arynbht/software-factory/blob/evidence/T-0010/test-run.txt?raw=true
- 2026-11-23 01:33 tests failed on the change and on the base: pre-existing, not blamed on this change (npm test, exit 1, in the judge's tier 1 run on the change) · new tests: packages/runtime/src/task/amend.test.ts: records the amendment, who made it and both hashes, and verifies; packages/runtime/src/task/amend.test.ts: drops the earlier route approval: route is next, and the new assembly can be approved; packages/runtime/src/task/amend.test.ts: refuses to confirm an edited card and still reports the edit
- 2026-11-23 01:33 output: …[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/4]⎯[22m[39m [31m[1m[7m FAIL [27m[22m[39m packages/runtime/src/task/store.test.ts[2m > [22mthe task store[2m > [22mkeeps a second machine off a task until the lease expires or is released [31m[1mError[22m: EBUSY: resource busy or locked, rmdir 'C:\Users\arynb\AppData\Local\Temp\factory-clone-RpKzcy'[39m [31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/4]⎯[22m[39m
- 2026-11-23 01:33 evidence: the judge's test run on the evidence branch: https://github.com/arynbht/software-factory/blob/evidence/T-0010/test-run.txt?raw=true

## Judge

- 2026-11-23 01:26 tier 1 round 1: fail · 6/9 pass · 2 pre-existing · 1 fail
- 2026-11-23 01:26 tier 1 fail: diff.no-new-comments — new comments: packages/runtime/src/task/tasks.ts: // Missing means not routed yet; any other read error is a real failure.
- 2026-11-23 01:33 tier 1 round 2: pass · 7/9 pass · 2 pre-existing
- 2026-11-23 01:33 review round 2: approve; 0 blocking, 3 suggestion(s) (claude-opus-5-5) · 3644 tokens · $0.15
- 2026-11-23 01:33 acceptance A1: met — amend.test.ts checks the exact 'intake amended; card sha256 <new> (was <old>)' text, by=lead@example.com, and empty problems after reload.
- 2026-11-23 01:33 acceptance A2: met — The test checks approved=false and that nextStep is route after the amend, then reroutes, gets review, approves, and nextStep is isolate. loadTask only counts approvals after the latest seal and treat…
- 2026-11-23 01:33 acceptance A3: met — The test isolates, edits the card, and checks that confirm rejects with 'card is fixed after isolate', that CARD_CHANGED is still a problem, and that no ledger entry was appended.
- 2026-11-23 01:34 judge review posted: https://github.com/arynbht/software-factory/pull/181#pullrequestreview-6015658682
