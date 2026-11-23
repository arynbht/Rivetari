---
"@arynbht/rivetari-runtime": patch
---

When tests pass at base but fail on the change, tier 1 re-runs only the test files the run reports as failed (vitest's `FAIL <file>` lines), one at a time and alone, with coverage off so the full run's summary stays the one the coverage floor reads. A file that passes alone is recorded in the verdict notes as flaky under load and doesn't fail `quality.tests.pass`; one that also fails alone still fails it, and the test run keeps the full run's output with each alone run's output after it. The whole-suite retry is kept only for a failing run that names no test files. In this repo, vitest now writes the coverage summary when a test fails, and the tests that drive real git repos run one at a time in a single fork while the rest of the suite runs in threads.
