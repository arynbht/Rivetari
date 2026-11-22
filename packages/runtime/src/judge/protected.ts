import picomatch from "picomatch";
import type { SimpleGit } from "simple-git";

/** One file in the diff between the base commit and the change under review. */
export interface DiffEntry {
  /** A added, M modified, D deleted, R renamed (path is the new name). */
  status: "A" | "M" | "D" | "R";
  path: string;
  /** For renames: the path at base. */
  oldPath?: string | undefined;
}

export type ProtectedReason =
  | "factory-state"
  | "skill-registry"
  | "agent-config"
  | "lint-config"
  | "ci-config"
  | "scripts"
  | "existing-test"
  | "suppression";

export interface ProtectedFinding {
  reason: ProtectedReason;
  path: string;
  detail: string;
}

/** The judge's own record of what counts as a protected path. */
export const PROTECTED = {
  factoryState: [".factory/**"],
  // Which skills an agent loads, at which pins, with which reviewed scan
  // exceptions: a human's call, never the agent's.
  skillRegistry: [
    ".factory/skills.lock",
    ".factory/skills/**",
    "packages/registry/manifests/**",
  ],
  // Agent harness settings: hooks configured here run code on their own.
  agentConfig: [
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".codex/**",
    ".cursor/hooks.json",
    ".cursor/rules/**",
    ".gemini/settings.json",
    ".github/hooks/**",
  ],
  lintConfig: [
    "**/eslint.config.*",
    "**/.eslintrc*",
    "**/.prettierrc*",
    "**/prettier.config.*",
    "**/biome.json",
    "**/biome.jsonc",
    "**/ruff.toml",
    "**/.ruff.toml",
    "**/.flake8",
    "**/.pylintrc",
    "**/mypy.ini",
    "**/.golangci.*",
    "**/clippy.toml",
    "**/.clippy.toml",
    "**/rustfmt.toml",
    "**/tsconfig*.json",
    "**/.editorconfig",
  ],
  ciConfig: [
    ".github/workflows/**",
    ".github/actions/**",
    "lefthook.yml",
    "lefthook.yaml",
    ".lefthook.yml",
    ".pre-commit-config.yaml",
    ".husky/**",
    "commitlint.config.*",
  ],
  tests: [
    "**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs,mts,cts}",
    "**/test_*.py",
    "**/*_test.py",
    "**/conftest.py",
    "**/*_test.go",
    "**/tests/**",
    "**/test/**",
    "**/__tests__/**",
    "**/e2e/**",
  ],
} as const;

/** Lines that switch a check off for the code next to them. */
export const SUPPRESSION =
  /(eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck|#\s*noqa|#\s*type:\s*ignore|\/\/\s*nolint|#\s*pragma:\s*no cover|#!?\[allow\(|biome-ignore)/;

// Wrapped so a matcher passed to `.some()` never receives the array index as
// picomatch's `returnObject` argument.
const matcher = (globs: readonly string[]): ((path: string) => boolean) => {
  const isMatch = picomatch([...globs], { dot: true });
  return (path) => isMatch(path);
};
const isFactoryState = matcher(PROTECTED.factoryState);
const isSkillRegistry = matcher(PROTECTED.skillRegistry);
const isAgentConfig = matcher(PROTECTED.agentConfig);
const isLintConfig = matcher(PROTECTED.lintConfig);
const isCiConfig = matcher(PROTECTED.ciConfig);
export const isTestFile = matcher(PROTECTED.tests);

/** Machine-written files: reviewing them wastes the budget and finds nothing. */
const GENERATED = picomatch(
  [
    "**/dist/**",
    "**/*.min.js",
    "**/*.map",
    "**/pnpm-lock.yaml",
    "**/package-lock.json",
    "**/yarn.lock",
    "**/bun.lock",
    "**/bun.lockb",
    "**/Cargo.lock",
    "**/poetry.lock",
    "**/uv.lock",
    "**/go.sum",
  ],
  { dot: true },
);

export const isGeneratedPath = (path: string): boolean => GENERATED(path);

/**
 * Which of `paths` are machine-written: the paths above, plus the files the
 * repo marks as generated (`linguist-generated` in .gitattributes).
 */
export async function generatedPaths(
  git: SimpleGit,
  paths: readonly string[],
): Promise<Set<string>> {
  const generated = new Set(paths.filter((p) => GENERATED(p)));
  if (paths.length === 0) return generated;
  const attrs = await git
    .raw(["check-attr", "linguist-generated", "--", ...paths])
    .catch(() => "");
  for (const line of attrs.split("\n")) {
    const m = /^(.*): linguist-generated: (set|true)$/.exec(line.trim());
    if (m?.[1]) generated.add(m[1]);
  }
  return generated;
}

/**
 * How a protected change is asked about, at build and in the judge: the same
 * text in both, so a person who allowed it at build isn't asked again.
 */
export const protectedDetail = (f: ProtectedFinding) =>
  `${f.path} — ${f.detail}`;

/**
 * Changes the agent must not make on its own: anything here marks the result
 * `needs-human`. Added test files are fine (they're how a change proves itself);
 * changing or deleting a test that existed at base is not.
 *
 * `addedLines` maps a path to the lines the change adds (from a zero-context
 * diff); `scriptsChanged` says whether package.json `scripts` differ from base.
 * Added lines in `generated` paths aren't searched for suppressions: a rebuilt
 * bundle re-adds every minified line it touches, and the runtime's own
 * suppression pattern is bundled into it. A suppression there came from
 * source, which is still searched.
 */
export function findProtected(
  diff: readonly DiffEntry[],
  addedLines: ReadonlyMap<string, readonly string[]>,
  scriptsChanged: boolean,
  generated: ReadonlySet<string> = new Set(),
): ProtectedFinding[] {
  const findings: ProtectedFinding[] = [];
  for (const entry of diff) {
    const paths = [entry.path, entry.oldPath].filter(
      (p): p is string => p !== undefined,
    );
    if (paths.some(isSkillRegistry)) {
      findings.push({
        reason: "skill-registry",
        path: entry.path,
        detail:
          "changes the skill registry (lock, manifests, scan allows): which prompts agents load is a human decision",
      });
    } else if (paths.some(isAgentConfig)) {
      findings.push({
        reason: "agent-config",
        path: entry.path,
        detail:
          "changes agent harness settings, where hooks run code automatically",
      });
    } else if (paths.some(isFactoryState)) {
      findings.push({
        reason: "factory-state",
        path: entry.path,
        detail:
          "changes factory state (.factory/**): waivers, evidence and profile are human decisions",
      });
    } else if (paths.some(isLintConfig)) {
      findings.push({
        reason: "lint-config",
        path: entry.path,
        detail: "changes lint, format or type-check configuration",
      });
    } else if (paths.some(isCiConfig)) {
      findings.push({
        reason: "ci-config",
        path: entry.path,
        detail: "changes CI or git hook configuration",
      });
    } else if (entry.status !== "A" && paths.some(isTestFile)) {
      findings.push({
        reason: "existing-test",
        path: entry.path,
        detail:
          entry.status === "D"
            ? "deletes a test that existed at base"
            : "modifies a test that existed at base",
      });
    }
  }

  if (scriptsChanged) {
    findings.push({
      reason: "scripts",
      path: "package.json",
      detail: "changes package.json scripts (the commands the checks run)",
    });
  }

  for (const [path, lines] of addedLines) {
    if (generated.has(path)) continue;
    const hit = lines.find((line) => SUPPRESSION.test(line));
    if (hit) {
      findings.push({
        reason: "suppression",
        path,
        detail: `adds a check suppression: ${hit.trim().slice(0, 120)}`,
      });
    }
  }
  return findings;
}

/** `.factory/**`, lint or CI config: always judged as it was at base. */
export function isProtectedConfig(path: string): boolean {
  return (
    isFactoryState(path) ||
    isSkillRegistry(path) ||
    isAgentConfig(path) ||
    isLintConfig(path) ||
    isCiConfig(path)
  );
}
