---
"@arynbht/rivetari-engine": patch
---

A private repo on GitHub's free plan no longer fails or skips the branch-protection controls it can't satisfy. GitHub answers the protection and rules endpoints there with a 403 asking to upgrade to Pro or make the repo public, so `repo.branch-protection`, `quality.required-checks.named` and `dev.code-review-required` now report n/a with that reason. Detectors gain an `n/a` status, and a control whose detectors are all n/a is n/a. Public repos, paid plans and every other 403 or error are handled as before.
