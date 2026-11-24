# @arynbht/rivetari-catalog

## 2.0.0

### Major Changes

- 328afac: The software factory is now **Rivetari**. Everything is renamed, with no compatibility layer: the packages are `@arynbht/rivetari`, `@arynbht/rivetari-engine`, `@arynbht/rivetari-runtime`, `@arynbht/rivetari-catalog` and `@arynbht/rivetari-registry` (the `@arynbht/factory*` names are deprecated); the CLI is `rivetari` and the Claude Code skill `/rivetari`; a repo's state lives in `.rivetari/`, its workflow is `.github/workflows/rivetari.yml`, tasks are shared on the `rivetari/tasks` branch, environment variables are `RIVETARI_*`, the needs-a-person label is `rivetari:needs-human`, and the user's config and cache are `~/.config/rivetari` and `~/.cache/rivetari`. A repo set up with the factory needs `.factory/` moved to `.rivetari/`, its workflow, hooks and skill re-installed with `rivetari init --force`, and its tasks branch copied to `rivetari/tasks`. Ledgers signed before the rename are moved, not rewritten, so their entries still read as they were sealed and still verify.

### Minor Changes

- 4b5c8b2: The profile takes `autonomy: supervised | review-at-pr | unattended`, default `supervised`. At `review-at-pr` the card is confirmed and the route approved without asking, unless the route has a borderline sector or touches a sensitive path. Stops split into hard ones, which still pause the round (protected paths outside existing tests, rewritten history, a secret, a non-local `DATABASE_URL`, a new dependency whose license isn't on the OSI list or can't be read), and soft ones the build goes on past and flags (a new OSI-licensed dependency, a changed existing test, a schema change). The judge is told about flagged decisions, and the draft PR lists them under "Decisions you would have been asked" with the lockfile, schema or test diff inline. A high-risk task keeps every gate at any level. At `unattended`, `rivetari task run --all` runs every routed task in turn and parks any that would ask, which session start lists under "Needs you". Every PR body now carries the card and the route.
- 9db492e: Add a `ci` block to the profile. `ci.budget_minutes_per_month` sets the GitHub Actions minutes the repo means to spend in a month: `rivetari doctor` warns once the month reaches 75% of it, and the status issue shows the month so far against it. Minutes are counted per job and rounded up, as GitHub bills. A closed task's history row records the minutes and runs its PR's CI used (`ci_minutes`, `ci_runs`).

  `ci.trust_judge` decides whether shipping a task the judge passed posts a `rivetari/judge` check run on its head commit, with the judge record's sha256 and the ledger hash, which CI can trust to skip lint, typecheck and tests. Unset, it's true on repos owned by the account Rivetari's App is registered to and false on anyone else's. The App now asks for `checks: write`.

- 71b0956: New CI/CD posture controls check that an installed repo's GitHub Actions follow the fast-CI shape. Four fixes edit the workflows in place and keep their comments; two only suggest the change. `ci.required-aggregator`: one `ci` job needs other PR jobs (a job may be left out on purpose), runs with `if: always()` and reads their results to fail when one failed (the fix adds that job needing every PR job, or turns an existing `ci` job into it). `ci.concurrency-pr-only`: superseded PR runs are cancelled (`cancel-in-progress` on `github.event_name == 'pull_request'`) and default-branch runs are grouped by commit, so they're never cancelled or replaced. `ci.job-timeouts`: every job sets `timeout-minutes` (the fix sets 30). `ci.secret-scan-on-pr` (harden): a PR workflow runs gitleaks or TruffleHog over the PR's commits (the fix adds a `secret-scan` job running TruffleHog, which needs no license on an organization's repo). `ci.docs-skip-build`: docs-only PRs skip build and test; the fix makes no edit and suggests a `changes` job with dorny/paths-filter and which jobs to gate on it, leaving the required `ci` job and the secret scan ungated since GitHub counts a skipped required check as passed, and asks for `ci.required-aggregator` first when there's no `always()` aggregator. `ci.pr-linux-only`: on a private repo, GitHub-hosted Windows and macOS runners stay off pull requests (self-hosted ones don't count); the fix makes no edit, names the jobs and suggests narrowing a mixed OS matrix on PRs or keeping a Windows- or macOS-only job off them, and moving a required `ci` job to Linux. `ci.actions-pinned-sha`'s fix now pins each tag-pinned `uses:` to the commit the tag points at, read from the GitHub API, keeping the tag as a comment. They run on the new `workflow` detector type and `workflow` fix type; a workflow file that doesn't parse fails the check, and the fix notes it and edits the rest. Rivetari's CI workflow template now sets `timeout-minutes` and cancels only PR runs.
- 4b5c8b2: Recurring judge findings can now become rules. Every tier 2 finding carries a stable `pattern` id, and a closed task's history row records its findings by pattern. `rivetari metrics` (and `rivetari metrics --findings`, which needs no GitHub) reports the judge's tier 1 rule count, findings per PR, how often each pattern recurs, and any pattern seen in two or more PRs as a candidate rule. Tier 1 gains three diff rules that fail closed: no new code comments (opt in with `quality.no-new-comments` in the profile), no Markdown added or edited unless the card names it, and no new suppressions or skipped and focused tests. The catalog gains `quality.boundaries.clean`, which runs a repo's `boundaries` script when it has a dependency-cruiser config.
- ad769fc: The floorplan skill (haydenschmitty/floorplan, pinned at v0.11.0) ships as a task-scope registry manifest, and a profile's new `floorplan` flag keeps its map of the codebase in `floorplan/`: `rivetari init` turns it on for new repos and draws one, and closing a merged task updates it. Rivetari runs only the skill's offline scripts, unattended, and the model's answers go through the build agent's transport with their usage logged; a failure is reported and never stops init or close. Profiles without the flag are off. `rivetari eject` removes the map.
- 24781e4: The profile takes an optional top-level `generated` list of globs. Tier 1's `diff.markdown-in-card` no longer fails Markdown under those globs or under `.changeset/`, so a change that regenerates docs (such as `docs/catalog/*.md` after a new catalog control) or adds the changeset a published package needs passes without the card naming those paths. An unnamed README or other hand-written Markdown still fails. The build prompt's line for the rule names the paths it skips.
- 87d646b: Add `proof.auth` to the profile, so UI proof can shoot pages behind sign-in instead of the login redirect. `proof.auth.script` names a JavaScript module whose default export, `async ({ page, context, baseURL }) => {}`, signs in. The proof runner runs it on each side once the app answers and before any screenshot, with rivetari's own Playwright in a child process that gets the allowlisted environment plus PORT and URL, then saves the browser's cookies and local storage as a Playwright storageState in a temp dir and shoots every page, before and after, with it. A script that throws, times out or leaves no cookies or local storage fails the proof saying why: on the base it stops the proof as a setup problem, on the change it's a failed proof sent back to build.
- 0a66e93: Apply the judge decisions: the coverage floor ratchets (profile `quality.coverage`,
  else a baseline recorded in `.rivetari/quality.json` that only moves up) and fails in
  the judge when configured coverage writes no summary; `reviewed` finds drafts by their
  header and requires every draft for the task to be reviewed; the judge sweeps stale
  clones, disables the target repo's hooks, runs tests before reading coverage, and
  won't pass a non-Node repo on checks that are red at base too.
- 0a66e93: Rivetari v2 step 1, "before the judge": `rivetari judge` (tier 1) runs lint,
  typecheck and tests on a clean clone of base plus the change, with scripts,
  `.rivetari/**`, lint/CI config and existing tests taken from base; fails closed,
  compares against base, and marks protected changes `needs-human`. New `quality`
  lane (lint/typecheck/tests pass, coverage floor, required checks); command
  detectors run only in the judge or with `audit --commands`. CI and security
  controls read workflow YAML paths (every action pinned, no `write-all`,
  `--if-present` doesn't count, `rivetari.yml` never counts). Strict control
  schemas, `valid-for` and `managed` on controls, and Claude-fixed controls need a
  filled `reviewed-by:` or evidence.
- ad25e71: Rivetari v2 step 4: judge tier 2. `rivetari review` (local, or `--pr <n>` to post one PR
  review) and `rivetari judge --review` (tier 1, then tier 2 unless tier 1 needs a human).
  Only defects, contract breaches and unmet acceptance criteria block; everything else
  is a suggestion. Each blocking finding is re-checked in a fresh context and downgraded
  without a concrete reproduction. Two rounds, then needs-human. The model sees only the
  packed diff (no sensitive paths, secret-shaped or generated files; source first) and
  the base's AGENTS.md/CONSTRAINTS.md. The Claude CLI transport now runs locked down: no
  tools, safe mode, empty working directory. Judge model from profile `ai.judge_model`.
- cfba43b: Rivetari v2 step 6b: the proof runner. `rivetari task prove <id>` produces the
  assembly's proof with tools. For UI tasks it serves the base and the change side by
  side (profile `proof.start` / `proof.url`), shoots each card `pages:` entry at three
  breakpoints with Playwright, runs axe on the change (serious or critical violations
  fail the proof), and uploads the images to an orphan `evidence` branch through the
  Contents API. Every other proof type runs the test script and names the tests the
  change added. Results go to the ledger and `proof/proof.json`; a failed proof sends
  the task back to build, and the next round is told why.
- 4d5e653: Rivetari v2 step 7b: `/rivetari` as the single entry point.

  - `rivetari init` writes the §10 files without overwriting: an existing file gets
    Rivetari's version beside it as `name.rivetari.ext`. The files are AGENTS.md
    (the contract, with a repo section listing the detected stack and commands),
    CLAUDE.md pointing at it, a CONSTRAINTS.md seed for the judge, the PR template
    with `## Proof`, `.claude/settings.json` hooks, and the v2 `/rivetari` skill. It
    also locks the spine skills and adds `.rivetari/.gitignore` entries.
  - `rivetari task run <id>` takes an approved task through isolate, build, prove,
    judge and ship, reporting each ledger entry as it lands. It stops wherever a
    person is needed, and after four build rounds.
  - `rivetari doctor` checks the profile, the `claude` CLI, GitHub access and skills.
  - `rivetari hook session-start` and `rivetari hook guard`: the guard refuses edits to
    `.rivetari/**`, and edits in the primary checkout while it's on the default branch.

- 0a66e93: Make remediation safe on repos Rivetari did not scaffold (Rivetari v2 §3.1):
  stack detection from manifests (node/python/go/rust, `unknown` skips stack files),
  CI merges find the real job instead of inventing `jobs.ci`, merges into one file
  accumulate in a single run, `merge-json` never overwrites a human's value, SHA-pinned
  first-run-safe CI templates (plus go and rust), `project:` profile fields instead of
  `@OWNER`/`security@example.com` placeholders, `any-of` detectors and `{ file }`
  applicability, phase floor in `status`, severity floor no longer lowers gates,
  `chore(rivetari):` commits, and a 60 s timeout on `command` detectors.

### Patch Changes

- ef50f7b: The packages publish to GitHub Packages (`https://npm.pkg.github.com`, restricted) and name this repo as their source, so a release's publish step reaches them and links each package to the repo.
- da6ad10: The `/rivetari` skill follows what `rivetari task new` already does above `supervised`: when the CLI says it confirmed the card and approved the route and prints `next: rivetari task run <id>`, the skill goes straight to the run instead of asking. When the CLI stops at the route with a reason, the skill shows the reason and asks once.
- ce71405: Rivetari v2.1 step 7b: the guardrails fail closed.

  - `rivetari init --force` never deletes: the profile and `rivetari.yml` it replaces
    are backed up, and waivers and evidence are written only when missing.
  - `init` merges its hooks into an existing `.claude/settings.json` (backing it up)
    instead of writing a sibling file Claude Code never reads; a re-run replaces an
    earlier init's hooks rather than adding a second set.
  - The guard hook fails closed: `rivetari hook guard || exit 2` blocks the call when
    `rivetari` can't run. It now covers Bash too: writes through redirects, `tee`,
    `cp`, `mv`, `rm`, `sed -i` and the like to anything the edit guard protects, and
    git commands that destroy work (force push, remote delete, `reset --hard`,
    `clean -f`, `branch -D`). Bash checks are a heuristic; the judge is the backstop.
  - `rivetari hook session-start` says on its first line whether the guard is on, and
    `rivetari doctor` fails until the hook is installed and `rivetari` runs from a shell.
  - The Node CI template runs only the lint, typecheck and test scripts the repo has,
    without `--if-present`; the `dev.linter.in-ci` and `test.runner.in-ci` fixes add
    real steps and deduplicate on the command, not the step name.
  - `rivetari review --pr` deletes its `refs/rivetari/pr-<n>` ref when it's done.

- 9d2955f: Rivetari v2.1 step 7b: tasks live in the repo, on a `rivetari/tasks` branch.

  - Each task's record (card, assembly, ledger, env, judge rounds, proof) is a
    subtree of `rivetari/tasks`. Every `rivetari task` beat pulls the branch, runs,
    and pushes what it wrote, even when it failed part-way. A push only replaces
    that task's subtree, so a push that loses a race is redone on the new tip,
    and two people on different tasks never conflict. Without an origin, the
    branch is local.
  - A lease (`lease.json`: holder and expiry, two hours past the last write) keeps
    two machines off one task. Another machine is refused before anything runs,
    until the lease expires or the holder runs `rivetari task release <id>`.
    `task resume` shows who holds a task.
  - Task ids are reserved on the branch, so two people drafting at once get
    different ids. A card that fails validation is refused before an id is
    reserved.
  - Closing a task releases its lease and appends its row to `history.jsonl` on
    the branch (once per task, even when close is re-run).
  - `RIVETARI_LEDGER_KEY` sets a team's shared ledger key, so a task recorded on
    one machine verifies on another, until the GitHub App holds the key.

## 1.0.0

### Major Changes

- 96bd726: 1.0.0 — first stable release.

  Rivetari audits a GitHub repository against a data-driven catalog of controls,
  reports the gaps by phase and discipline, and generates the fixes as pull requests.
  This is the first version with a committed public API across all clients.

  - **Engine** — profile resolution and applicability, ~40 detectors (file, YAML, and
    GitHub API), phase gates, template/merge/`claude` generators, the Claude API +
    Claude Code CLI transports, and the GitHub API layer with caching.
  - **CLI** (`rivetari`) — `init`, `audit` (+ `--all`), `fix` (dry-run diff, apply, open
    PR), `ai <task>` (20 prompt tasks incl. changelog), `status` (phase inference),
    `metrics` (DORA + history), `waive`, `evidence`, `profile`.
  - **Action** — runs the audit in CI, comments the gap summary on PRs, fails the job
    when the phase gate is red.
  - **Catalog** — 99 controls across 14 lanes, each with references and a rationale;
    gates for all nine phases; 20 AI prompt templates.
  - **Desktop** — Electron shell (Repos → audit → scorecard, profile, gates, fix, AI,
    docs, settings) with device-flow sign-in, a strict security baseline, Playwright
    e2e, and electron-builder packaging with Electron fuses.

### Minor Changes

- 1b932c6: Add the `rivetari audit` CLI command — the first user-facing surface. It loads the
  bundled catalog, evaluates every control against a repo (bounded-concurrency
  `evaluateControls`), and prints a coloured table grouped by lane with a summary
  line, or `--json`. Supports `--lane`, `--token`, and `--no-color`, writes
  `.rivetari/state.json`, and exits non-zero when a critical control fails. Catalog
  gains `loadBundledCatalog`; engine gains `evaluateControls` and a `title` on
  `ControlResult`.
- 2f52773: Add the control schema (zod), taxonomy (14 lanes, 9 phases, 4 severities), the
  catalog loader, and the `catalog:validate` script with a generated JSON Schema
  for editor autocomplete.
- 01d4b28: Add the first 40 controls across the hygiene, development, CI/CD, security, and
  testing lanes — each with a detector, at least one cited reference, and a
  rationale. `rivetari audit` now produces a real lane-by-lane scorecard.
- 0e83bcc: Add phase gates. A gate (`packages/catalog/gates/<phase>.yml`) selects controls by
  id, lane, phase, or minimum severity; `evaluateGate` computes green (all pass /
  n/a / waived), amber (only needs-evidence or skip outstanding), or red (any fail).
  `rivetari audit --gate <phase>` or `--gate all` prints gate status and exits
  non-zero when a requested gate is red. Ships scaffold/build/harden gates and
  validates gates in `catalog:validate`.
- 16b72ba: Add the project profile and applicability. A `.rivetari/profile.yml` (schema with a
  **constrained** flag set — unknown flags are rejected) describes the project's
  type, stack, phase, risk flags, lane toggles, and severity floor. The engine
  evaluates each control's `applies` predicate (all/any/not over flag/type/stack/
  phase-at-least, plus lane toggles) and marks non-applicable controls with the new
  `n/a` status instead of running them. `rivetari audit` honours the profile and
  severity floor; `rivetari profile show|set` reads and edits the profile.
- ab8dd05: Add waivers. A waiver (`.rivetari/waivers.yml`: control, reason, owner, created,
  expires) turns a non-passing control into the new `waived` status while active;
  an expired waiver has no effect (the control stays failing). `rivetari waive
<control> --reason --expires [--owner]` records one, the audit reports `waived`
  and warns about waivers expiring within 30 days, and gates treat waived controls
  as satisfied.
- d1fb3be: Add the `template` generator (Eta) and the scaffold templates it renders. Templates
  live in `packages/catalog/templates/<name>/`; files at the root are stack-agnostic,
  while `node/` and `python/` subdirs are selected from the profile's stack. Ships
  templates for README, LICENSE, CODEOWNERS, CONTRIBUTING, SECURITY, .editorconfig,
  .env.example, renovate, lefthook (with gitleaks), commitlint, linter (eslint/ruff),
  formatter (prettier), CI workflow (node/python), and changesets — each wired to the
  control whose `fix: template` points at it.
- abba775: Add the `claude` generator framework. Prompt templates live at
  `packages/catalog/prompts/<task>.md` (YAML front-matter: `task`, `output`, `globs`,
  `control`, `checklist`; body = the system prompt), loaded via `bundledPromptsDir` /
  `loadPrompt`. `generateArtifact(ctx, task, …)` packs secret-guarded context, calls
  the model, and renders the file with the review convention — a provenance header
  (generated-by / date / model / files-consulted / empty `reviewed-by:`) plus the
  reviewer checklist, both as Markdown comment blocks ("Claude drafts, humans sign").
  The `claude` fix type is now wired into the generator registry (via `context.ai()`),
  and the first task (`explain-gaps`) ships with a fixture test driven by a recorded
  response. The action bundle copies `prompts/` and folds it into the staleness hash.
- 7e613e2: Add the AI task prompt templates (invokable via `rivetari ai <task>`): `brief`,
  `stories`, `adr`, `c4`, `threat-model`, `runbook`, `test-scaffold`,
  `license-summary` (plus `explain-gaps`). Each pins its output path, context globs,
  and a reviewer checklist, and instructs the model to mark unknowns as `TODO:` rather
  than invent facts. `sec.threat-model` is control-wired to the `threat-model` task;
  the rest are standalone until M6 adds their controls. The `claude` generator now
  degrades to no change when there's no API key, so a mixed `rivetari fix` run never
  aborts on an AI control — AI drafts are produced on demand via `rivetari ai`, which
  surfaces the missing key. A drift test loads and validates every bundled prompt.
  (`changelog` is deferred — it needs git-log input the context packer doesn't provide
  yet.)
- a97d22f: Add the Claude Code skill (`packages/catalog/skill/SKILL.md`, exposed via
  `bundledSkillDir`): it teaches an agent in a target repo to run `rivetari audit`
  instead of guessing, read the gap report, and remediate with `rivetari fix` or draft
  missing artifacts with `rivetari ai`, under "Claude drafts, humans sign". `Rivetari
init` now installs it into `.claude/skills/rivetari/SKILL.md` (never-clobber; init
  doesn't fail if it can't be read), and the action bundle copies `skill/` and folds
  it into the staleness hash.
- fe0f33c: Complete the M6 control-catalog breadth and fix phase inference.

  - Add the remaining lanes so all 14 are covered with ≥6 controls each:
    accessibility, legal, ux, and product (plus the previously-staged cloud, data,
    documentation, observability, performance lanes), and two more testing
    controls. 98 controls across 9 phase gates.
  - Add the `risk-register` and `launch-checklist` templates and nine Claude prompt
    templates (build-vs-buy, nfrs, out-of-scope, data-inventory, retention-schedule,
    dsar-process, privacy-policy, copy-guidelines, accessibility-statement) so the
    newly-wired `template`/`claude` fixes resolve instead of silently no-opping.
  - `rivetari status` no longer treats a phase gate that selects zero controls as a
    blocker: an empty gate is "undefined for this profile", not amber, so it never
    pins the inferred phase. With the early phases now populated, an empty repo
    correctly infers `discovery`.

### Patch Changes

- fe0f33c: Dead-code cleanup. Remove the unused taxonomy exports `LaneCode`, `PHASE_BY_KEY`,
  `ProjectType`, `FlagKey`, and `Effort`, and make `PhaseDef` internal (none were
  imported anywhere; `LaneKey`/`LaneDef`/`PhaseKey` stay exported because exported
  consts reference them). Extract a shared `today()` helper in the CLI, replacing
  the `new Date().toISOString().slice(0, 10)` duplicated across the waiver,
  evidence, fix, AI, and CI paths. Add an `assertNever` exhaustiveness guard to the
  `fixSummary` switch in `site.cli.ts` so a future fix type can't silently render
  "undefined" into `docs/catalog/`.
- b947439: Stop Rivetari's own `rivetari.yml` from satisfying `ci.workflow.present`, so a
  fresh repo actually gets a real CI workflow. The `file-exists` detector gains an
  optional `exclude` glob (paths that do NOT count as a match), and
  `ci.workflow.present` now excludes `.github/workflows/rivetari.yml`. Previously a
  repo scaffolded by `init` ended up with `rivetari.yml` but no test/lint/build
  workflow, because the control passed on `rivetari.yml` alone and `rivetari fix`
  never fired the `ci-workflow` template (and the `ci.concurrency` /
  `ci.workflow-permissions` merges then had no `ci.yml` target). Closes #62.
- fe0f33c: Honor the `exists` option in the `file-json-path` / `file-yaml-path` detectors.
  It was declared in the schema but never read, so `exists: false` (assert the
  path is absent) silently passed exactly when the path was present — the opposite
  of its intent. `exists: false` now passes only when the path is absent in every
  matched file; `exists: true` / omitted keeps the existing "path must exist"
  behavior. The schema description is updated to match.
- a156198: Tighten controls flagged by the M1 review to remove false passes:
  `test.runner.configured` now requires a real test runner (not npm's "no test
  specified" placeholder or a dependency named `test`); `ci.dependency-caching`
  drops the greedy `setup-node[\s\S]*cache` match; `dev.conventional-commits` no
  longer matches an incidentally-named package.json dependency; `ci.runs-on-push`
  and `sec.scorecard.score` titles/rationales no longer overclaim; and
  `dev.precommit-hooks` cites a relevant reference. Adds an engine test that loads
  the bundled catalog and compiles every `file-matches` pattern, so a malformed
  pattern fails CI instead of silently skipping at audit time.
- be6c303: Harden the engine after the M2 review: waiver/evidence expiry now uses an inclusive
  end-of-day for bare `YYYY-MM-DD` dates (they no longer expire ~a day early); a gate
  whose selector matches nothing is `amber`, not silently `green`; `loadEvidence`
  throws on a malformed file instead of silently returning none; config writes
  (`addWaiver`/`addEvidence`/`saveProfile`) are atomic (temp + rename); the CI
  comment/status-issue upserts paginate and reopen a closed status issue instead of
  duplicating; and waiver `expires`/`created` are validated as ISO dates.
- 8581cc7: Add the `command` generator: an effect that runs an installer in the repo root on
  `--write` (the dry-run shows the exact command first), reusing the tool runner so a
  missing tool or non-zero exit is recorded as a failure rather than aborting the run.
  Wires `repo.lockfile.present` to `npm install`. All five M3 generators are now
  implemented.
- 2a4bd4d: M3 dogfood fixes. Make the `command` fix runner work on Windows: `runTool` now
  resolves a bare command via `PATH`+`PATHEXT` (so a missing tool is still a clean
  `ToolNotFoundError`) and runs through a shell, so `.cmd`/`.bat` shims like `npm`
  execute instead of failing with "not installed". Add a stack-aware `toolchain`
  template (`.nvmrc` for node, `.python-version` for python) and wire it as the fix
  for `repo.toolchain-pinned`, which previously had no generator and so left the
  scaffold gate unreachable. See docs/audit-notes.md for the full dogfood log.
- 473e9bc: Add the `merge-json` and `merge-yaml` generators: they set a dot/bracket path to a
  value inside an existing file with a minimal, formatting- and comment-preserving
  edit (jsonc-parser `modify` for JSON; the `yaml` Document round-trip for YAML),
  no-op when the value already matches, and create the file if absent. Gives the
  `ci.workflow-permissions`/`ci.concurrency` controls actionable values. (CI-step
  _append_ fixes, which need more than a path-set, remain no-ops for now.)
- 81ce412: Add `pnpm catalog:site`: render every control to browsable Markdown under
  `docs/catalog/` — one page per lane (id, title, phase/severity/effort,
  detector/fix summary, rationale, references) plus an index with per-lane counts.
  CI checks the output is current (regenerate + `git diff`), so the catalog is always
  readable on GitHub without drifting from the YAML.
- 1f1030b: Catalog safety fixes from the full-repo review — `rivetari fix` can no longer
  corrupt a repo it doesn't fit:

  - **Merges never fabricate an absent file.** `merge-json`/`merge-yaml` now edit
    only an existing target and no-op when it's missing. This stops `fix` from
    writing a Node-only `package.json` into a Python/Go repo (`test.runner.configured`)
    and from fabricating an incomplete, invalid `ci.yml`/`release.yml` when the
    detector found a differently-named workflow (`ci.workflow-permissions`,
    `ci.concurrency`, `sec.sbom.ci`). Creating structured files is a `template` fix's
    job.
  - **No misleading no-op fixes.** Removed the 8 `merge-yaml` fixes that had no
    `value` (they produced no change and would have clobbered the `jobs.ci.steps`
    array); those controls are now detection-only.
  - **`catalog:validate` rejects value-less merge fixes** so they can't return.
  - **Dropped the unsafe `npm install` fix** from `repo.lockfile.present`: the
    package manager can't be inferred from the detector, and `npm install` writes the
    wrong lockfile for pnpm/yarn/cargo/poetry/go repos. The control is detection-only.

- 869e453: Security hardening from the full-repo review:

  - **Comment-injection fix**: `.rivetari/waivers.yml` and `.rivetari/evidence.yml`
    `control:` values are now validated against the control-id shape at load time, so
    an arbitrary string (Markdown/link payload) can't be smuggled into the PR/issue
    comment the Action posts.
  - **Repo-slug host anchoring**: `parseRepoSlug` now requires the host to be exactly
    `github.com` at a host boundary, rejecting look-alikes like `evilgithub.com/...`
    and `github.com.evil.com/...` that could have directed token-bearing API calls at
    an attacker-chosen repo.
  - **Least-privilege workflows**: `rivetari.yml` (repo + scaffolded) now splits by
    trigger — pull-request runs get `pull-requests: write` only, scheduled/push runs
    get `issues: write` only — and adds a `concurrency` group so overlapping runs
    can't race the sticky comment / status issue. `release.yml` gets a concurrency
    guard too.
  - **Secret-scan backstop**: CI runs a full-history gitleaks scan (the pre-commit
    hook can be bypassed with `--no-verify`).
  - **Docs**: SECURITY.md now documents pinning the committed Action by commit SHA
    (the `SOURCE_SHA256` guard is CI-only, not a consumer runtime check).
