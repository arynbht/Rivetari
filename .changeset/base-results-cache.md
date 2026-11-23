---
"@arynbht/factory-runtime": minor
---

Tier 1 runs the base's checks once per base commit. A check that's green (or n/a) at a base is kept, keyed by the base commit, the checks, the installed dependencies and the env the checks see, and every later round and task on that base reuses it. A check that's red at base is never kept, since it may be a flake and a cached one would mark the change's real failures as pre-existing; it runs again every time. Coverage is read from the same side's test run, so when coverage has to run again, so do the tests.
