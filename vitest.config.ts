import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url))
  .replace(/\\/g, "/")
  .replace(/[()[\]{}*?!+@]/g, "\\$&");
const inOneFork = (glob: string): [string, "forks"] => [
  `${root}${glob}`,
  "forks",
];

export default defineConfig({
  test: {
    // Discover *.test.ts / *.spec.ts across all workspace packages.
    include: ["packages/**/*.{test,spec}.ts", "apps/**/*.{test,spec}.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Many tests drive real git repos and child processes. Under the whole suite
    // they timed each other out on a loaded Windows machine, so they run one at a
    // time in a single fork; the rest of the suite runs in threads beside them.
    pool: "threads",
    poolMatchGlobs: [
      inOneFork("packages/runtime/src/**"),
      inOneFork("packages/engine/src/fix-pr.test.ts"),
      inOneFork("packages/engine/src/orchestrate/**"),
      inOneFork("packages/engine/src/github/token.test.ts"),
      inOneFork("packages/engine/src/detectors/exec.test.ts"),
      inOneFork("packages/cli/src/commands/**"),
      inOneFork("packages/registry/src/skills.test.ts"),
    ],
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      // On for every run, failing or not, so `pnpm test` always writes
      // coverage-summary.json (the judge's coverage floor reads it after its run).
      enabled: true,
      reportOnFailure: true,
      provider: "v8",
      reporter: ["json-summary", "text-summary"],
      include: ["packages/*/src/**/*.ts", "apps/desktop/src/**/*.{ts,tsx}"],
      exclude: ["**/*.{test,spec}.ts", "**/*.d.ts", "**/dist/**"],
      // The measured baseline (2026-11-09), rounded down. Raise these as coverage
      // grows; never lower them. A partial run (`vitest run <path>`) covers less
      // than the whole include set, so pass `--coverage.enabled=false` for one.
      thresholds: {
        statements: 52,
        branches: 77,
        functions: 75,
        lines: 52,
      },
    },
  },
});
