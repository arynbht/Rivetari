---
"@arynbht/rivetari-runtime": minor
"@arynbht/rivetari": patch
---

A card's risk is now derived, not declared. Intake derives it from the card's touches (globs are expanded to the tracked files they match) and writes the reasons to the ledger. High signals are signing and key handling, leases, the autonomy ledger, auth, billing and payments paths, migrations and schemas, infrastructure as code, and secrets handling. Medium signals are CI and workflow config, dependency manifests and lockfiles, lint and tsconfig config, and the repo's sensitive list (the assembly's stop-and-ask touches). Everything else is low, however many files it touches. `--risk` can raise the derived risk but never lowers it. The judge derives the risk again from the actual diff: the changed files, lease, signing or key code in the changed lines, and edits to existing tests the card doesn't name. When that is higher than the card's risk, the higher one counts: the fast-path review goes by it, the ledger records the raise and why, and the PR body shows the raised risk and the reasons.
