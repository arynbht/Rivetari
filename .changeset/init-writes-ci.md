---
"@arynbht/rivetari": minor
---

`rivetari init` writes `.github/workflows/ci.yml` into a Node repo that has no CI of its own, shaped after Rivetari's fast pipeline. A PR gets one Linux job, `ci`, to make the required check. Draft PRs and docs-only changes skip the work but still report, a newer push cancels the run before it, and every job has a timeout. In a pnpm workspace, root scripts that run in every package (`pnpm -r test`) run only in the packages a PR affects, and a change outside every package checks everything. The steps come from the repo's own package manager and its lint, typecheck, test and build scripts. The default branch runs everything on Linux. Windows runs nightly for a private repo on the free plan, or one whose plan can't be read (offline, or no token). A public repo or a paid plan, read from the GitHub API, gets Windows and macOS on every push. A repo with other workflows keeps them and gets no `ci.yml`.
