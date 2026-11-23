---
"@arynbht/factory-runtime": minor
---

Tier 1 no longer fails a round on a test file that only fails under the full suite's load. When tests pass at base but fail on the change, the judge names the failing files from vitest's output and runs each one again, alone and one at a time, with coverage off so the full run's coverage summary stays the one the floor reads. A file that passes alone is recorded in the verdict notes as flaky under load and doesn't fail `quality.tests.pass`; one that fails alone too is a real failure, and the full run's output is kept with each re-run appended. A run with unhandled errors, a missed coverage threshold, or more failed files than it names isn't cleared this way. The whole-suite retry is kept only for output that names no file. In this repo, the tests that drive real git repos run one at a time in their own worker pool, and vitest writes the coverage summary even when a test fails.
