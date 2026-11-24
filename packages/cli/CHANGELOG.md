# @arynbht/rivetari

## 2.0.0

### Major Changes

- 328afac: The software factory is now **Rivetari**. Everything is renamed, with no compatibility layer: the packages are `@arynbht/rivetari`, `@arynbht/rivetari-engine`, `@arynbht/rivetari-runtime`, `@arynbht/rivetari-catalog` and `@arynbht/rivetari-registry` (the `@arynbht/factory*` names are deprecated); the CLI is `rivetari` and the Claude Code skill `/rivetari`; a repo's state lives in `.rivetari/`, its workflow is `.github/workflows/rivetari.yml`, tasks are shared on the `rivetari/tasks` branch, environment variables are `RIVETARI_*`, the needs-a-person label is `rivetari:needs-human`, and the user's config and cache are `~/.config/rivetari` and `~/.cache/rivetari`. A repo set up with the factory needs `.factory/` moved to `.rivetari/`, its workflow, hooks and skill re-installed with `rivetari init --force`, and its tasks branch copied to `rivetari/tasks`. Ledgers signed before the rename are moved, not rewritten, so their entries still read as they were sealed and still verify.

### Minor Changes

- 4b5c8b2: The profile takes `autonomy: supervised | review-at-pr | unattended`, default `supervised`. At `review-at-pr` the card is confirmed and the route approved without asking, unless the route has a borderline sector or touches a sensitive path. Stops split into hard ones, which still pause the round (protected paths outside existing tests, rewritten history, a secret, a non-local `DATABASE_URL`, a new dependency whose license isn't on the OSI list or can't be read), and soft ones the build goes on past and flags (a new OSI-licensed dependency, a changed existing test, a schema change). The judge is told about flagged decisions, and the draft PR lists them under "Decisions you would have been asked" with the lockfile, schema or test diff inline. A high-risk task keeps every gate at any level. At `unattended`, `rivetari task run --all` runs every routed task in turn and parks any that would ask, which session start lists under "Needs you". Every PR body now carries the card and the route.
- 5b3e8cf: A repo can ban patterns, and the judge fails a change that adds one. The list lives in `.rivetari/banned.json`; `rivetari init` seeds it with defaults for the stack (eval, new Function, debugger and raw innerHTML for Node; eval, exec, pickle loads, shell=True and breakpoint() for Python), and `rivetari banned seed|add|allow|list` maintains it. Tier 1 checks the change's added lines against the base's list, so a change can't loosen the rules it's judged by, and the tier 2 reviewer sees the list as part of the contract. Each entry counts once in the trust ladder's rule count; an entry a lint rule already enforces is marked `covered_by` and isn't counted twice. The stop detector no longer treats a test file that names a secret as data as a secret; real key shapes in test files still stop the round. Each build round's tokens, turns and whether it was a retry are recorded in the task's history row, and a build round with flagged decisions now counts towards the task's token totals again.
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

- 4b5c8b2: Recurring judge findings can now become rules. Every tier 2 finding carries a stable `pattern` id, and a closed task's history row records its findings by pattern. `rivetari metrics` (and `rivetari metrics --findings`, which needs no GitHub) reports the judge's tier 1 rule count, findings per PR, how often each pattern recurs, and any pattern seen in two or more PRs as a candidate rule. Tier 1 gains three diff rules that fail closed: no new code comments (opt in with `quality.no-new-comments` in the profile), no Markdown added or edited unless the card names it, and no new suppressions or skipped and focused tests. The catalog gains `quality.boundaries.clean`, which runs a repo's `boundaries` script when it has a dependency-cruiser config.
- ad769fc: The floorplan skill (haydenschmitty/floorplan, pinned at v0.11.0) ships as a task-scope registry manifest, and a profile's new `floorplan` flag keeps its map of the codebase in `floorplan/`: `rivetari init` turns it on for new repos and draws one, and closing a merged task updates it. Rivetari runs only the skill's offline scripts, unattended, and the model's answers go through the build agent's transport with their usage logged; a failure is reported and never stops init or close. Profiles without the flag are off. `rivetari eject` removes the map.
- 2b40194: A closed task's history row records the card's risk and its largest prompt size, and `rivetari metrics` lists low-risk tasks that cost over $1.
- f865b05: `rivetari init` pins the Rivetari action in `rivetari.yml` to a commit SHA with the release tag as a comment (`arynbht/rivetari/packages/action@<sha> # v1.0.0`), never `@v1`. The SHA is the commit of the release the CLI belongs to (tag `v<version>`, else the latest release), read from the GitHub API; `--action-ref <sha>[:<tag>]` sets it by hand. Offline, init still finishes, but `rivetari.yml`'s step fails with a message saying the action isn't pinned and how to pin it, and a later init with a pin replaces that placeholder instead of writing a sibling. `actions/checkout` in the workflow is pinned too. Init also adds `.rivetari/** text eol=lf` to `.gitattributes` (appended once, never duplicated), and moves the rules in a repo's own CLAUDE.md into AGENTS.md's "This repo" section, leaving CLAUDE.md pointing at AGENTS.md (the old one kept as `CLAUDE.md.bak`) and saying so in its output. A CLAUDE.md that is a symlink is left alone.
- 6e00240: `rivetari init` fills the profile's `stack` from the repo: the stacks its manifests show, plus any `--stack` values mapped onto the stacks they imply (`nextjs` is node, `ts` is node and typescript), deduped, with names that map onto none (`postgres`) kept as given. `banned.json` is seeded from that stack, so a repo initialised without `--stack` no longer gets `stack: []` and an empty banned list. The package manager is read one way everywhere: package.json's `packageManager` field first, then a lockfile, a `pnpm-workspace.yaml` or `.yarnrc.yml`, then the one the scripts call by name. Init and the fix templates default to npm when nothing names one; verify and proof keep pnpm for that case for now.
- bb98a2f: `rivetari init` writes `.github/workflows/ci.yml` into a Node repo that has no CI of its own, shaped after Rivetari's fast pipeline. A PR gets one Linux job, `ci`, to make the required check. Draft PRs and docs-only changes skip the work but still report, a newer push cancels the run before it, and every job has a timeout. In a pnpm workspace, root scripts that run in every package (`pnpm -r test`) run only in the packages a PR affects, and a change outside every package checks everything. The steps come from the repo's own package manager and its lint, typecheck, test and build scripts. The default branch runs everything on Linux. Windows runs nightly for a private repo on the free plan, or one whose plan can't be read (offline, or no token). A public repo or a paid plan, read from the GitHub API, gets Windows and macOS on every push. A repo with other workflows keeps them and gets no `ci.yml`.
- cf9879d: `rivetari init` writes the profile's `proof:` block for a web app with a `dev` or `start` script: `start` runs that script with the repo's package manager (`npm run dev`, `pnpm run dev`, …) and `ready_timeout` is 180 seconds, since a first `next dev` compile on Windows is slow. A UI card's proof then serves the app without the profile being edited first. A `--force` re-init keeps a `proof:` block that's already there as it is, and `proof.auth` is never written.
- 7988d09: On a pull request, `rivetari ci` now fails only on regressions. It evaluates the gate's controls at the PR's base as well as at its head, in a throwaway worktree (fetching the base commit when the checkout is shallow), and fails only for a control that passed or was n/a at base and fails at head. A control already failing at base is listed as pre-existing, and a control not evaluated at base is listed as new; neither fails the PR. The base is the first parent of GitHub's merge commit (recognised by the PR's head sha as its second parent), or the event's `pull_request.base.sha` for any other checkout. When the base can't be read the check judges the whole repo as before and says so. The comparison is tier 1's, now exported from the runtime as `compareResults`.
- a263712: `rivetari metrics` shows where the tier 1 rules come from: from findings, stack defaults, or built in and written by hand. Banned patterns sourced from a finding count as from findings, and so do lint rules a finding's banned entry is covered by. Entering unattended now also needs 20 tier 1 rules without counting stack defaults, so from here only rules from findings move the count. `rivetari doctor` warns when the system temp folder holds 20,000 or more entries, which makes every local proof and judge run several times slower. `rivetari task status` lists a closed task as closed, including one closed before it was confirmed. The autonomy ledger re-renders its `ledger.md` when only the view changed (a formatter, say) and the signed record still verifies, and `.rivetari/` is left out of prettier so it isn't reformatted again.
- 448f7a9: Add `rivetari task run --parallel N`: run up to N tasks at once (the ids given, or every confirmed, route-approved task), each in its own worktree with its own lease and ledger as a single run has. Two tasks whose `touches` could name the same file (paths or globs) don't run together: the later one waits for the one it overlaps with, so two agents never edit one file at once (it is still cut from the default branch, so the PR that merges second may need a rebase), and a card with no touches runs alone. Every line starts with its task id, a summary says how each task ended, and the exit code is 0 when all shipped, 2 when any waits on a person, 1 when any errored. `--all` takes `--parallel` too. The default stays 1. The runtime exports `runParallel`, `touchesOverlap`, `parallelExitCode` and `oneAtATime`, and `runTask` takes an `isolating` lock so parallel tasks never pick the same port.
- 10ccc06: Autonomy now follows a trust ladder. `rivetari metrics` prints it with the current numbers: tier 1 rules (checks, diff rules, boundary rules and the repo's own lint rules), blocking findings per PR, first-pass merge rate, findings since entering the level, reverts within 7 days and the rejection rate, and what each level still needs. `rivetari profile set autonomy` refuses a level the numbers don't support unless `--override "<reason>"` is given; every change, override or fallback is recorded in a signed ledger at `.rivetari/autonomy/`. The level falls back automatically: review-at-pr drops to supervised when blocking findings pass one per PR over five PRs since entering it, or a PR is reverted within 7 days, and unattended drops on any revert or a rejection rate over 5% across 20 PRs. Entering review-at-pr needs 20 tier 1 rules or double the count at entry, 0.5 or fewer blocking findings per PR over 10 PRs, and 80% first-pass merges.
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
- 0a66e93: Rivetari v2 step 2: the skill registry. `rivetari skills init|sync|status|add|update|vendor`
  over pinned, content-hashed skills fetched into a user-level cache
  (`~/.cache/rivetari/skills/<sha256>/`, verified on every load, mirror fallback),
  scanned before install (gitleaks, fail closed; injection rules including
  auto-run hooks; human-reviewed `scan_allow` per rule or per file). Always-scope
  skills install to `.agents/skills/` with `.claude/skills/` links, git-ignored;
  the lock travels. Ships 24 manifests from the Nov 9 research.
- 8f0461f: Rivetari v2 step 3: task cards and the ledger. `rivetari task new|confirm|status|resume`.
  A card is refused unless every acceptance criterion says how it's verified; nothing
  runs until a person confirms it, and confirmation seals the card's hash. The ledger is
  an append-only, HMAC-chained `ledger.jsonl` (per-machine key outside every repo) with
  a rendered `ledger.md`; edits, forged entries, hand edits to the view and post-
  confirmation card changes are detected, and `resume` refuses a record that fails. Task
  records live in the primary checkout's git-ignored `.rivetari/tasks/`, so a task's
  worktree never holds the ledger.
- ad25e71: Rivetari v2 step 4: judge tier 2. `rivetari review` (local, or `--pr <n>` to post one PR
  review) and `rivetari judge --review` (tier 1, then tier 2 unless tier 1 needs a human).
  Only defects, contract breaches and unmet acceptance criteria block; everything else
  is a suggestion. Each blocking finding is re-checked in a fresh context and downgraded
  without a concrete reproduction. Two rounds, then needs-human. The model sees only the
  packed diff (no sensitive paths, secret-shaped or generated files; source first) and
  the base's AGENTS.md/CONSTRAINTS.md. The Claude CLI transport now runs locked down: no
  tools, safe mode, empty working directory. Judge model from profile `ai.judge_model`.
- 8b61010: Rivetari v2 step 5: the router. `rivetari task route <id>` routes a confirmed card to an
  assembly (sectors, phases, at most four task skills with conflicts and requirements
  resolved, spine skills, budget, checks, proof type, review options, stop-and-ask, gaps)
  in `.rivetari/tasks/<id>/assembly.yml`, with the reason for every decision in the ledger.
  Deterministic: built-in sector signals plus manifest triggers and profile flags.
  `rivetari task approve <id>` re-validates a possibly edited assembly and seals its hash,
  so a later edit fails verification. Routing refuses skills that weren't synced.
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

- 0901298: A card's risk is now derived, not declared. Intake derives it from the card's touches (globs are expanded to the tracked files they match) and writes the reasons to the ledger. High signals are signing and key handling, leases, the autonomy ledger, auth, billing and payments paths, migrations and schemas, infrastructure as code, and secrets handling. Medium signals are CI and workflow config, dependency manifests and lockfiles, lint and tsconfig config, and the repo's sensitive list (the assembly's stop-and-ask touches). Everything else is low, however many files it touches. `--risk` can raise the derived risk but never lowers it. The judge derives the risk again from the actual diff: the changed files, lease, signing or key code in the changed lines, and edits to existing tests the card doesn't name. When that is higher than the card's risk, the higher one counts: the fast-path review goes by it, the ledger records the raise and why, and the PR body shows the raised risk and the reasons.
- d958e57: `rivetari metrics` counted every judge finding in "Findings per PR", suggestions included, so this repo showed 2.1 while the trust ladder's blocking-per-PR was 0.10. The line is now "Blocking findings per PR" and counts blocking findings only, as the ladder does. The suggestions get a line of their own with their count and their rate per PR. `findingsMetrics` also returns `blocking` and `suggestions`, and its `findingsPerPr` is now blocking findings only.
- 391fa7d: `rivetari hook guard --help` and `rivetari hook --help` now name everything the guard refuses: edits to `.rivetari/**` and to the primary checkout on the default branch, shell commands that write them, and in a Rivetari repo a force push or remote delete, `git reset --hard`, `git clean -f` and `git branch -D`, so someone whose git command was refused can tell it came from the guard. The guard's behaviour is unchanged.
- a55c36b: `rivetari init` now adds `history.jsonl` to `.rivetari/.gitignore`, so the history that task close writes locally no longer shows as untracked; repos initialised before this aren't touched.
- 328afac: `rivetari init`, with or without `--force`, no longer replaces a `.github/workflows/rivetari.yml` that differs from the template. It leaves the file as it is and writes the template beside it as `Rivetari.rivetari.yml`, to merge by hand and then delete: every file in `.github/workflows` runs on GitHub, so the sibling shouldn't be committed.
- 40e611d: The task judge and `rivetari judge` keep one prepared workspace per repo in the user's cache (`~/.cache/rivetari/judge`, or `RIVETARI_JUDGE_CACHE`) instead of cloning and installing from scratch every round. Each round checks out the commit with `--force` and cleans everything but `node_modules`; dependencies are reinstalled only when a hash of the lockfile, the package manifests, the package manager's version and the platform changes, or the change itself touches a lockfile or manifest. A second judge on the same repo while one is running falls back to a fresh clone of its own. A manifest change in a workspace package (not only the root `package.json`) now also triggers the install at head.
- 3bcd0a9: The router no longer counts a word in the description twice. A skill whose keyword trigger matches a word the sector already scored on adds nothing, so "iac" in a description scores infra 1, not 2, and no longer puts infra in. A skill keyword found only in the description, such as terraform-skill's "state", is keyword evidence like the sector's own keywords. A skill trigger matched by a touched path still counts as path evidence.

  A borderline sector whose whole score comes from words in the description is decided not in by the router. The route's ledger records `decided not in: <sector> (scored only on description keywords)`, and at review-at-pr such a sector no longer holds the route for a person, whether the task is routed now or resumed from its ledger. A borderline sector that also scores from a path, a title word, a skill's path trigger or the repo's infrastructure as code still holds the route. Keyword-only sectors stay in the borderline list the approver is shown. The runtime's `Routing` gains `decidedOut`.

- a8c3169: `rivetari task run` runs the test suite once a round. For a `test-run` proof, the prove beat no longer runs the suite itself: it records that the judge's tier 1 run on the change is the proof, and the judge publishes that run's full log as the evidence and writes the proof record the PR body reads. A failing suite fails the proof and sends the change back to build, as before. The build prompt tells the agent to run only the tests related to the files it touched, never the whole suite. The engine's context takes an `onCommand` listener, which hears each command a detector runs, with its output. `proveTask` and `runTask` keep running their own suite unless `deferTestRun` is set; the CLI sets it.
- ef50f7b: The packages publish to GitHub Packages (`https://npm.pkg.github.com`, restricted) and name this repo as their source, so a release's publish step reaches them and links each package to the repo.
- 1116fe3: A task ledger whose `ledger.md` differs from a fresh render while every entry's seal still holds is rendered again from `ledger.jsonl` instead of reading as tampered, the same rule the autonomy ledger already follows. `ledger.md` is a view, not part of the signed record: after the rename to Rivetari every old task's view rendered differently and every task read as TAMPERED. `rivetari task resume` says when it re-rendered a view. A changed or broken entry still fails verification.
- 8b85843: A task run no longer spends rounds that change nothing. A build round where the agent leaves the worktree as it found it stops the run and asks a person, with the agent's reply as the question, instead of proving the same commit again. The agent can also end a round with a last line `RIVETARI_STOP: <question>`; the runtime asks it without committing or proving, and the next round gets the answer. The judge's reviewer and its false-positive gate now see every stop-and-ask a person allowed, with who and when, and are told not to block on it. A failing test run is retried once and run on the base: a failure that passes on the retry is reported as flaky, and one that also fails on the base as pre-existing, and neither fails the proof. Build rounds after the first resume the agent's previous session. A failed push while reserving a task id gives the id back, `rivetari task status` skips a folder with no card instead of failing, and a beat whose final push fails says the beat is done and exits 1. The judge's cost uses the cost the Claude CLI reports, and the price table now covers Claude Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1, so the judge no longer reads $0.
- c9312b5: Intake refuses a card whose `touches` has a glob matching more than 20 of the repo's tracked files, before an id is reserved for it. A card's touches feed the build prompt's slice, the router and the fast path, and a glob such as `packages/**/*.test.ts` can name hundreds of files. The message names the glob, how many files it matches and the first few of them, and asks for the files by name or a narrower glob. `rivetari task new` checks cards given with `--touches` and with `--from` alike. A plain path, a glob matching 20 files or fewer, and a glob that matches no tracked file yet (for new files) are accepted. The runtime exports the check as `checkTouches` and the cap as `TOUCHES_CAP`.
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
- 29f786d: The trust ladder now re-renders a stale autonomy ledger view and verifies the ledger before reading it. A ledger that fails verification, isn't valid JSON lines, or whose key can't be read leaves the repo running supervised, gets nothing appended, and is named with its problems in `rivetari metrics` and the session-start text.
- Updated dependencies [08a3a60]
- Updated dependencies [497f5bb]
- Updated dependencies [d8d68e1]
- Updated dependencies [28e3957]
- Updated dependencies [4b5c8b2]
- Updated dependencies [5b3e8cf]
- Updated dependencies [6b51f7a]
- Updated dependencies [28e3957]
- Updated dependencies [d4d1a10]
- Updated dependencies [9db492e]
- Updated dependencies [71b0956]
- Updated dependencies [e715d32]
- Updated dependencies [28e3957]
- Updated dependencies [0901298]
- Updated dependencies [2a4debb]
- Updated dependencies [908c1f5]
- Updated dependencies [03bb3e5]
- Updated dependencies [d958e57]
- Updated dependencies [4b5c8b2]
- Updated dependencies [9ac4aca]
- Updated dependencies [28e3957]
- Updated dependencies [ad769fc]
- Updated dependencies [53fa997]
- Updated dependencies [3578bfb]
- Updated dependencies [2b40194]
- Updated dependencies [6e00240]
- Updated dependencies [a4a1d70]
- Updated dependencies [40e611d]
- Updated dependencies [3bcd0a9]
- Updated dependencies [24781e4]
- Updated dependencies [42de90a]
- Updated dependencies [a8c3169]
- Updated dependencies [28e3957]
- Updated dependencies [a3ca4d7]
- Updated dependencies [7988d09]
- Updated dependencies [87d646b]
- Updated dependencies [31821c8]
- Updated dependencies [ef50f7b]
- Updated dependencies [328afac]
- Updated dependencies [1116fe3]
- Updated dependencies [9e16e95]
- Updated dependencies [6e4eb52]
- Updated dependencies [328afac]
- Updated dependencies [a263712]
- Updated dependencies [7ee93c7]
- Updated dependencies [8b85843]
- Updated dependencies [df42f33]
- Updated dependencies [eb93ad1]
- Updated dependencies [da6ad10]
- Updated dependencies [eef91ca]
- Updated dependencies [448f7a9]
- Updated dependencies [c9312b5]
- Updated dependencies [10ccc06]
- Updated dependencies [e31c711]
- Updated dependencies [be49a10]
- Updated dependencies [ce71405]
- Updated dependencies [9d2955f]
- Updated dependencies [0316288]
- Updated dependencies [0a66e93]
- Updated dependencies [0a66e93]
- Updated dependencies [0a66e93]
- Updated dependencies [0a66e93]
- Updated dependencies [8f0461f]
- Updated dependencies [ad25e71]
- Updated dependencies [8b61010]
- Updated dependencies [8b61010]
- Updated dependencies [cfba43b]
- Updated dependencies [5cb919e]
- Updated dependencies [4d5e653]
- Updated dependencies [0a66e93]
- Updated dependencies [29f786d]
- Updated dependencies [a13f3a1]
  - @arynbht/rivetari-runtime@1.0.0
  - @arynbht/rivetari-engine@2.0.0
  - @arynbht/rivetari-catalog@2.0.0
  - @arynbht/rivetari-registry@1.0.0

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
- 645b46e: Add `rivetari init`: an interactive (`@clack/prompts`) or flag-driven setup that
  writes `.rivetari/{profile,waivers,evidence}.yml` and `.github/workflows/rivetari.yml`
  (with the PR + weekly-schedule triggers), then runs the first audit. It refuses to
  overwrite an existing config without `--force`, and `--type` is required in
  non-interactive mode.
- 16b72ba: Add the project profile and applicability. A `.rivetari/profile.yml` (schema with a
  **constrained** flag set — unknown flags are rejected) describes the project's
  type, stack, phase, risk flags, lane toggles, and severity floor. The engine
  evaluates each control's `applies` predicate (all/any/not over flag/type/stack/
  phase-at-least, plus lane toggles) and marks non-applicable controls with the new
  `n/a` status instead of running them. `rivetari audit` honours the profile and
  severity floor; `rivetari profile show|set` reads and edits the profile.
- 281411c: Add `markdown` and `github` report formats to `rivetari audit --format`. Markdown
  renders a PR-comment/job-summary-friendly table of blocking controls; github emits
  `::error`/`::warning` workflow annotations plus a summary line (used by the Action).
- ab8dd05: Add waivers. A waiver (`.rivetari/waivers.yml`: control, reason, owner, created,
  expires) turns a non-passing control into the new `waived` status while active;
  an expired waiver has no effect (the control stays failing). `rivetari waive
<control> --reason --expires [--owner]` records one, the audit reports `waived`
  and warns about waivers expiring within 30 days, and gates treat waived controls
  as satisfied.
- 96e4fa2: Add `rivetari fix --pr`: apply the plan on a dedicated `rivetari/<date>-<gate>`
  branch, commit one change per control, push, and open a pull request titled
  `rivetari: <n> fixes for <gate>` — reusing (and refreshing) the existing open
  Rivetari PR for that branch instead of opening duplicates. Requires a clean
  working tree, skips settings effects that can't live in a PR, folds the
  managed-file registry into the branch, and always returns the tree to the base
  branch. New `openFixPr` orchestrator (git via simple-git) and `openOrReusePr`
  (Octokit, MSW-tested) in the engine.
- 67cfb6e: Add the `rivetari fix` command: evaluate controls, select the non-passing ones that
  carry a generator, and plan their changes. Dry-run by default (a `+ create` / `~ update`
  / `· skip` / `⚙ would apply` preview that never touches disk); `--write` applies them.
  Honours `--control`, `--gate`, and `--lane` selectors and the profile severity-floor,
  reuses the never-clobber apply engine so a human-owned file is left untouched, and is
  idempotent — a second run reports zero file changes.
- 9b44163: Add the `rivetari ai <task> [path]` command: runs the audit for gap context, drafts
  the artifact with Claude (via the `claude` generator), and previews it (dry-run
  default), applies it with `--write`, or opens/reuses a PR with `--pr`. Reports the
  model, token usage, and the exact files consulted, and gives clear errors for a
  missing `ANTHROPIC_API_KEY` or an unknown task (listing the available ones).
- a48d87e: Add AI usage accounting. Every `rivetari ai` call appends a JSON line (date, task,
  model, tokens, estimated USD cost) to `.rivetari/ai-usage.log` (gitignored), and
  `rivetari ai usage` summarizes it — totals plus per-task and per-day breakdowns. Cost
  is estimated from a small per-model price table; an unpriced model counts as $0.
  Logging never fails the command.
- a97d22f: Add the Claude Code skill (`packages/catalog/skill/SKILL.md`, exposed via
  `bundledSkillDir`): it teaches an agent in a target repo to run `rivetari audit`
  instead of guessing, read the gap report, and remediate with `rivetari fix` or draft
  missing artifacts with `rivetari ai`, under "Claude drafts, humans sign". `Rivetari
init` now installs it into `.claude/skills/rivetari/SKILL.md` (never-clobber; init
  doesn't fail if it can't be read), and the action bundle copies `skill/` and folds
  it into the staleness hash.
- c23be6b: Add `rivetari metrics`: the four DORA keys computed from the GitHub API with no extra
  services — deployment frequency (releases/week), lead time (PR open→merge median),
  change failure rate (merged PRs that are reverts/hotfixes), and time to restore
  (`incident`-labeled issue open→close median) — each with its proxy documented and
  `null` when there isn't enough data. `--window <days>` and `--json` supported. The
  Action also appends a per-lane pass snapshot to `.rivetari/history.jsonl` on each run
  (hygiene trend); `loadHistory`/`laneCounts` read it back.
- 63354f9: Add `rivetari audit --all`: audit every repo listed in `~/.config/rivetari/repos.yml`
  (or `--repos <file>` — a YAML list of paths) and print one combined table (pass /
  fail / needs-evidence / total per repo), marking a missing or erroring repo inline
  and exiting non-zero if any repo has a critical failure. `--json` for the combined
  result.
- 1f823bd: Add `rivetari status`: infers the project phase (the lowest phase whose gate is not
  green) and lists the blocking controls (fail / needs-evidence) in severity then
  effort order, each tagged with its effort. Shows every defined gate's state and the
  profile's declared phase (a floor, never a ceiling). `--json` for machine output.
  `ControlResult` now carries `effort` so consumers can prioritize by it.

### Patch Changes

- fe0f33c: Dead-code cleanup. Remove the unused taxonomy exports `LaneCode`, `PHASE_BY_KEY`,
  `ProjectType`, `FlagKey`, and `Effort`, and make `PhaseDef` internal (none were
  imported anywhere; `LaneKey`/`LaneDef`/`PhaseKey` stay exported because exported
  consts reference them). Extract a shared `today()` helper in the CLI, replacing
  the `new Date().toISOString().slice(0, 10)` duplicated across the waiver,
  evidence, fix, AI, and CI paths. Add an `assertNever` exhaustiveness guard to the
  `fixSummary` switch in `site.cli.ts` so a future fix type can't silently render
  "undefined" into `docs/catalog/`.
- fe0f33c: Dogfood `ci.actions-pinned-sha`: pin every `uses:` in `ci.yml` and `release.yml`
  to a commit SHA with a version comment (actions/checkout v4.4.0, actions/setup-node
  v4.4.0, pnpm/action-setup v4.3.0, gitleaks/gitleaks-action v2.3.9,
  changesets/action v1.9.0). Rivetari previously failed its own control; Renovate
  (`helpers:pinGitHubActionDigests`) keeps the pins current. `rivetari audit --lane
cicd` is now fully green.
- 95417a3: AI now uses the developer's Claude subscription via the Claude Code CLI by
  default, not a metered API key. A new `claudeCliTransport` runs `claude` in
  headless mode (`claude -p --output-format json`, subscription auth); the AI
  client picks it automatically when the `claude` binary is on PATH and falls back
  to the `ANTHROPIC_API_KEY` SDK transport otherwise (`preferApiKey` forces the
  API). The `claude` fix generator only auto-drafts when AI is explicitly
  configured (`ctx.aiEnabled`: an injected transport or an API key), so a plain
  `rivetari fix`/dry-run never spawns the interactive CLI; deliberate drafting via
  `rivetari ai` uses the subscription.
- 5431e4b: Fix three engine date/metric correctness bugs: DORA `deploymentFrequencyPerWeek`
  now returns `null` (not `Infinity`/`NaN`) when `windowDays <= 0`, matching the
  other metrics; zone-less datetimes (`2026-11-01T00:00:00`) are parsed as UTC
  instead of the host local timezone so a waiver or evidence date means the same
  instant on a laptop and in CI; and the evidence `valid-for` window is anchored to
  the start of the issue date (new `startOfDayMs`) rather than the end of that day,
  removing the ~1 extra day and making the evidence window symmetric with waiver
  expiry.
- fe0f33c: Keep `rivetari audit` machine output valid. Previously `--gate` appended
  human-readable, colorized gate lines to stdout and the "waiver/evidence
  expiring" warnings were always written to stdout, so `--json` / `--format
markdown|github` combined with a gate (or an expiring waiver) produced
  unparseable output. Gate results are now folded into the JSON object (a `gates`
  array) and rendered in-format for markdown/github; advisory expiry warnings go
  to stderr for machine formats. `--format table` is unchanged.
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
- fe0f33c: Honor the merge policy's `.rivetari-suggested` escape hatch. A `merge` fix that
  targets a file Rivetari previously wrote but a human has since edited no
  longer re-serializes over those edits; it writes the merged result alongside as
  `<path>.rivetari-suggested` and reports a `suggest` action so the human can
  reconcile it by hand. First-time merges into a human-authored file (minimal
  structural insertion) are unchanged.
- 4d2db9e: Harden the audit CLI after the M1 review: validate `--format` against
  `table|json` (an unknown value is now rejected, not silently rendered as a
  table); fail fast with a clear message when the audit path is missing or not a
  directory; disable colour for non-TTY output and when `NO_COLOR` is set; and stop
  shipping `.tsbuildinfo` inside published packages. Adds an end-to-end `runAudit`
  integration test (report output, lane filter, `.rivetari/state.json` contents, and
  exit code) with an offline token override so it needs no network.
- 36a2407: Harden the `rivetari ci` Action entrypoint after the M2 review: an unknown
  `RIVETARI_GATE` now fails closed (was: every PR passed green); a malformed
  profile/waivers/evidence file fails with an error (was: silently ignored); PR
  context is detected by a resolvable PR number rather than only the literal
  `pull_request` event; an amber scheduled gate keeps the status issue open instead
  of closing it; expiring waivers/evidence are listed in the report body; and GitHub
  annotations escape newlines/`%`/`,` so a detector message can't truncate or spoof
  them.
- b7e3ceb: Final M2-review hardening: `rivetari init` no longer clobbers existing
  `waivers.yml`/`evidence.yml`/`rivetari.yml` when only the profile is absent (each
  write is guarded, `--force` overrides). Add CLI tests for `profile set`, `waive`,
  `evidence add`, and `audit --gate` (red → exit 1, unknown gate → error), and stop
  hard-coding the catalog size in integration tests. The action build now emits a
  deterministic `SOURCE_SHA256` that CI diffs, so a committed bundle that wasn't
  rebuilt after a source change fails the build.
- d8cf3e7: Add the generator framework and merge policy (ADR-0004) that `rivetari fix` builds
  on. `.rivetari/state.json` gains a managed-file hash registry with
  `managedFileUnchanged`; `applyChanges` applies a plan of changes dry-run-by-default,
  never overwriting a human-edited file (a `create` file is written only when absent
  or rivetari-managed-and-unchanged; a `merge` file writes its already-merged
  contents; effects run only in write mode) and records hashes on write. Adds the
  generator type + registry + `planControls` dispatch (generators themselves land in
  M3.2+). The audit now preserves the managed registry across runs.
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

- 2a0db12: CLI UX polish from the full-repo review:

  - `rivetari fix` and `rivetari ci` now list each catalog error (file + message) on an
    invalid catalog, matching `rivetari audit` instead of printing only a count.
  - `rivetari profile set flags.<x>`/`lanes.<x>` rejects a non-boolean value instead
    of silently coercing it to `false`.
  - `rivetari evidence add` reports errors with a `rivetari evidence add:` prefix and
    unwraps `EvidenceError`, consistent with the other commands.
  - `rivetari audit` errors when `--json` and a conflicting `--format` are both given
    (`--json` is shorthand for `--format json`).
  - `rivetari fix --control <id>` help note: it applies regardless of the severity
    floor.
  - `rivetari fix` "nothing to apply" message is accurate whether controls already
    pass or simply have no generator.

- Updated dependencies [fe0f33c]
- Updated dependencies [95417a3]
- Updated dependencies [5431e4b]
- Updated dependencies [fe0f33c]
- Updated dependencies [fe0f33c]
- Updated dependencies [b947439]
- Updated dependencies [fe0f33c]
- Updated dependencies [fe0f33c]
- Updated dependencies [fe0f33c]
- Updated dependencies [fe0f33c]
- Updated dependencies [fe0f33c]
- Updated dependencies [fe0f33c]
- Updated dependencies [fe0f33c]
- Updated dependencies [fe0f33c]
- Updated dependencies [1b932c6]
- Updated dependencies [636822f]
- Updated dependencies [2f52773]
- Updated dependencies [01d4b28]
- Updated dependencies [bc577e0]
- Updated dependencies [25b2f62]
- Updated dependencies [a60f31f]
- Updated dependencies [a156198]
- Updated dependencies [681f6ef]
- Updated dependencies [56991cf]
- Updated dependencies [3257bac]
- Updated dependencies [ba927e1]
- Updated dependencies [7c9e9eb]
- Updated dependencies [0e83bcc]
- Updated dependencies [16b72ba]
- Updated dependencies [ab8dd05]
- Updated dependencies [be6c303]
- Updated dependencies [8581cc7]
- Updated dependencies [2a4bd4d]
- Updated dependencies [96e4fa2]
- Updated dependencies [d8cf3e7]
- Updated dependencies [3b7ca5e]
- Updated dependencies [473e9bc]
- Updated dependencies [d1fb3be]
- Updated dependencies [c59168f]
- Updated dependencies [a48d87e]
- Updated dependencies [abba775]
- Updated dependencies [876bc45]
- Updated dependencies [7e613e2]
- Updated dependencies [a97d22f]
- Updated dependencies [e84788b]
- Updated dependencies [81ce412]
- Updated dependencies [fe0f33c]
- Updated dependencies [c23be6b]
- Updated dependencies [1f823bd]
- Updated dependencies [edb2260]
- Updated dependencies [1f1030b]
- Updated dependencies [869e453]
- Updated dependencies [563aea4]
- Updated dependencies [96bd726]
  - @arynbht/rivetari-catalog@1.0.0
  - @arynbht/rivetari-engine@1.0.0
