# CI/CD & release



Continuous integration, caching, action pinning, versioning, and release automation.



14 control(s).



### `ci.actions-pinned-sha` — GitHub Actions pinned by commit SHA

- **phase**: harden · **severity**: medium · **effort**: medium
- **detect**: `file-yaml-path` · **fix**: workflow `pin-actions`

Pinning third-party actions to a full commit SHA, not a mutable tag, stops a compromised or retagged action from silently executing new code in CI.

References:
  - [OpenSSF Scorecard](https://github.com/ossf/scorecard/blob/main/docs/checks.md) — Pinned-Dependencies
  - [GitHub Docs — Security hardening for GitHub Actions](https://docs.github.com/actions/security-guides/security-hardening-for-github-actions#using-third-party-actions)

### `ci.changelog-automated` — Versioning and changelog automated

- **phase**: build · **severity**: low · **effort**: small
- **detect**: `file-exists` · **fix**: template `changesets`

Automated versioning and changelogs make releases repeatable and give users an accurate record of what changed, instead of hand-maintained notes that drift.

References:
  - [semantic-release](https://semantic-release.gitbook.io/semantic-release/)
  - [Changesets](https://github.com/changesets/changesets)

### `ci.concurrency` — CI cancels superseded runs

- **phase**: build · **severity**: low · **effort**: small
- **detect**: `any-of` · **fix**: merge-yaml `.github/workflows/ci.yml`

A concurrency group cancels superseded in-progress runs on the same ref, saving runner minutes and giving faster feedback on the latest commit.

References:
  - [GitHub Docs — Using concurrency](https://docs.github.com/actions/using-jobs/using-concurrency)

### `ci.concurrency-pr-only` — CI cancels superseded PR runs, and only those

- **phase**: build · **severity**: low · **effort**: small
- **detect**: `workflow` · **fix**: workflow `concurrency-pr-only`

A new push to a pull request makes its running CI worthless, so cancelling it saves minutes and gets the answer for the latest commit sooner. A run on the default branch is the record of a merge, so it must never be cancelled or replaced by the next merge's run.

References:
  - [GitHub Docs — Control the concurrency of workflows and jobs](https://docs.github.com/actions/writing-workflows/choosing-what-your-workflow-does/control-the-concurrency-of-workflows-and-jobs)

### `ci.dependency-caching` — CI caches dependencies

- **phase**: build · **severity**: low · **effort**: small
- **detect**: `any-of` · **fix**: merge-yaml `.github/workflows/ci.yml`

Caching dependencies cuts CI time and cost and reduces load on upstream registries, keeping the feedback loop fast as the project grows.

References:
  - [GitHub Docs — Caching dependencies to speed up workflows](https://docs.github.com/actions/using-workflows/caching-dependencies-to-speed-up-workflows)

### `ci.docs-skip-build` — Docs-only PRs skip build and test

- **phase**: build · **severity**: low · **effort**: small
- **detect**: `workflow` · **fix**: workflow `docs-path-filter`

A typo fix in the docs doesn't need a full build and test run. Filtering jobs by the paths a PR changes, rather than skipping the whole workflow, keeps the required check reporting so the PR can still merge.

References:
  - [dorny/paths-filter](https://github.com/dorny/paths-filter)
  - [GitHub Docs — Handling skipped but required checks](https://docs.github.com/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/troubleshooting-required-status-checks#handling-skipped-but-required-checks)

### `ci.job-timeouts` — Every CI job has a timeout

- **phase**: build · **severity**: medium · **effort**: small
- **detect**: `workflow` · **fix**: workflow `job-timeouts`

A job with no timeout runs for up to six hours when a step hangs, burning minutes and holding the PR's required check pending. A timeout near the job's real duration turns a hang into a fast, visible failure.

References:
  - [GitHub Docs — Workflow syntax (jobs.<job_id>.timeout-minutes)](https://docs.github.com/actions/writing-workflows/workflow-syntax-for-github-actions#jobsjob_idtimeout-minutes)

### `ci.pr-linux-only` — Windows and macOS stay off PRs on private repos

- **phase**: build · **severity**: low · **effort**: small
- **detect**: `workflow` · **fix**: workflow `pr-os-matrix`

On a private repo, Windows minutes count double and macOS minutes ten times, so a free plan's allowance runs out quickly when every PR runs them. Linux on pull requests and the full OS matrix on the default branch still catch an OS-specific break, one merge later.

References:
  - [GitHub Docs — About billing for GitHub Actions (minute multipliers)](https://docs.github.com/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions)

### `ci.required-aggregator` — One required `ci` check gates every PR job

- **phase**: build · **severity**: medium · **effort**: small
- **detect**: `workflow` · **fix**: workflow `required-aggregator`

Branch protection requires checks by name. One `ci` job that waits for every other job and fails when any of them failed is the only check to require, so jobs can be added, split or skipped by path without editing the ruleset, and a skipped job never leaves a required check pending.

References:
  - [GitHub Docs — About protected branches (required status checks)](https://docs.github.com/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-status-checks-before-merging)
  - [GitHub Docs — Using conditions to control job execution](https://docs.github.com/actions/using-jobs/using-conditions-to-control-job-execution)

### `ci.runs-on-pr` — CI runs on pull requests

- **phase**: scaffold · **severity**: high · **effort**: small
- **detect**: `file-yaml-path` · **fix**: —

Running CI on pull requests is what lets required checks block a merge; a workflow that only runs on push cannot gate incoming changes.

References:
  - [GitHub Docs — Events that trigger workflows (pull_request)](https://docs.github.com/actions/using-workflows/events-that-trigger-workflows#pull_request)

### `ci.runs-on-push` — CI runs on push

- **phase**: scaffold · **severity**: medium · **effort**: small
- **detect**: `file-yaml-path` · **fix**: —

A push trigger keeps the mainline continuously verified, catching breakage introduced by merges. (This heuristic detects any push trigger; confirming it targets the default branch specifically is left to a future structured check.)

References:
  - [GitHub Docs — Events that trigger workflows (push)](https://docs.github.com/actions/using-workflows/events-that-trigger-workflows#push)

### `ci.secret-scan-on-pr` — CI scans each PR's commits for secrets

- **phase**: harden · **severity**: medium · **effort**: small
- **detect**: `workflow` · **fix**: workflow `secret-scan-on-pr`

A secret scan that runs on the pull request reads every commit in it, so a key committed and then deleted in a later commit is still caught before it reaches the default branch's history.

References:
  - [TruffleHog — GitHub Action](https://github.com/trufflesecurity/trufflehog#octocat-trufflehog-github-action)
  - [gitleaks — GitHub Action](https://github.com/gitleaks/gitleaks-action)

### `ci.workflow-permissions` — Workflow token permissions declared

- **phase**: harden · **severity**: medium · **effort**: small
- **detect**: `file-yaml-path`, `file-yaml-path` · **fix**: merge-yaml `.github/workflows/ci.yml`

An explicit permissions block scopes the workflow's GITHUB_TOKEN to least privilege, limiting the blast radius if a step or dependency is compromised.

References:
  - [OpenSSF Scorecard](https://github.com/ossf/scorecard/blob/main/docs/checks.md) — Token-Permissions

### `ci.workflow.present` — CI workflow present

- **phase**: scaffold · **severity**: high · **effort**: small
- **detect**: `file-exists` · **fix**: template `ci-workflow`

A CI workflow is the foundation for every automated gate; without one, nothing (tests, lint, security scans) is enforced on changes.

References:
  - [DORA — Continuous integration](https://dora.dev/capabilities/continuous-integration/)


