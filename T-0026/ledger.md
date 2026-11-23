# T-0026 · Rebuild the action bundle at release instead of on every PR

<!-- Written by Rivetari runtime from ledger.jsonl. Don't edit: changes are detected. -->

## Timeline

- 2026-11-23 17:17 intake: card drafted with 5 acceptance criteria; awaiting confirmation (arynbht@gmail.com)
- 2026-11-23 17:17 intake: intake confirmed; card sha256 fa1c2e7225d4a48f9de77018716a54b316458e94fade705e486c3b366a7bfba2 (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 17:17 route: assembly proposed; sha256 13896cf854e50fbed03cd1852d9bdfcb7ac992743f9364103618a780596d02b8; skills none; proof test-run; awaiting approval (rivetari router (for arynbht@gmail.com))
- 2026-11-23 17:17 route: route approved; assembly sha256 13896cf854e50fbed03cd1852d9bdfcb7ac992743f9364103618a780596d02b8 (rivetari runtime (autonomy review-at-pr, for arynbht@gmail.com))
- 2026-11-23 17:18 isolate: worktree .worktrees/T-0026 · branch chore/t-0026 from origin/main (29f786decd08) · port 5177 · db rivetari_t0026 · env sha256 e39f66ef4e6989d1e50d89d328b88e40ee3399b611efac8d8a3e515deb3a03a0 (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 17:18 build: build started · skills spine only · budget 12 steps / 60k ctx · 4 repo file(s) in context · 70151 tokens · $0.20 · 3 turns (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 17:19 build: build paused: 1 thing(s) to ask about · commit 29f786decd08 · 243798 tokens · $0.28 · 8 turns (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 17:20 close: worktree C:\Users\arynb\Documents\Projects\Rivetari\.worktrees\T-0026 kept: it has uncommitted edits; remove it by hand · branch chore/t-0026 kept (rivetari runtime (for arynbht@gmail.com))
- 2026-11-23 17:20 close: ledger sealed · abandoned (rivetari runtime (for arynbht@gmail.com))

## Plan

- 2026-11-23 17:18 1. Read scripts/build-action.mjs to confirm what `pnpm action:build` writes: dist/index.js, dist/SOURCE_SHA256 and the copied controls, gates, templates, prompts and skill. It runs `pnpm build` first, so a workflow only needs an install before calling it. This confirms the asset list the ci.yml diff has to cover.
- 2026-11-23 17:18 2. In .github/workflows/ci.yml, replace the 'Check action bundle is current' step with a 'Build action bundle' step that runs on every event. It runs `pnpm action:build` then `test -s packages/action/dist/index.js`, so it fails only when the build fails or index.js is empty (A1). Remove the old inline comment about platform-varying bytes instead of rewording it, so the diff adds no comments.
- 2026-11-23 17:18 3. Add a second ci.yml step after it, 'Check action bundle is current', with `if: github.event_name == 'pull_request' && github.head_ref == 'changeset-release/main'`. It keeps the existing `git diff --exit-code` over packages/action/{controls,gates,templates,prompts,skill} and packages/action/dist/SOURCE_SHA256, so that diff runs only on the Version Packages PR (A1).
- 2026-11-23 17:18 4. In .github/workflows/release.yml, change the changesets/action `version:` input to `bash -c "pnpm changeset version && pnpm action:build"`. @actions/exec doesn't run `&&` through a shell, so it needs the explicit bash -c with the inner command quoted. The Version Packages commit then carries the rebuilt dist and copied assets (A2). Keep LEFTHOOK=0 and the existing install step, and add no new comments.
- 2026-11-23 17:18 5. In .github/workflows/rivetari.yml, in the audit-pr job, insert these steps between Checkout and 'Rivetari audit': Set up pnpm, Set up Node, Install and 'Build action bundle'. Use the same pinned actions as ci.yml (pnpm/action-setup@b906aff…, actions/setup-node@49933ea… with node-version-file .nvmrc and pnpm cache). Install runs `pnpm install --frozen-lockfile` and the build runs `pnpm action:build` (A3).
- 2026-11-23 17:18 6. Insert the same four steps (pnpm, Node, install, `pnpm action:build`) into rivetari.yml's audit-status job before its `uses: ./packages/action` step, so every job that uses the local action builds it first (A3). Leave permissions, concurrency and triggers unchanged.
- 2026-11-23 17:18 7. Edit AGENTS.md's 'This repo' section only. Replace the bullet saying a change under engine/cli/catalog/runtime needs `pnpm action:build` with dist committed. The new bullet says packages/action/dist and the copied assets (controls, gates, templates, prompts, skill) are generated. Task PRs don't commit them, the release's Version Packages PR rebuilds and commits them, and consumers pin a commit from a release (A4). Keep it in plain sentences with no HTML comments added.
- 2026-11-23 17:18 8. Don't run `pnpm action:build` in the worktree. If any build touches packages/action, restore it with `git checkout -- packages/action` and `git clean` scoped to packages/action. Then confirm `git status --porcelain` shows changes only to the four carded files (A5). Add no changeset, because no published package's source changes.
- 2026-11-23 17:18 9. Check the three YAML files parse (e.g. `node -e` with the repo's yaml package if one is already installed, or `pnpm exec prettier --check` on them). Also run `pnpm format` so the format check stays green with no new warnings.
- 2026-11-23 17:18 10. Read the final diff against the judge's rules. It should add no comments, suppressions, or Markdown outside AGENTS.md, and match conventional naming. Record that the workflow edits touch protected .github/workflows/** paths, which the owner ordered, so the runtime will route them to a person.

## Decisions

- 2026-11-23 17:17 routed to workflow, docs: workflow (touches .github/** (.github/workflows/ci.yml); "ci" in the description; "workflow" in the description; "release" in the title), docs (touches **/*.md (AGENTS.md); skill native-writing triggers on **/*.md (AGENTS.md))
- 2026-11-23 17:17 native-writing matched but isn't available (not locked, not synced, or blocked at sync)

## Stop-and-ask

- 2026-11-23 17:19 asked: agent_question: Edits under .github/workflows/ are denied in this worktree, though the card says the owner ordered them. Can you allow those edits for the next round, or apply the ci.yml, release.yml and rivetari.yml changes above yourself?

## Outcome

- 2026-11-23 17:20 abandoned: workflow edits are denied to the build agent by design; split into an AGENTS.md task and a plain workflow PR (owner's choice) · 3m · 314k tokens · $0.48
