# @arynbht/rivetari-runtime

## 1.0.0

### Major Changes

- 328afac: The software factory is now **Rivetari**. Everything is renamed, with no compatibility layer: the packages are `@arynbht/rivetari`, `@arynbht/rivetari-engine`, `@arynbht/rivetari-runtime`, `@arynbht/rivetari-catalog` and `@arynbht/rivetari-registry` (the `@arynbht/factory*` names are deprecated); the CLI is `rivetari` and the Claude Code skill `/rivetari`; a repo's state lives in `.rivetari/`, its workflow is `.github/workflows/rivetari.yml`, tasks are shared on the `rivetari/tasks` branch, environment variables are `RIVETARI_*`, the needs-a-person label is `rivetari:needs-human`, and the user's config and cache are `~/.config/rivetari` and `~/.cache/rivetari`. A repo set up with the factory needs `.factory/` moved to `.rivetari/`, its workflow, hooks and skill re-installed with `rivetari init --force`, and its tasks branch copied to `rivetari/tasks`. Ledgers signed before the rename are moved, not rewritten, so their entries still read as they were sealed and still verify.

### Minor Changes

- 08a3a60: In a pnpm workspace, tier 1 checks only the packages a change can affect: the packages its files sit in, plus every package that depends on one of them, transitively, read from `pnpm-workspace.yaml` and the package manifests at both base and head. The same scope runs on both sides, so the comparison stays like for like. A check is narrowed when its root script ends in vitest or jest (the packages become path filters, with `--passWithNoTests` and coverage off) or is `pnpm -r run <script>` (the packages become `--filter`s); any other check runs on every package. Because a narrowed test run covers part of the code, the coverage floor runs only when the tests run in full. A change outside every package (root `package.json`, the lockfile, a root tsconfig, vitest or eslint config, `scripts/`), a root package that depends on an affected package, or a repo that isn't a readable pnpm workspace checks everything, as before. The verdict notes say which packages were checked and why, which checks ran in full, and when the coverage floor was skipped.
- 497f5bb: Every `claude -p` call now has a time limit, and `rivetari task run` has a wall-clock budget, so a hung call can't keep a task running all night. Each call (the build agent, the judge's review through the CLI transport, the audit swarm and the write-agent) is killed after 20 minutes, or `RIVETARI_CALL_TIMEOUT_MINUTES`; on Windows the whole process tree is killed, not just the cmd.exe shim. One `rivetari task run` gets 90 minutes, or `RIVETARI_TASK_BUDGET_MINUTES`, and when the budget runs out during a call that call is killed. Either limit stops the task as a stop-and-ask with the new `timeout` trigger: the ledger names the limit that fired and its value, `rivetari task run` exits 2, and answering it runs the build or judge beat again. A judge stopped this way never reaches a verdict, so allowing it judges again instead of shipping.
- d8d68e1: A confirmed card can be amended until the task is isolated. Before, any edit to `card.yml` after confirmation was reported as tampering, so a card that left out a path could only be abandoned and redrafted. Now a person edits the card and runs `rivetari task confirm` again: the ledger records `intake amended; card sha256 <new> (was <old>)` by whoever confirmed it, and verification checks the card against the latest hash. An earlier route approval no longer counts after an amendment, and an assembly proposed for the old card is set aside, so the route is proposed and approved again for the amended card. Once the task is isolated, confirm refuses an edited card with a message saying the card is fixed after isolate, and the edit is still reported as a problem.
- 4b5c8b2: The profile takes `autonomy: supervised | review-at-pr | unattended`, default `supervised`. At `review-at-pr` the card is confirmed and the route approved without asking, unless the route has a borderline sector or touches a sensitive path. Stops split into hard ones, which still pause the round (protected paths outside existing tests, rewritten history, a secret, a non-local `DATABASE_URL`, a new dependency whose license isn't on the OSI list or can't be read), and soft ones the build goes on past and flags (a new OSI-licensed dependency, a changed existing test, a schema change). The judge is told about flagged decisions, and the draft PR lists them under "Decisions you would have been asked" with the lockfile, schema or test diff inline. A high-risk task keeps every gate at any level. At `unattended`, `rivetari task run --all` runs every routed task in turn and parks any that would ask, which session start lists under "Needs you". Every PR body now carries the card and the route.
- 5b3e8cf: A repo can ban patterns, and the judge fails a change that adds one. The list lives in `.rivetari/banned.json`; `rivetari init` seeds it with defaults for the stack (eval, new Function, debugger and raw innerHTML for Node; eval, exec, pickle loads, shell=True and breakpoint() for Python), and `rivetari banned seed|add|allow|list` maintains it. Tier 1 checks the change's added lines against the base's list, so a change can't loosen the rules it's judged by, and the tier 2 reviewer sees the list as part of the contract. Each entry counts once in the trust ladder's rule count; an entry a lint rule already enforces is marked `covered_by` and isn't counted twice. The stop detector no longer treats a test file that names a secret as data as a secret; real key shapes in test files still stop the round. Each build round's tokens, turns and whether it was a retry are recorded in the task's history row, and a build round with flagged decisions now counts towards the task's token totals again.
- 6b51f7a: Tier 1 runs the base's checks once per base commit. A check that's green (or n/a) at a base is kept, keyed by the base commit, the checks, the installed dependencies and the env the checks see, and every later round and task on that base reuses it. A check that's red at base is never kept, since it may be a flake and a cached one would mark the change's real failures as pre-existing; it runs again every time. Coverage is read from the same side's test run, so when coverage has to run again, so do the tests.
- d4d1a10: The build and plan prompts get a capped repo slice: the card's source touches, the files they import directly by relative path (one level, no bare package imports), and the test files beside those sources. A test glob in the card's touches, such as `packages/**/*.test.ts`, is no longer expanded, so it can't pull in every test in the repo. The plan call gets the same slice, runs with a 4-turn limit (`--max-turns 4`) and can't start subagents (their turns don't count toward the limit); it no longer runs in `--permission-mode plan`, since its read-only allowed tools already keep it from changing anything. When the plan call reaches its turn limit, the task stops and asks (`budget_exhausted`, naming the limit) instead of failing with `claude exited with code 1`: allowed, it plans again with twice the turns; denied, it plans again within the limit with the person's note. The build-start ledger line records the assembled prompt's approximate size, `~N prompt tokens`, next to the file count. A low-risk card's assembly gets a 15k-token context budget; medium and high keep 60k.
- 9db492e: Add a `ci` block to the profile. `ci.budget_minutes_per_month` sets the GitHub Actions minutes the repo means to spend in a month: `rivetari doctor` warns once the month reaches 75% of it, and the status issue shows the month so far against it. Minutes are counted per job and rounded up, as GitHub bills. A closed task's history row records the minutes and runs its PR's CI used (`ci_minutes`, `ci_runs`).

  `ci.trust_judge` decides whether shipping a task the judge passed posts a `rivetari/judge` check run on its head commit, with the judge record's sha256 and the ledger hash, which CI can trust to skip lint, typecheck and tests. Unset, it's true on repos owned by the account Rivetari's App is registered to and false on anyone else's. The App now asks for `checks: write`.

- 0901298: A card's risk is now derived, not declared. Intake derives it from the card's touches (globs are expanded to the tracked files they match) and writes the reasons to the ledger. High signals are signing and key handling, leases, the autonomy ledger, auth, billing and payments paths, migrations and schemas, infrastructure as code, and secrets handling. Medium signals are CI and workflow config, dependency manifests and lockfiles, lint and tsconfig config, and the repo's sensitive list (the assembly's stop-and-ask touches). Everything else is low, however many files it touches. `--risk` can raise the derived risk but never lowers it. The judge derives the risk again from the actual diff: the changed files, lease, signing or key code in the changed lines, and edits to existing tests the card doesn't name. When that is higher than the card's risk, the higher one counts: the fast-path review goes by it, the ledger records the raise and why, and the PR body shows the raised risk and the reasons.
- 03bb3e5: Small cards take a fast path. A low-risk card that names at most two source files (generated files and changesets don't count) gets no separate plan call: its plan is its acceptance criteria, recorded in the ledger as before. Its review runs on a smaller model (`claude-sonnet-5-5`) with a 3-minute timeout and no retries; a review that doesn't finish in time is logged and handed to the full review, so a card is never failed for it. Every other card is planned and reviewed as before.
- d958e57: `rivetari metrics` counted every judge finding in "Findings per PR", suggestions included, so this repo showed 2.1 while the trust ladder's blocking-per-PR was 0.10. The line is now "Blocking findings per PR" and counts blocking findings only, as the ladder does. The suggestions get a line of their own with their count and their rate per PR. `findingsMetrics` also returns `blocking` and `suggestions`, and its `findingsPerPr` is now blocking findings only.
- 4b5c8b2: Recurring judge findings can now become rules. Every tier 2 finding carries a stable `pattern` id, and a closed task's history row records its findings by pattern. `rivetari metrics` (and `rivetari metrics --findings`, which needs no GitHub) reports the judge's tier 1 rule count, findings per PR, how often each pattern recurs, and any pattern seen in two or more PRs as a candidate rule. Tier 1 gains three diff rules that fail closed: no new code comments (opt in with `quality.no-new-comments` in the profile), no Markdown added or edited unless the card names it, and no new suppressions or skipped and focused tests. The catalog gains `quality.boundaries.clean`, which runs a repo's `boundaries` script when it has a dependency-cruiser config.
- ad769fc: The floorplan skill (haydenschmitty/floorplan, pinned at v0.11.0) ships as a task-scope registry manifest, and a profile's new `floorplan` flag keeps its map of the codebase in `floorplan/`: `rivetari init` turns it on for new repos and draws one, and closing a merged task updates it. Rivetari runs only the skill's offline scripts, unattended, and the model's answers go through the build agent's transport with their usage logged; a failure is reported and never stops init or close. Profiles without the flag are off. `rivetari eject` removes the map.
- 2b40194: A closed task's history row records the card's risk and its largest prompt size, and `rivetari metrics` lists low-risk tasks that cost over $1.
- 40e611d: The task judge and `rivetari judge` keep one prepared workspace per repo in the user's cache (`~/.cache/rivetari/judge`, or `RIVETARI_JUDGE_CACHE`) instead of cloning and installing from scratch every round. Each round checks out the commit with `--force` and cleans everything but `node_modules`; dependencies are reinstalled only when a hash of the lockfile, the package manifests, the package manager's version and the platform changes, or the change itself touches a lockfile or manifest. A second judge on the same repo while one is running falls back to a fresh clone of its own. A manifest change in a workspace package (not only the root `package.json`) now also triggers the install at head.
- 24781e4: The profile takes an optional top-level `generated` list of globs. Tier 1's `diff.markdown-in-card` no longer fails Markdown under those globs or under `.changeset/`, so a change that regenerates docs (such as `docs/catalog/*.md` after a new catalog control) or adds the changeset a published package needs passes without the card naming those paths. An unnamed README or other hand-written Markdown still fails. The build prompt's line for the rule names the paths it skips.
- a8c3169: `rivetari task run` runs the test suite once a round. For a `test-run` proof, the prove beat no longer runs the suite itself: it records that the judge's tier 1 run on the change is the proof, and the judge publishes that run's full log as the evidence and writes the proof record the PR body reads. A failing suite fails the proof and sends the change back to build, as before. The build prompt tells the agent to run only the tests related to the files it touched, never the whole suite. The engine's context takes an `onCommand` listener, which hears each command a detector runs, with its output. `proveTask` and `runTask` keep running their own suite unless `deferTestRun` is set; the CLI sets it.
- 7988d09: On a pull request, `rivetari ci` now fails only on regressions. It evaluates the gate's controls at the PR's base as well as at its head, in a throwaway worktree (fetching the base commit when the checkout is shallow), and fails only for a control that passed or was n/a at base and fails at head. A control already failing at base is listed as pre-existing, and a control not evaluated at base is listed as new; neither fails the PR. The base is the first parent of GitHub's merge commit (recognised by the PR's head sha as its second parent), or the event's `pull_request.base.sha` for any other checkout. When the base can't be read the check judges the whole repo as before and says so. The comparison is tier 1's, now exported from the runtime as `compareResults`.
- 87d646b: Add `proof.auth` to the profile, so UI proof can shoot pages behind sign-in instead of the login redirect. `proof.auth.script` names a JavaScript module whose default export, `async ({ page, context, baseURL }) => {}`, signs in. The proof runner runs it on each side once the app answers and before any screenshot, with rivetari's own Playwright in a child process that gets the allowlisted environment plus PORT and URL, then saves the browser's cookies and local storage as a Playwright storageState in a temp dir and shoots every page, before and after, with it. A script that throws, times out or leaves no cookies or local storage fails the proof saying why: on the base it stops the proof as a setup problem, on the change it's a failed proof sent back to build.
- a263712: `rivetari metrics` shows where the tier 1 rules come from: from findings, stack defaults, or built in and written by hand. Banned patterns sourced from a finding count as from findings, and so do lint rules a finding's banned entry is covered by. Entering unattended now also needs 20 tier 1 rules without counting stack defaults, so from here only rules from findings move the count. `rivetari doctor` warns when the system temp folder holds 20,000 or more entries, which makes every local proof and judge run several times slower. `rivetari task status` lists a closed task as closed, including one closed before it was confirmed. The autonomy ledger re-renders its `ledger.md` when only the view changed (a formatter, say) and the signed record still verifies, and `.rivetari/` is left out of prettier so it isn't reformatted again.
- 7ee93c7: The build prompt lists the rules the judge checks on the diff before anything else, one line each: every enabled diff rule (no new comments when the profile turns it on, Markdown only where the card names it, with the card's paths, no new suppressions) and every banned pattern in `.rivetari/banned.json` at the base. They're generated from the same sources the judge reads, so the agent meets them on the first pass instead of learning them from a failed round.
- 8b85843: A task run no longer spends rounds that change nothing. A build round where the agent leaves the worktree as it found it stops the run and asks a person, with the agent's reply as the question, instead of proving the same commit again. The agent can also end a round with a last line `RIVETARI_STOP: <question>`; the runtime asks it without committing or proving, and the next round gets the answer. The judge's reviewer and its false-positive gate now see every stop-and-ask a person allowed, with who and when, and are told not to block on it. A failing test run is retried once and run on the base: a failure that passes on the retry is reported as flaky, and one that also fails on the base as pre-existing, and neither fails the proof. Build rounds after the first resume the agent's previous session. A failed push while reserving a task id gives the id back, `rivetari task status` skips a folder with no card instead of failing, and a beat whose final push fails says the beat is done and exits 1. The judge's cost uses the cost the Claude CLI reports, and the price table now covers Claude Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1, so the judge no longer reads $0.
- eef91ca: A running task now shows that it's alive. While `rivetari task run` runs a beat it writes a small progress file beside the task's directory, `.rivetari/tasks/<id>.progress.json`: the beat, when it started, when it last did something, and for the build the agent's turns, tokens and last tool so far. It's written atomically, at most every 2 seconds, and removed when the beat ends; it's never part of the ledger, the tasks branch or anything the judge hashes, and a file left by a process that died is ignored. The build agent reads `claude -p` as `--output-format stream-json --verbose` so it can count turns while the call runs, and still returns the same reply, cost, turns and turn limit from the final result. `spawnWithLimit` takes an `onLine` callback that hears stdout line by line. `watchTasks` puts each running task's progress on its view (`progress`), polls it on its own so it stays live during a slow read, counts a ledger entry as activity, and with `localFirst` lists this machine's copies at once before merging the tasks branch's view in; the branch read now loads up to 8 tasks at a time. `loadTask` takes `readOnly`.

  In the desktop Tasks tab each running task shows "Running: build · 12 min · turn 18 · last activity 20 s ago", updated every second, and "No activity for N min" in amber after five quiet minutes; "Next: …" shows only when nothing is running. The list appears from the local copies first (about 50 ms for this repo's 31 tasks, down from about 11 s) and no longer carries every task's ledger: the open task's ledger is fetched on its own (`tasks:ledger`) and again when it grows.

- 448f7a9: Add `rivetari task run --parallel N`: run up to N tasks at once (the ids given, or every confirmed, route-approved task), each in its own worktree with its own lease and ledger as a single run has. Two tasks whose `touches` could name the same file (paths or globs) don't run together: the later one waits for the one it overlaps with, so two agents never edit one file at once (it is still cut from the default branch, so the PR that merges second may need a rebase), and a card with no touches runs alone. Every line starts with its task id, a summary says how each task ended, and the exit code is 0 when all shipped, 2 when any waits on a person, 1 when any errored. `--all` takes `--parallel` too. The default stays 1. The runtime exports `runParallel`, `touchesOverlap`, `parallelExitCode` and `oneAtATime`, and `runTask` takes an `isolating` lock so parallel tasks never pick the same port.
- c9312b5: Intake refuses a card whose `touches` has a glob matching more than 20 of the repo's tracked files, before an id is reserved for it. A card's touches feed the build prompt's slice, the router and the fast path, and a glob such as `packages/**/*.test.ts` can name hundreds of files. The message names the glob, how many files it matches and the first few of them, and asks for the files by name or a narrower glob. `rivetari task new` checks cards given with `--touches` and with `--from` alike. A plain path, a glob matching 20 files or fewer, and a glob that matches no tracked file yet (for new files) are accepted. The runtime exports the check as `checkTouches` and the cap as `TOUCHES_CAP`.
- 10ccc06: Autonomy now follows a trust ladder. `rivetari metrics` prints it with the current numbers: tier 1 rules (checks, diff rules, boundary rules and the repo's own lint rules), blocking findings per PR, first-pass merge rate, findings since entering the level, reverts within 7 days and the rejection rate, and what each level still needs. `rivetari profile set autonomy` refuses a level the numbers don't support unless `--override "<reason>"` is given; every change, override or fallback is recorded in a signed ledger at `.rivetari/autonomy/`. The level falls back automatically: review-at-pr drops to supervised when blocking findings pass one per PR over five PRs since entering it, or a PR is reverted within 7 days, and unattended drops on any revert or a rejection rate over 5% across 20 PRs. Entering review-at-pr needs 20 tier 1 rules or double the count at entry, 0.5 or fewer blocking findings per PR over 10 PRs, and 80% first-pass merges.
- e31c711: At review-at-pr and unattended, the judge never passes a round with an unverified acceptance criterion. Tier 2 now reports each criterion as met, unmet or unverified, and is told to say unverified rather than guess met when the diff, the tests and the proof don't show it; a criterion it doesn't report on counts as unverified too. Such a round stops with an `unverified_acceptance` question that names each criterion and why, so `rivetari task run` exits 2; `--allow` ships it with the answer recorded, `--deny` sends it back to build with the note. At supervised the round passes and the ledger records the unverified criteria for the person reviewing the PR. The review now sees the task's proof (the proof lines, the test run, and per screenshot what the proof runner measured: page width against the viewport, elements past its edge, the start of the page's text). On a fix card with a UI proof the reviewer must say whether the before shows the defect; if it doesn't, the criteria that depend on it are unverified. Changed Markdown brings the repo files its added lines cite in backticks, at head: only files that exist, never sensitive, generated, binary or secret-shaped ones, at most 20,000 characters each and 60,000 in all.
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

- 0316288: Rivetari v2.1 step 7c, from the first done-check run: the judge posts its verdict on the PR as one review from the App, and labels the PR `rivetari:needs-human` when a person decided; a protected change allowed at build isn't asked about again in the judge, so the tier 2 review runs; the test-run proof names every test a change adds, including tests added to an existing file, and uploads the test run to the `evidence` branch.
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

- a13f3a1: Add `watchTasks` and `readTasks`, a read-only view of every task in a repo for the desktop shell. Each task is read the way `rivetari task status` shows it (the `rivetari/tasks` branch's copy, unless this machine's holds work the branch hasn't had, or the task is only here), with its beat, next step, lease, build and judge rounds, tokens and cost, PR, whether it waits on a person and why, and its ledger entries. `watchTasks` emits a snapshot, then `added`, `changed` (with the new ledger entries) and `removed` events by polling, and `stop()` ends it. Nothing is fetched, no ref moves and nothing under `.rivetari/` is written: records are loaded from scratch copies outside the repo.

### Patch Changes

- e715d32: The Claude CLI transport now counts cache creation and cache read tokens, and the judge's token total and cost estimate include them.
- 2a4debb: A build round no longer stops to ask about a secret in a generated file. A rebuilt bundle re-adds every minified line it touches, so it matched whatever the old bundle already did, and every change that regenerated `packages/action/dist` stopped for nothing. The secret stop now skips the files the judge's review already treats as generated (`dist/`, lockfiles, source maps, and anything marked `linguist-generated` in `.gitattributes`). A secret that lands in a bundle comes from source, and source is still checked.
- 908c1f5: A card whose touches are all Markdown (a `.md` file anywhere, or a path under `docs/`) is routed on its touches, not its wording: front-end words in its title or description, and skill triggers they match, no longer score the ui sector, so such a card doesn't bring in ui or a browser proof on wording alone. A card with any other touch, or with no touches, routes as before.
- 9ac4aca: When tests pass at base but fail on the change, tier 1 re-runs only the test files the run reports as failed (vitest's `FAIL <file>` lines), one at a time and alone, with coverage off so the full run's summary stays the one the coverage floor reads. A file that passes alone is recorded in the verdict notes as flaky under load and doesn't fail `quality.tests.pass`; one that also fails alone still fails it, and the test run keeps the full run's output with each alone run's output after it. When the run also reports failures no named file accounts for (vitest's unhandled errors or `Errors` summary, type errors, or a coverage threshold miss), nothing is re-run alone and `quality.tests.pass` stays failed, with a note saying why. The whole-suite retry is kept only for a failing run that names no test files. In this repo, vitest now writes the coverage summary when a test fails, and the tests that drive real git repos run one at a time in a single fork while the rest of the suite runs in threads.
- 3578bfb: A build round no longer stops, and tier 1's `diff.no-new-suppressions` no longer fails, on a suppression-shaped line in a generated file. The runtime's own suppression pattern is bundled into `packages/action/dist/index.js`, and a rebuilt bundle re-adds every minified line it touches, so any change that regenerated the bundle looked like it added a lint or type-check suppression; T-0008 stopped on exactly that with none in its source. Both checks now skip the files the judge's review and the secret stop already treat as generated (`dist/`, lockfiles, source maps, and anything marked `linguist-generated` in `.gitattributes`). Source files are still checked.
- a4a1d70: The judge runs its checks on a protected change a person allowed as the change has it. Before, it put the file back to base, so an approved update to an existing test was judged by the old test and failed every round. Unanswered protected changes are still put back to base.
- 3bcd0a9: The router no longer counts a word in the description twice. A skill whose keyword trigger matches a word the sector already scored on adds nothing, so "iac" in a description scores infra 1, not 2, and no longer puts infra in. A skill keyword found only in the description, such as terraform-skill's "state", is keyword evidence like the sector's own keywords. A skill trigger matched by a touched path still counts as path evidence.

  A borderline sector whose whole score comes from words in the description is decided not in by the router. The route's ledger records `decided not in: <sector> (scored only on description keywords)`, and at review-at-pr such a sector no longer holds the route for a person, whether the task is routed now or resumed from its ledger. A borderline sector that also scores from a path, a title word, a skill's path trigger or the repo's infrastructure as code still holds the route. Keyword-only sectors stay in the borderline list the approver is shown. The runtime's `Routing` gains `decidedOut`.

- 42de90a: `diff.no-new-comments` no longer counts an edited comment as a new one. Within each hunk of the change, a comment block it adds is matched to one it removes at the same indentation, and each removed line covers one added line: rewording a doc comment passes, while swapping a deleted comment for an unrelated one elsewhere still fails. Before, the check failed on any added comment line, and in T-0006 the retry deleted an existing doc comment to get past it. A judge that sends a change back now also tells the agent that a tier 1 failure is fixed by changing the code that triggered it, never by deleting something that existed at base.
- a3ca4d7: `task run --parallel` treats a Windows drive path or a UNC path in a card's touches as able to name any file, so such a card waits for every other one. A leading `/` stays repo-rooted.
- ef50f7b: The packages publish to GitHub Packages (`https://npm.pkg.github.com`, restricted) and name this repo as their source, so a release's publish step reaches them and links each package to the repo.
- 1116fe3: A task ledger whose `ledger.md` differs from a fresh render while every entry's seal still holds is rendered again from `ledger.jsonl` instead of reading as tampered, the same rule the autonomy ledger already follows. `ledger.md` is a view, not part of the signed record: after the rename to Rivetari every old task's view rendered differently and every task read as TAMPERED. `rivetari task resume` says when it re-rendered a view. A changed or broken entry still fails verification.
- 9e16e95: Build rounds no longer resume the agent's previous session, which cost more than it saved. Instead, a retry round gets a shorter fresh prompt: the contract and the card, the change so far as a diff from the base (generated files and lockfiles listed by name only, capped at 32,000 characters), the operating rules and plan, and what failed. The skills and the packed repo slice aren't sent again; the worktree is there for the agent to read.
- 6e4eb52: The tier 2 review no longer crashes when the model sends a finding's `repro` (or its `file`, `detail` or `fix`, an acceptance `note`, or the false-positive gate's `repro` or `reason`) as `null`: a null or missing value means none. A suggestion with no repro is kept, a blocking finding still needs the gate to confirm a reproduction, and a rendered finding with no repro leaves the Repro line out instead of printing it empty. Before, `rivetari review --pr` exited 1 with a zod error and posted nothing.
- 328afac: From Rivetari's first task on its own repo: a build round where the agent changed nothing, on a branch that still changes nothing, stops and asks a person with what the agent said instead of going on to prove the base. The agent's rules now say it can't ask mid-round: it makes the change and the runtime asks about it. The judge force-resets its clone between the base and the change, so checks that write into tracked files (a build into a committed dist) no longer stop it switching.
- df42f33: Tier 1 no longer checks every package because a change carries a changeset or root docs: `.changeset/`, `docs/` and root Markdown don't widen the affected scope. A change made only of them still checks everything.
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

- 29f786d: The trust ladder now re-renders a stale autonomy ledger view and verifies the ledger before reading it. A ledger that fails verification, isn't valid JSON lines, or whose key can't be read leaves the repo running supervised, gets nothing appended, and is named with its problems in `rivetari metrics` and the session-start text.
- Updated dependencies [497f5bb]
- Updated dependencies [28e3957]
- Updated dependencies [4b5c8b2]
- Updated dependencies [5b3e8cf]
- Updated dependencies [28e3957]
- Updated dependencies [9db492e]
- Updated dependencies [71b0956]
- Updated dependencies [e715d32]
- Updated dependencies [28e3957]
- Updated dependencies [4b5c8b2]
- Updated dependencies [28e3957]
- Updated dependencies [ad769fc]
- Updated dependencies [53fa997]
- Updated dependencies [6e00240]
- Updated dependencies [24781e4]
- Updated dependencies [a8c3169]
- Updated dependencies [28e3957]
- Updated dependencies [87d646b]
- Updated dependencies [31821c8]
- Updated dependencies [ef50f7b]
- Updated dependencies [328afac]
- Updated dependencies [8b85843]
- Updated dependencies [eb93ad1]
- Updated dependencies [da6ad10]
- Updated dependencies [eef91ca]
- Updated dependencies [be49a10]
- Updated dependencies [ce71405]
- Updated dependencies [9d2955f]
- Updated dependencies [0a66e93]
- Updated dependencies [0a66e93]
- Updated dependencies [0a66e93]
- Updated dependencies [0a66e93]
- Updated dependencies [ad25e71]
- Updated dependencies [8b61010]
- Updated dependencies [8b61010]
- Updated dependencies [cfba43b]
- Updated dependencies [5cb919e]
- Updated dependencies [4d5e653]
- Updated dependencies [0a66e93]
  - @arynbht/rivetari-engine@2.0.0
  - @arynbht/rivetari-catalog@2.0.0
  - @arynbht/rivetari-registry@1.0.0
