# T-0025 · Have init use the stack detector and seed the banned list from it

<!-- Written by Rivetari runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-23 11:10 intake: card drafted with 5 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-23 11:10 intake: intake confirmed; card sha256 d60bfba485fadad1646a148c60184e6b0fbebdb0544e5a460d573418a3e945fa (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 11:10 route: assembly proposed; sha256 cefadfd4ef51cfaaa98a234ff75032d61bcd8f238a1e94d30fdf6a145722f8ad; skills none; proof test-run; awaiting approval (rivetari router (for arynbht@gmail.com))
- 2026-11-23 11:10 route: route approved; assembly sha256 cefadfd4ef51cfaaa98a234ff75032d61bcd8f238a1e94d30fdf6a145722f8ad (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 11:11 isolate: worktree .worktrees/T-0025 · branch fix/t-0025 from origin/main (e715d3272439) · port 5177 · db rivetari_t0025 · env sha256 68a549d42fa02ef7b684340a44984ac036a2a98c7b4e062ea19fbe0b83dd646d (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 11:11 build: build started · fast path (low risk, 2 source file(s)): planned from the card's criteria, no plan call · budget 8 steps / 60k ctx (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 17:06 build: build done · commit a6165704fed8 · 5 file(s) this round · 1029814 tokens · $0.92 · 22 turns · I've finished the change and the rebuilt action bundle. Now I'm writing up the summary. (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 17:06 prove: proof deferred · test-run: the judge's tier 1 run on the change is the proof (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 17:13 close: worktree removed · branch fix/t-0025 kept (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 17:13 close: ledger sealed · abandoned (rivetari runtime (for arynbht@gmail.com))

## Plan

- 2026-11-23 11:11 1. A1: init without --stack in a repo with package.json and tsconfig.json writes a profile whose stack is the detected stacks (node and typescript), not an empty list
- 2026-11-23 11:11 2. A2: the banned.json init seeds for that repo has the node stack defaults, not an empty list
- 2026-11-23 11:11 3. A3: --stack values are normalised through declaredStacks and merged with the detected stacks without duplicates
- 2026-11-23 11:11 4. A4: a repo with nothing detected and no --stack still gets stack: [] and an empty banned list, and an existing banned.json is left as it is
- 2026-11-23 11:11 5. A5: no test file that existed at base is modified

## Decisions

- 2026-11-23 11:10 routed to docs, data, testing: docs (touches **/*.md (.changeset/init-detects-stack.md); skill native-writing triggers on **/*.md (.changeset/init-detects-stack.md)), data ("seed" in the title), testing (touches **/*.test.* (packages/cli/src/commands/init-stack.test.ts))
- 2026-11-23 11:10 native-writing matched but isn't available (not locked, not synced, or blocked at sync)
- 2026-11-23 11:10 data: no vendored skill covers it; the agent works from the spine

## Outcome

- 2026-11-23 17:13 abandoned: hung: no agent timeout (bug 20) · 6h03m · 1030k tokens · $0.92
