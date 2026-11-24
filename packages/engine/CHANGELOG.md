# @arynbht/rivetari-engine

## 2.0.0

### Major Changes

- 328afac: The software factory is now **Rivetari**. Everything is renamed, with no compatibility layer: the packages are `@arynbht/rivetari`, `@arynbht/rivetari-engine`, `@arynbht/rivetari-runtime`, `@arynbht/rivetari-catalog` and `@arynbht/rivetari-registry` (the `@arynbht/factory*` names are deprecated); the CLI is `rivetari` and the Claude Code skill `/rivetari`; a repo's state lives in `.rivetari/`, its workflow is `.github/workflows/rivetari.yml`, tasks are shared on the `rivetari/tasks` branch, environment variables are `RIVETARI_*`, the needs-a-person label is `rivetari:needs-human`, and the user's config and cache are `~/.config/rivetari` and `~/.cache/rivetari`. A repo set up with the factory needs `.factory/` moved to `.rivetari/`, its workflow, hooks and skill re-installed with `rivetari init --force`, and its tasks branch copied to `rivetari/tasks`. Ledgers signed before the rename are moved, not rewritten, so their entries still read as they were sealed and still verify.

### Minor Changes

- 497f5bb: Every `claude -p` call now has a time limit, and `rivetari task run` has a wall-clock budget, so a hung call can't keep a task running all night. Each call (the build agent, the judge's review through the CLI transport, the audit swarm and the write-agent) is killed after 20 minutes, or `RIVETARI_CALL_TIMEOUT_MINUTES`; on Windows the whole process tree is killed, not just the cmd.exe shim. One `rivetari task run` gets 90 minutes, or `RIVETARI_TASK_BUDGET_MINUTES`, and when the budget runs out during a call that call is killed. Either limit stops the task as a stop-and-ask with the new `timeout` trigger: the ledger names the limit that fired and its value, `rivetari task run` exits 2, and answering it runs the build or judge beat again. A judge stopped this way never reaches a verdict, so allowing it judges again instead of shipping.
- 28e3957: Generate a Markdown architecture doc from the floor-plan model.

  Each deep-audit run now also writes `.rivetari/architecture.md` — a Mermaid systems
  diagram plus a per-system breakdown and the detected profile — so the architecture
  shows up in the desktop Docs tab and is a shareable, diff-able companion to the
  interactive Floor Plan.

- 4b5c8b2: The profile takes `autonomy: supervised | review-at-pr | unattended`, default `supervised`. At `review-at-pr` the card is confirmed and the route approved without asking, unless the route has a borderline sector or touches a sensitive path. Stops split into hard ones, which still pause the round (protected paths outside existing tests, rewritten history, a secret, a non-local `DATABASE_URL`, a new dependency whose license isn't on the OSI list or can't be read), and soft ones the build goes on past and flags (a new OSI-licensed dependency, a changed existing test, a schema change). The judge is told about flagged decisions, and the draft PR lists them under "Decisions you would have been asked" with the lockfile, schema or test diff inline. A high-risk task keeps every gate at any level. At `unattended`, `rivetari task run --all` runs every routed task in turn and parks any that would ask, which session start lists under "Needs you". Every PR body now carries the card and the route.
- 28e3957: Make the build loop reliable out of the box, and add a `rivetari build` CLI.

  - **Worktree dependency install**: a fresh build worktree has no `node_modules`, so
    the pipeline now installs dependencies (lockfile-detected package manager) before
    the verify step runs the repo's tests/lint/typecheck — no more spurious failures on
    the first build.
  - **`rivetari build "<description>"`**: the orchestration layer from the terminal.
    Plans the change and prints it; with `--yes` it builds it with a write-agent in an
    isolated worktree, self-checks, and opens a gated PR (`--no-push` stops at a local
    branch). Where Claude Code already lives.

- 9db492e: Add a `ci` block to the profile. `ci.budget_minutes_per_month` sets the GitHub Actions minutes the repo means to spend in a month: `rivetari doctor` warns once the month reaches 75% of it, and the status issue shows the month so far against it. Minutes are counted per job and rounded up, as GitHub bills. A closed task's history row records the minutes and runs its PR's CI used (`ci_minutes`, `ci_runs`).

  `ci.trust_judge` decides whether shipping a task the judge passed posts a `rivetari/judge` check run on its head commit, with the judge record's sha256 and the ledger hash, which CI can trust to skip lint, typecheck and tests. Unset, it's true on repos owned by the account Rivetari's App is registered to and false on anyone else's. The App now asks for `checks: write`.

- 71b0956: New CI/CD posture controls check that an installed repo's GitHub Actions follow the fast-CI shape. Four fixes edit the workflows in place and keep their comments; two only suggest the change. `ci.required-aggregator`: one `ci` job needs other PR jobs (a job may be left out on purpose), runs with `if: always()` and reads their results to fail when one failed (the fix adds that job needing every PR job, or turns an existing `ci` job into it). `ci.concurrency-pr-only`: superseded PR runs are cancelled (`cancel-in-progress` on `github.event_name == 'pull_request'`) and default-branch runs are grouped by commit, so they're never cancelled or replaced. `ci.job-timeouts`: every job sets `timeout-minutes` (the fix sets 30). `ci.secret-scan-on-pr` (harden): a PR workflow runs gitleaks or TruffleHog over the PR's commits (the fix adds a `secret-scan` job running TruffleHog, which needs no license on an organization's repo). `ci.docs-skip-build`: docs-only PRs skip build and test; the fix makes no edit and suggests a `changes` job with dorny/paths-filter and which jobs to gate on it, leaving the required `ci` job and the secret scan ungated since GitHub counts a skipped required check as passed, and asks for `ci.required-aggregator` first when there's no `always()` aggregator. `ci.pr-linux-only`: on a private repo, GitHub-hosted Windows and macOS runners stay off pull requests (self-hosted ones don't count); the fix makes no edit, names the jobs and suggests narrowing a mixed OS matrix on PRs or keeping a Windows- or macOS-only job off them, and moving a required `ci` job to Linux. `ci.actions-pinned-sha`'s fix now pins each tag-pinned `uses:` to the commit the tag points at, read from the GitHub API, keeping the tag as a comment. They run on the new `workflow` detector type and `workflow` fix type; a workflow file that doesn't parse fails the check, and the fix notes it and edits the rest. Rivetari's CI workflow template now sets `timeout-minutes` and cancels only PR runs.
- 28e3957: Add an agentic deep-audit swarm and an interactive Floor Plan tab.

  "Run audit" now also fans out a swarm of read-only headless Claude Code agents
  (subscription auth) that map the repository into a structured model — systems,
  subsystems, features, APIs, connectors, datastores and how they connect — persist
  it to `.rivetari/floorplan.json`, and render it as an interactive Cytoscape graph in
  a new Floor Plan tab. The deterministic scorecard is unchanged; the swarm runs
  alongside it and never blocks it. The model refreshes on audit, on demand, after a
  Fix/AI change lands, and on repo switch (staleness-aware). The swarm requires the
  Claude CLI; without it the scorecard is unaffected and the tab explains why.

- 28e3957: Close the deep-audit loop and harden the swarm.

  - **Incremental refresh**: each slice carries a content fingerprint; a refresh
    reuses unchanged slices verbatim and re-maps only what changed, skipping the
    reduce entirely when nothing moved — repeated refreshes are now cheap.
  - **Verification pass**: a bounded reviewer agent prunes implausible cross-system
    edges so the inferred connections aren't trusted single-pass.
  - **AI grounding**: the context packer injects a compact architecture summary from
    `.rivetari/floorplan.json`, so ADR / C4 / threat-model / explain-gaps are grounded
    in the repo's real systems and connections.
  - **Profile enrichment**: the Profile tab surfaces the swarm's detected
    type/stack/flags/phase as an "Apply suggestions" banner that fills the form for
    review (never auto-written — Claude drafts, humans sign).

- 6e00240: `rivetari init` fills the profile's `stack` from the repo: the stacks its manifests show, plus any `--stack` values mapped onto the stacks they imply (`nextjs` is node, `ts` is node and typescript), deduped, with names that map onto none (`postgres`) kept as given. `banned.json` is seeded from that stack, so a repo initialised without `--stack` no longer gets `stack: []` and an empty banned list. The package manager is read one way everywhere: package.json's `packageManager` field first, then a lockfile, a `pnpm-workspace.yaml` or `.yarnrc.yml`, then the one the scripts call by name. Init and the fix templates default to npm when nothing names one; verify and proof keep pnpm for that case for now.
- a8c3169: `rivetari task run` runs the test suite once a round. For a `test-run` proof, the prove beat no longer runs the suite itself: it records that the judge's tier 1 run on the change is the proof, and the judge publishes that run's full log as the evidence and writes the proof record the PR body reads. A failing suite fails the proof and sends the change back to build, as before. The build prompt tells the agent to run only the tests related to the files it touched, never the whole suite. The engine's context takes an `onCommand` listener, which hears each command a detector runs, with its output. `proveTask` and `runTask` keep running their own suite unless `deferTestRun` is set; the CLI sets it.
- 28e3957: Add the orchestration layer — a feature/fix request becomes a gated PR.

  A new **Build** tab turns a natural-language request into working code: a read-only,
  floor-plan-grounded planner drafts a plan you approve, then a write-capable Claude
  agent implements it in an **isolated git worktree** (your working tree is never
  touched), self-checks against the repo's tests/lint/typecheck **and** Rivetari
  phase gate with a bounded fix-loop, and — only when the checks pass — commits,
  pushes, and opens a reviewable PR. Two human checkpoints (approve the plan, review
  the PR) keep it honest. The engine orchestrator (`orchestrate/`) is fully
  injectable and unit-tested with no `claude`/git/network.

- eef91ca: A running task now shows that it's alive. While `rivetari task run` runs a beat it writes a small progress file beside the task's directory, `.rivetari/tasks/<id>.progress.json`: the beat, when it started, when it last did something, and for the build the agent's turns, tokens and last tool so far. It's written atomically, at most every 2 seconds, and removed when the beat ends; it's never part of the ledger, the tasks branch or anything the judge hashes, and a file left by a process that died is ignored. The build agent reads `claude -p` as `--output-format stream-json --verbose` so it can count turns while the call runs, and still returns the same reply, cost, turns and turn limit from the final result. `spawnWithLimit` takes an `onLine` callback that hears stdout line by line. `watchTasks` puts each running task's progress on its view (`progress`), polls it on its own so it stays live during a slow read, counts a ledger entry as activity, and with `localFirst` lists this machine's copies at once before merging the tasks branch's view in; the branch read now loads up to 8 tasks at a time. `loadTask` takes `readOnly`.

  In the desktop Tasks tab each running task shows "Running: build · 12 min · turn 18 · last activity 20 s ago", updated every second, and "No activity for N min" in amber after five quiet minutes; "Next: …" shows only when nothing is running. The list appears from the local copies first (about 50 ms for this repo's 31 tasks, down from about 11 s) and no longer carries every task's ledger: the open task's ledger is fetched on its own (`tasks:ledger`) and again when it grows.

- be49a10: Rivetari's GitHub App (ADR-0007, spec v2.1 §14).

  - `rivetari app register [--org <org>]` creates the App from its manifest in one
    click: a local page posts the manifest to GitHub, GitHub sends you back with a
    one-time code, and the App's ID, private key and secrets are kept in the
    Rivetari's config directory (secrets readable by you only). It asks for exactly
    ADR-0007's permissions, with no webhook.
  - `rivetari app status` shows whether Rivetari acts as the App in a repo;
    `rivetari app token` prints an installation token for scripts and CI.
  - A new `githubToken(repo)` picks how Rivetari reaches GitHub: an explicit
    token, then `GITHUB_TOKEN`/`GH_TOKEN`, then the App when it's installed on the
    repo, then `gh auth`. `rivetari review --pr`, evidence uploads, `task ship` and
    `task close` use it, so with the App their reviews, evidence and PRs come from
    Rivetari. This also fixes `task ship` and `task close` outside tests: they
    built their GitHub client with no token, so they always failed.
  - `rivetari doctor` says whether Rivetari reaches GitHub as its App or as you.

- 0a66e93: Apply the judge decisions: the coverage floor ratchets (profile `quality.coverage`,
  else a baseline recorded in `.rivetari/quality.json` that only moves up) and fails in
  the judge when configured coverage writes no summary; `reviewed` finds drafts by their
  header and requires every draft for the task to be reviewed; the judge sweeps stale
  clones, disables the target repo's hooks, runs tests before reading coverage, and
  won't pass a non-Node repo on checks that are red at base too.
- 0a66e93: Registry review rules: `scan_allow` binds to one exact line (sha256) with a named
  reviewer and is ignored once the lock pins another commit; licenses outside the
  OSI allow-list need a signed `license_review`; legal-sector skills must name the
  controls they serve; the `.rivetari/` scan rule matches repo paths only;
  `pnpm registry:scan` lists open findings. The judge protects the skill registry
  and agent harness settings, and runs installs and checks with an environment
  allowlist (`allowlistedEnv`; `--env` to pass more). Manifests: drop
  app-store-compliance and privacy-threshold-analysis; add a11y-core (required by
  accessibility-lead), three control-mapped privacy skills, and insecure-defaults
  (task scope, last skill commit).
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
- 8b61010: Rivetari v2 step 6a: isolation and the sector agent. `rivetari task isolate <id>` gives an
  approved task its own worktree under `.worktrees/`, branch `<type>/<id>`, port and
  database name, with git hooks off inside it. `rivetari task build <id>` plans first
  (read-only, recorded in the ledger before any edit), then runs one writer in the
  worktree with a prompt assembled in a fixed order (AGENTS.md from the base, the card,
  the assembly's skills verified against the lock, a size-capped repo slice, the
  operating rules) on an allowlisted environment. The runtime commits, then checks the
  diff: a new dependency, a schema change, a sensitive or protected path, or a plan over
  budget pauses the task until `rivetari task answer <id> --allow|--deny`.
- cfba43b: Rivetari v2 step 6b: the proof runner. `rivetari task prove <id>` produces the
  assembly's proof with tools. For UI tasks it serves the base and the change side by
  side (profile `proof.start` / `proof.url`), shoots each card `pages:` entry at three
  breakpoints with Playwright, runs axe on the change (serious or critical violations
  fail the proof), and uploads the images to an orphan `evidence` branch through the
  Contents API. Every other proof type runs the test script and names the tests the
  change added. Results go to the ledger and `proof/proof.json`; a failed proof sends
  the task back to build, and the next round is told why.
- 5cb919e: Rivetari v2 step 7a: the judge, ship and close beats. `rivetari task judge <id>`
  runs tier 1 and then the scoped review on the task's branch (never the worktree),
  only on the commit the last build round made. Blocking findings or failed checks go
  back to the agent with the repro, at most twice. A protected change, or blocking
  findings in round 3, stop and ask a person. `rivetari task ship <id>` pushes the
  judged branch and opens a draft PR whose body comes from the card, ledger, proof and
  the judge's sealed record. `rivetari task close <id>` waits for a person to merge or
  close the PR (or `--abandon`), records the outcome with duration, tokens and cost,
  removes the worktree, appends a task row to `.rivetari/history.jsonl` and seals the
  ledger.
- 0a66e93: Make remediation safe on repos Rivetari did not scaffold (Rivetari v2 §3.1):
  stack detection from manifests (node/python/go/rust, `unknown` skips stack files),
  CI merges find the real job instead of inventing `jobs.ci`, merges into one file
  accumulate in a single run, `merge-json` never overwrites a human's value, SHA-pinned
  first-run-safe CI templates (plus go and rust), `project:` profile fields instead of
  `@OWNER`/`security@example.com` placeholders, `any-of` detectors and `{ file }`
  applicability, phase floor in `status`, severity floor no longer lowers gates,
  `chore(rivetari):` commits, and a 60 s timeout on `command` detectors.

### Patch Changes

- 5b3e8cf: A repo can ban patterns, and the judge fails a change that adds one. The list lives in `.rivetari/banned.json`; `rivetari init` seeds it with defaults for the stack (eval, new Function, debugger and raw innerHTML for Node; eval, exec, pickle loads, shell=True and breakpoint() for Python), and `rivetari banned seed|add|allow|list` maintains it. Tier 1 checks the change's added lines against the base's list, so a change can't loosen the rules it's judged by, and the tier 2 reviewer sees the list as part of the contract. Each entry counts once in the trust ladder's rule count; an entry a lint rule already enforces is marked `covered_by` and isn't counted twice. The stop detector no longer treats a test file that names a secret as data as a secret; real key shapes in test files still stop the round. Each build round's tokens, turns and whether it was a retry are recorded in the task's history row, and a build round with flagged decisions now counts towards the task's token totals again.
- e715d32: The Claude CLI transport now counts cache creation and cache read tokens, and the judge's token total and cost estimate include them.
- 4b5c8b2: Recurring judge findings can now become rules. Every tier 2 finding carries a stable `pattern` id, and a closed task's history row records its findings by pattern. `rivetari metrics` (and `rivetari metrics --findings`, which needs no GitHub) reports the judge's tier 1 rule count, findings per PR, how often each pattern recurs, and any pattern seen in two or more PRs as a candidate rule. Tier 1 gains three diff rules that fail closed: no new code comments (opt in with `quality.no-new-comments` in the profile), no Markdown added or edited unless the card names it, and no new suppressions or skipped and focused tests. The catalog gains `quality.boundaries.clean`, which runs a repo's `boundaries` script when it has a dependency-cruiser config.
- 53fa997: A private repo on GitHub's free plan no longer fails or skips the branch-protection controls it can't satisfy. GitHub answers the protection and rules endpoints there with a 403 asking to upgrade to Pro or make the repo public, so `repo.branch-protection`, `quality.required-checks.named` and `dev.code-review-required` now report n/a with that reason. Detectors gain an `n/a` status, and a control whose detectors are all n/a is n/a. Public repos, paid plans and every other 403 or error are handled as before.
- 31821c8: verify and the proof runner fall back to npm, like init and the templates, when nothing in a repo names a package manager.
- ef50f7b: The packages publish to GitHub Packages (`https://npm.pkg.github.com`, restricted) and name this repo as their source, so a release's publish step reaches them and links each package to the repo.
- 8b85843: A task run no longer spends rounds that change nothing. A build round where the agent leaves the worktree as it found it stops the run and asks a person, with the agent's reply as the question, instead of proving the same commit again. The agent can also end a round with a last line `RIVETARI_STOP: <question>`; the runtime asks it without committing or proving, and the next round gets the answer. The judge's reviewer and its false-positive gate now see every stop-and-ask a person allowed, with who and when, and are told not to block on it. A failing test run is retried once and run on the base: a failure that passes on the retry is reported as flaky, and one that also fails on the base as pre-existing, and neither fails the proof. Build rounds after the first resume the agent's previous session. A failed push while reserving a task id gives the id back, `rivetari task status` skips a folder with no card instead of failing, and a beat whose final push fails says the beat is done and exits 1. The judge's cost uses the cost the Claude CLI reports, and the price table now covers Claude Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1, so the judge no longer reads $0.
- eb93ad1: The secret filter no longer mistakes code that refers to a secret for the secret itself. A value that names another secret (`token: auth.token`, `apiKey: this.config.apiKey`) or a lone identifier in an object literal (`token: explicit,`) is code, so the judge's AI review and the AI context now see those files instead of skipping them. Quoted values and dotted values that don't end in a secret's name are flagged as before.
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

- Updated dependencies [4b5c8b2]
- Updated dependencies [9db492e]
- Updated dependencies [71b0956]
- Updated dependencies [4b5c8b2]
- Updated dependencies [ad769fc]
- Updated dependencies [24781e4]
- Updated dependencies [87d646b]
- Updated dependencies [ef50f7b]
- Updated dependencies [328afac]
- Updated dependencies [da6ad10]
- Updated dependencies [ce71405]
- Updated dependencies [9d2955f]
- Updated dependencies [0a66e93]
- Updated dependencies [0a66e93]
- Updated dependencies [ad25e71]
- Updated dependencies [cfba43b]
- Updated dependencies [4d5e653]
- Updated dependencies [0a66e93]
  - @arynbht/rivetari-catalog@2.0.0

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

- 95417a3: AI now uses the developer's Claude subscription via the Claude Code CLI by
  default, not a metered API key. A new `claudeCliTransport` runs `claude` in
  headless mode (`claude -p --output-format json`, subscription auth); the AI
  client picks it automatically when the `claude` binary is on PATH and falls back
  to the `ANTHROPIC_API_KEY` SDK transport otherwise (`preferApiKey` forces the
  API). The `claude` fix generator only auto-drafts when AI is explicitly
  configured (`ctx.aiEnabled`: an injected transport or an API key), so a plain
  `rivetari fix`/dry-run never spawns the interactive CLI; deliberate drafting via
  `rivetari ai` uses the subscription.
- 1b932c6: Add the `rivetari audit` CLI command — the first user-facing surface. It loads the
  bundled catalog, evaluates every control against a repo (bounded-concurrency
  `evaluateControls`), and prints a coloured table grouped by lane with a summary
  line, or `--json`. Supports `--lane`, `--token`, and `--no-color`, writes
  `.rivetari/state.json`, and exits non-zero when a critical control fails. Catalog
  gains `loadBundledCatalog`; engine gains `evaluateControls` and a `title` on
  `ControlResult`.
- 636822f: Add the `command` and `scorecard` detectors. `command` runs a tool in the repo
  root and checks its exit code or a `jsonPath` in its JSON stdout; a missing tool
  is a clean skip. `scorecard` runs OpenSSF Scorecard and asserts a named check
  meets a minimum score. Completes all seven M1 detector types.
- bc577e0: Add the audit context (`buildContext` with fs + glob helpers), the detector
  framework (registry + dispatch with skip-on-unimplemented/error), the
  `file-exists` and `file-matches` detectors, and `evaluateControl` which
  aggregates a control's detectors into a single status.
- a60f31f: Add the `github-api` detector: a cached Octokit client in the audit context
  (repo slug auto-detected via git remote or injected), token resolution
  (`--token` / `GITHUB_TOKEN` / `GH_TOKEN` / `gh auth token`), and named checks
  (branch protection, required PR/status checks, secret scanning + push protection,
  Dependabot security updates, vulnerability alerts, default branch, visibility,
  Actions permissions). Missing-permission responses become a clear `skip` naming
  the scope needed. Tested against MSW-recorded responses, so CI needs no token.
- 56991cf: Add the evidence stub and `manual` control handling. `loadEvidence` reads
  `.rivetari/evidence.yml` (cached on the context) and `findValidEvidence` honours
  `valid-for` expiry. `evaluateControl` now satisfies a `manual` detector from a
  valid, unexpired evidence entry and otherwise reports the fourth control status,
  `needs-evidence`.
- 3257bac: Add the `file-json-path` and `file-yaml-path` detectors: assert that a dot/bracket
  path exists or equals a value inside JSON (JSONC-tolerant) or YAML files, across a
  glob of files. Includes shared path navigation and structural deep-equality.
- ba927e1: Add the composite GitHub Action. A hidden `rivetari ci` command audits the
  checked-out repo, writes the report to the job summary, and either posts a sticky
  PR comment (failing the job when the gate is red) or maintains a pinned "Rivetari
  status" issue on scheduled runs (never failing the job), per ADR-0006. The CLI is
  esbuild-bundled with the catalog into `packages/action/dist` (committed), and
  `action.yml` runs it; CI rebuilds the bundle to catch drift.
- 7c9e9eb: Add the evidence workflow. `rivetari evidence add <control> --url|--file [--note
--reviewer --valid-for]` records an entry in `.rivetari/evidence.yml` (hashing a
  `--file` with sha256), and the audit warns about evidence expiring within 30 days.
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
- 8581cc7: Add the `command` generator: an effect that runs an installer in the repo root on
  `--write` (the dry-run shows the exact command first), reusing the tool runner so a
  missing tool or non-zero exit is recorded as a failure rather than aborting the run.
  Wires `repo.lockfile.present` to `npm install`. All five M3 generators are now
  implemented.
- 96e4fa2: Add `rivetari fix --pr`: apply the plan on a dedicated `rivetari/<date>-<gate>`
  branch, commit one change per control, push, and open a pull request titled
  `rivetari: <n> fixes for <gate>` — reusing (and refreshing) the existing open
  Rivetari PR for that branch instead of opening duplicates. Requires a clean
  working tree, skips settings effects that can't live in a PR, folds the
  managed-file registry into the branch, and always returns the tree to the base
  branch. New `openFixPr` orchestrator (git via simple-git) and `openOrReusePr`
  (Octokit, MSW-tested) in the engine.
- d8cf3e7: Add the generator framework and merge policy (ADR-0004) that `rivetari fix` builds
  on. `.rivetari/state.json` gains a managed-file hash registry with
  `managedFileUnchanged`; `applyChanges` applies a plan of changes dry-run-by-default,
  never overwriting a human-edited file (a `create` file is written only when absent
  or rivetari-managed-and-unchanged; a `merge` file writes its already-merged
  contents; effects run only in write mode) and records hashes on write. Adds the
  generator type + registry + `planControls` dispatch (generators themselves land in
  M3.2+). The audit now preserves the managed registry across runs.
- 3b7ca5e: Add the `github-setting` generator: an effect generator that applies repo settings
  via the API — a ruleset protecting the default branch (idempotent by name),
  secret-scanning push protection, Dependabot security updates, and vulnerability
  alerts. The apply engine now records a failing effect (e.g. missing admin scope)
  instead of aborting the whole run.
- 473e9bc: Add the `merge-json` and `merge-yaml` generators: they set a dot/bracket path to a
  value inside an existing file with a minimal, formatting- and comment-preserving
  edit (jsonc-parser `modify` for JSON; the `yaml` Document round-trip for YAML),
  no-op when the value already matches, and create the file if absent. Gives the
  `ci.workflow-permissions`/`ci.concurrency` controls actionable values. (CI-step
  _append_ fixes, which need more than a path-set, remain no-ops for now.)
- d1fb3be: Add the `template` generator (Eta) and the scaffold templates it renders. Templates
  live in `packages/catalog/templates/<name>/`; files at the root are stack-agnostic,
  while `node/` and `python/` subdirs are selected from the profile's stack. Ships
  templates for README, LICENSE, CODEOWNERS, CONTRIBUTING, SECURITY, .editorconfig,
  .env.example, renovate, lefthook (with gitleaks), commitlint, linter (eslint/ruff),
  formatter (prettier), CI workflow (node/python), and changesets — each wired to the
  control whose `fix: template` points at it.
- c59168f: Add the Anthropic SDK wrapper (`ai/client.ts`): `createAiClient().complete()` over
  the Messages API with `resolveAnthropicKey`, model pinning (configurable default),
  and client-layer retry-with-backoff + timeout so transient 429/5xx/timeouts are
  handled deterministically. The real SDK is loaded lazily (only on an actual call)
  and the transport is injectable, so non-AI paths stay light and tests never hit the
  network. The key is read from `ANTHROPIC_API_KEY` and never stored or logged.
- a48d87e: Add AI usage accounting. Every `rivetari ai` call appends a JSON line (date, task,
  model, tokens, estimated USD cost) to `.rivetari/ai-usage.log` (gitignored), and
  `rivetari ai usage` summarizes it — totals plus per-task and per-day breakdowns. Cost
  is estimated from a small per-model price table; an unpriced model counts as $0.
  Logging never fails the command.
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
- 876bc45: Add the AI context packer (`ai/context.ts`): assembles the profile, the gap report,
  the control's rationale + references, and a size-capped selection of task-glob'd repo
  files into one context block, and returns the exact list of files included (for the
  PR description). Secrets are kept out by two layers (`ai/redact.ts`): a path denylist
  (`.env*`, `*.pem`/`*.key`, `id_rsa`, `.npmrc`, `secrets.*`, …) and a content scan
  (private keys, AWS/GitHub/Slack/Anthropic/Google key shapes, and generic
  `key = "value"` assignments). A file that matches either guard is skipped, never
  sent.
- c23be6b: Add `rivetari metrics`: the four DORA keys computed from the GitHub API with no extra
  services — deployment frequency (releases/week), lead time (PR open→merge median),
  change failure rate (merged PRs that are reverts/hotfixes), and time to restore
  (`incident`-labeled issue open→close median) — each with its proxy documented and
  `null` when there isn't enough data. `--window <days>` and `--json` supported. The
  Action also appends a per-lane pass snapshot to `.rivetari/history.jsonl` on each run
  (hygiene trend); `loadHistory`/`laneCounts` read it back.
- 1f823bd: Add `rivetari status`: infers the project phase (the lowest phase whose gate is not
  green) and lists the blocking controls (fail / needs-evidence) in severity then
  effort order, each tagged with its effort. Shows every defined gate's state and the
  profile's declared phase (a floor, never a ceiling). `--json` for machine output.
  `ControlResult` now carries `effort` so consumers can prioritize by it.

### Patch Changes

- 5431e4b: Fix three engine date/metric correctness bugs: DORA `deploymentFrequencyPerWeek`
  now returns `null` (not `Infinity`/`NaN`) when `windowDays <= 0`, matching the
  other metrics; zone-less datetimes (`2026-11-01T00:00:00`) are parsed as UTC
  instead of the host local timezone so a waiver or evidence date means the same
  instant on a laptop and in CI; and the evidence `valid-for` window is anchored to
  the start of the issue date (new `startOfDayMs`) rather than the end of that day,
  removing the ~1 extra day and making the evidence window symmetric with waiver
  expiry.
- fe0f33c: Broaden the AI-context secret guard. The content scan now also catches Stripe
  keys (`sk_live_`/`rk_live_`), JWTs, service-account/cloud-credential JSON,
  Azure `AccountKey=` connection strings, database URLs with an inline password,
  and unquoted `key=value` secret assignments. The path denylist gains certificate
  and credential-store extensions (`.crt/.cer/.der/.p8/.p7b/.kdbx/.ovpn`),
  `kubeconfig`, and the `.aws/.ssh/.kube/.gnupg/.docker` directories. Binary files
  (detected by a NUL byte) are skipped entirely, since a raw-binary secret matches
  no text regex. The module now documents that it is best-effort — run gitleaks
  over the candidate set when stronger assurance is required.
- fe0f33c: Abort the in-flight AI request when its timeout fires. `withTimeout` now creates
  an `AbortController` and passes its signal to the Anthropic SDK call, aborting it
  in the `finally` branch. Previously a timed-out request kept running server-side
  while a retry was billed alongside it, and those extra tokens never reached
  `.rivetari/ai-usage.log`.
- b947439: Stop Rivetari's own `rivetari.yml` from satisfying `ci.workflow.present`, so a
  fresh repo actually gets a real CI workflow. The `file-exists` detector gains an
  optional `exclude` glob (paths that do NOT count as a match), and
  `ci.workflow.present` now excludes `.github/workflows/rivetari.yml`. Previously a
  repo scaffolded by `init` ended up with `rivetari.yml` but no test/lint/build
  workflow, because the control passed on `rivetari.yml` alone and `rivetari fix`
  never fired the `ci-workflow` template (and the `ci.concurrency` /
  `ci.workflow-permissions` merges then had no `ci.yml` target). Closes #62.
- fe0f33c: Make the `claude` fix generator idempotent. AI output is non-deterministic and
  carries a `date:` header, so re-running `rivetari fix` regenerated the artifact,
  produced a fresh diff every run, and burned an API call (and, under `--pr`, a
  new commit). The generator now produces the draft once: if the task's output
  file already exists it makes no change. Redraft deliberately with
  `rivetari ai <task> --pr`.
- fe0f33c: Four engine robustness fixes. Generator failures are no longer swallowed:
  `planControl`/`planControls` return the changes plus a `GeneratorError[]`, and
  `rivetari fix` prints each failure instead of silently reporting "nothing to fix".
  `rivetari status` now applies the profile's `severity-floor` (like audit/ci/ai/fix)
  so it neither infers a phase from nor lists blockers the user chose to ignore,
  and derives the all-green phase from the phase list rather than a hardcoded
  `"operate"`. The `github-setting` protection ruleset now requires one approving
  review (was zero), so the `required-pull-request` control can't report "reviews
  required" while self-merge is allowed. `merge-json` preserves a file's existing
  line ending instead of forcing `\n`, avoiding a mixed-EOL whole-file diff on
  Windows.
- fe0f33c: Harden the Windows command runner against a CWD-search hijack. `resolveOnWindows`
  no longer includes `process.cwd()` in its search path — tools run with
  `cwd = repoPath`, so a malicious repo could drop a `scorecard.cmd`/`npm.cmd` in
  its root and have it executed ahead of the real tool. Bare command names now
  resolve from `PATH`/`PATHEXT` only, matching how `cmd.exe`/`where` behave.
- fe0f33c: Honor the `exists` option in the `file-json-path` / `file-yaml-path` detectors.
  It was declared in the schema but never read, so `exists: false` (assert the
  path is absent) silently passed exactly when the path was present — the opposite
  of its intent. `exists: false` now passes only when the path is absent in every
  matched file; `exists: true` / omitted keeps the existing "path must exist"
  behavior. The schema description is updated to match.
- fe0f33c: Make `rivetari fix --pr` always return the working tree to the base branch. A
  failed `git push` or PR-creation call used to leave the user checked out on the
  `rivetari/…` branch; the push/open-PR step now runs in a `try`/`finally` that
  restores the base branch on any failure. Also refuse to run on a detached HEAD
  (which reported `base: "HEAD"` and produced a 422 that stranded the branch).
- fe0f33c: Honor the merge policy's `.rivetari-suggested` escape hatch. A `merge` fix that
  targets a file Rivetari previously wrote but a human has since edited no
  longer re-serializes over those edits; it writes the merged result alongside as
  `<path>.rivetari-suggested` and reports a `suggest` action so the human can
  reconcile it by hand. First-time merges into a human-authored file (minimal
  structural insertion) are unchanged.
- fe0f33c: Fix the Claude Opus 4.8 price table entry: it was `$15/$75` per 1M tokens (the
  Opus 4.1 rate) but Opus 4.8 is `$5/$25`. Every Opus cost estimate in
  `.rivetari/ai-usage.log`, the `rivetari ai` cost line, and `rivetari ai usage` was
  inflated 3×.
- fe0f33c: Contain generator writes and AI reads to the target repo (ADR-0004). A new
  `paths.ts` adds `resolveInsideRepo` (rejects `..`/absolute escapes),
  `assertNoSymlinkEscape` (refuses a write whose target is a symlink or whose
  intermediate directory symlinks outside the repo), and `containedReadPath`
  (follows symlinks only while they stay inside the repo). `applyChanges` now runs
  every file change through these guards before any read/write — an escaping path
  is reported as a visible skip instead of silently writing outside the repo. On
  the read side, `ctx.glob` no longer follows symbolic links and `ctx.readFile`
  treats a symlink that escapes the repo as absent, so a repo cannot alias a file
  to `~/.aws/credentials` and leak it into AI context.
- 25b2f62: Fix the `branch-protection`, `required-pull-request`, and `required-status-checks`
  github-api checks to recognise repository rulesets, not only classic branch
  protection. The rules endpoint needs just read access, so these checks no longer
  false-fail (or need admin) on repos protected by a ruleset.
- a156198: Tighten controls flagged by the M1 review to remove false passes:
  `test.runner.configured` now requires a real test runner (not npm's "no test
  specified" placeholder or a dependency named `test`); `ci.dependency-caching`
  drops the greedy `setup-node[\s\S]*cache` match; `dev.conventional-commits` no
  longer matches an incidentally-named package.json dependency; `ci.runs-on-push`
  and `sec.scorecard.score` titles/rationales no longer overclaim; and
  `dev.precommit-hooks` cites a relevant reference. Adds an engine test that loads
  the bundled catalog and compiles every `file-matches` pattern, so a malformed
  pattern fails CI instead of silently skipping at audit time.
- 681f6ef: Harden the engine after the M1 review: `getByPath` now matches only own data
  properties and in-range array indices (no prototype keys like `toString`, no
  array `length`/methods), preventing false-pass structured-path checks;
  `evaluateControl` no longer crashes the whole run on an unreadable evidence file;
  context memos evict rejected promises instead of caching and amplifying them;
  `branch-protection` requires a merge-gating ruleset rule (not a lone
  `non_fast_forward`); unparseable `valid-for` fails closed; and `parseRepoSlug`
  rejects non-bare URLs with extra path segments.
- be6c303: Harden the engine after the M2 review: waiver/evidence expiry now uses an inclusive
  end-of-day for bare `YYYY-MM-DD` dates (they no longer expire ~a day early); a gate
  whose selector matches nothing is `amber`, not silently `green`; `loadEvidence`
  throws on a malformed file instead of silently returning none; config writes
  (`addWaiver`/`addEvidence`/`saveProfile`) are atomic (temp + rename); the CI
  comment/status-issue upserts paginate and reopen a closed status issue instead of
  duplicating; and waiver `expires`/`created` are validated as ISO dates.
- 2a4bd4d: M3 dogfood fixes. Make the `command` fix runner work on Windows: `runTool` now
  resolves a bare command via `PATH`+`PATHEXT` (so a missing tool is still a clean
  `ToolNotFoundError`) and runs through a shell, so `.cmd`/`.bat` shims like `npm`
  execute instead of failing with "not installed". Add a stack-aware `toolchain`
  template (`.nvmrc` for node, `.python-version` for python) and wire it as the fix
  for `repo.toolchain-pinned`, which previously had no generator and so left the
  scaffold gate unreachable. See docs/audit-notes.md for the full dogfood log.
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
- e84788b: M5.4 — Profile screen in the desktop shell, and a new engine `updateProfile` that
  writes `.rivetari/profile.yml` with a **minimal, comment-preserving** edit (only
  changed leaves; an absent flag/lane keeps its default, so toggling one flag yields
  a one-line diff). The desktop form edits type, phase, severity-floor, stack, risk
  flags, and lane toggles — driven by catalog enum lists sent over IPC, so the
  renderer never imports the catalog — and saves through `updateProfile`.
- edb2260: Engine correctness fixes from the full-repo review:

  - **Windows exec**: `runTool` no longer uses `shell: true` (which split arguments
    containing spaces — e.g. the repo path `…\Rivetari - Dev`, breaking the
    `scorecard` detector). It now resolves the binary via PATH+PATHEXT and runs a
    `.cmd`/`.bat` shim through `cmd.exe` directly, so Node's native argument quoting
    applies and spaces are preserved. A bare, extensionless name is no longer
    mistaken for an executable.
  - **`fix --pr`**: a reused branch with no new changes no longer pushes or rewrites
    the PR to "0 fixes" — it reports an empty result and leaves the existing branch
    untouched.
  - **Determinism**: the template generator's copyright year comes from an injected
    `context.now` instead of `new Date()`, so output is reproducible and testable.
  - **Cross-platform idempotency**: the managed-hash registry and the "already up to
    date" check normalize line endings and a leading BOM, so a rivetari-written file
    checked out with CRLF (`core.autocrlf=true`, the Windows default) is no longer
    mistaken for a human edit.

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

- 563aea4: Test coverage and cross-platform CI from the full-repo review:

  - **`writeFileAtomic` hardening** (bug found by the new concurrency test + Windows
    CI leg): the temp-file name now uses random bytes instead of pid+time (two
    concurrent writers in one process could generate the same temp name and collide),
    and the final rename retries on a transient Windows EPERM/EACCES; the temp file is
    cleaned up if the rename ultimately fails. Also removes the predictable-temp-name
    weakness flagged in the review.

  - **`runCi()` is now tested end-to-end** (the GitHub Action entrypoint): fail-closed
    on an unknown gate, posts a sticky PR comment and fails on a red gate, maintains
    the status issue on a scheduled run without failing, writes the job summary, and
    warns without failing when the repository is unset — all with the GitHub API
    intercepted (MSW).
  - **`fix --pr` CLI path tested**: opens/reports a PR (via an injected opener seam),
    maps a `FixPrError` (dirty tree, no token/slug) to exit 1.
  - **New unit tests** for `writeFileAtomic` (create/overwrite/nested/concurrent) and
    `resolveOnWindows` (PATHEXT resolution, extensionless-name handling).
  - **Windows CI leg**: the `ci` job now runs on `ubuntu-latest` and `windows-latest`
    (bash shell on both), so the Windows exec/path code actually runs in CI.
  - Strengthened a weak merge assertion (exact content) and added a PR-API error-path
    test.

- Updated dependencies [fe0f33c]
- Updated dependencies [b947439]
- Updated dependencies [fe0f33c]
- Updated dependencies [1b932c6]
- Updated dependencies [2f52773]
- Updated dependencies [01d4b28]
- Updated dependencies [a156198]
- Updated dependencies [0e83bcc]
- Updated dependencies [16b72ba]
- Updated dependencies [ab8dd05]
- Updated dependencies [be6c303]
- Updated dependencies [8581cc7]
- Updated dependencies [2a4bd4d]
- Updated dependencies [473e9bc]
- Updated dependencies [d1fb3be]
- Updated dependencies [abba775]
- Updated dependencies [7e613e2]
- Updated dependencies [a97d22f]
- Updated dependencies [81ce412]
- Updated dependencies [fe0f33c]
- Updated dependencies [1f1030b]
- Updated dependencies [869e453]
- Updated dependencies [96bd726]
  - @arynbht/rivetari-catalog@1.0.0
