---
"@arynbht/factory-runtime": minor
"@arynbht/factory": patch
---

The task judge and `factory judge` keep one prepared workspace per repo in the user's cache (`~/.cache/factory/judge`, or `FACTORY_JUDGE_CACHE`) instead of cloning and installing from scratch every round. Each round checks out the commit with `--force` and cleans everything but `node_modules`; dependencies are reinstalled only when a hash of the lockfile, the package manifests, the package manager's version and the platform changes, or the change itself touches a lockfile or manifest. A second judge on the same repo while one is running falls back to a fresh clone of its own. A manifest change in a workspace package (not only the root `package.json`) now also triggers the install at head.
