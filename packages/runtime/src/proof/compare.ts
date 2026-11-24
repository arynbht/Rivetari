// What the UI proof compares: whether a change can show on a page at all,
// which axe violations the base already had, and which before/after images
// came out byte for byte the same.
import { readFile } from "node:fs/promises";

import picomatch from "picomatch";

import { isTestFile } from "../judge/protected.js";
import type { AxeViolation, Shot } from "./shoot.js";

// Files that can't change what a page renders. Anything not listed counts as
// UI, so an unfamiliar file still gets screenshots: skipping is the
// exception, never the default. Markdown counts only at the root, in docs/
// or as a README: under content/ or pages/ it may be what the app renders.
const NOT_UI = picomatch(
  [
    "*.{md,txt,rst,adoc}",
    "docs/**/*.{md,txt,rst,adoc}",
    "**/{README,CHANGELOG,CONTRIBUTING}*.{md,txt,rst,adoc}",
    "**/{LICENSE,LICENCE,NOTICE,CODEOWNERS,AUTHORS}",
    "**/{LICENSE,LICENCE,NOTICE}.*",
    ".rivetari/**",
    ".changeset/**",
    ".github/**",
    ".claude/**",
    ".codex/**",
    ".cursor/**",
    ".vscode/**",
    "**/.gitignore",
    "**/.gitattributes",
    "**/.editorconfig",
    "**/.prettierignore",
    "**/.prettierrc*",
    "**/prettier.config.*",
    "**/.eslintrc*",
    "**/eslint.config.*",
    "**/Dockerfile",
    "**/Dockerfile.*",
    "**/*.dockerfile",
    "**/.dockerignore",
    "**/docker-compose*.{yml,yaml}",
    "**/compose*.{yml,yaml}",
  ],
  { dot: true },
);

/**
 * The changed files that could change a rendered page: everything but docs,
 * tests, and repo or container tooling. None means screenshots would only
 * show the same pages twice.
 */
export function uiFiles(paths: readonly string[]): string[] {
  return paths.filter((p) => !NOT_UI(p) && !isTestFile(p));
}

/** A violation as one line: id, page, impact, the most nodes, and the widths. */
export function violationList(found: readonly AxeViolation[]): string {
  const groups = new Map<string, AxeViolation[]>();
  for (const v of found) {
    const key = `${v.id}\u0000${v.page}`;
    groups.set(key, [...(groups.get(key) ?? []), v]);
  }
  return [...groups.values()]
    .map((vs) => {
      const v = vs[0]!;
      const widths = [
        ...new Set(vs.map((x) => x.breakpoint).filter(Boolean)),
      ].join("/");
      const nodes = Math.max(...vs.map((x) => x.nodes));
      return `${v.id} on ${v.page} (${v.impact}, ${nodes})${widths ? ` at ${widths}` : ""}`;
    })
    .join("; ");
}

/** How many distinct rules and pages a list of violations covers. */
export const violationCount = (found: readonly AxeViolation[]): number =>
  new Set(found.map((v) => `${v.id}\u0000${v.page}`)).size;

/**
 * Split the change's violations into new ones and ones the base already had
 * on the same page at the same width with at least as many nodes. A page the
 * base couldn't show has no base violations, so everything on it is new.
 */
export function compareViolations(
  before: readonly AxeViolation[],
  after: readonly AxeViolation[],
): { added: AxeViolation[]; preExisting: AxeViolation[] } {
  const key = (v: AxeViolation) =>
    `${v.id}\u0000${v.page}\u0000${v.breakpoint ?? ""}`;
  const base = new Map(before.map((v) => [key(v), v.nodes]));
  const added: AxeViolation[] = [];
  const preExisting: AxeViolation[] = [];
  for (const v of after) {
    const had = base.get(key(v));
    if (had !== undefined && had >= v.nodes) preExisting.push(v);
    else added.push(v);
  }
  return { added, preExisting };
}

/**
 * The page and breakpoint of every before/after pair whose images are byte
 * for byte the same, both rendered: for a change to UI files that's either a
 * change these pages don't show, or shots that aren't of the change.
 */
export async function identicalPairs(
  shots: readonly (Shot & { side: "before" | "after" })[],
): Promise<{ page: string; breakpoint: string }[]> {
  const out: { page: string; breakpoint: string }[] = [];
  for (const after of shots.filter(
    (s) => s.side === "after" && s.ready !== false,
  )) {
    const before = shots.find(
      (s) =>
        s.side === "before" &&
        s.page === after.page &&
        s.breakpoint === after.breakpoint &&
        s.ready !== false,
    );
    if (!before) continue;
    if (
      before.bytes !== undefined &&
      after.bytes !== undefined &&
      before.bytes !== after.bytes
    )
      continue;
    const [a, b] = await Promise.all([
      readFile(before.file).catch(() => null),
      readFile(after.file).catch(() => null),
    ]);
    if (a && b && a.equals(b))
      out.push({ page: after.page, breakpoint: after.breakpoint });
  }
  return out;
}
