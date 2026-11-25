// A test proves a change only if it fails without it. For fix and feature
// cards, tier 1 runs the change's new tests against the base commit: a test
// file that passes there too proves nothing about the change, and the
// criterion it backs is unverified, for a person. Refactor and chore cards
// change no behaviour a test should catch, so they're exempt, and the round
// says so.
import { allowlistedEnv, runTool, splitArgs } from "@arynbht/rivetari-engine";

import type { Card } from "../task/card.js";
import { type DiffEntry, isTestFile } from "./protected.js";

/** Card types whose new tests must fail on the base. */
export const MUST_PROVE: readonly Card["type"][] = ["fix", "feature"];

export interface BaseTestFile {
  file: string;
  /** How the file did on the base with the change's version of it. */
  onBase: "pass" | "fail" | "not run";
  command: string;
}

export interface BaseTests {
  /**
   * ran: each new test file ran on the base; exempt: the card's type doesn't
   * have to; not run: it had to and couldn't; none: no new test file.
   */
  status: "ran" | "exempt" | "not run" | "none";
  note: string;
  files: BaseTestFile[];
}

/**
 * The change's test files whose new version tier 1 ran: added ones, and
 * changed ones a person allowed (any other change to an existing test is
 * put back to base, and asked about).
 */
export function changedTests(
  diff: readonly DiffEntry[],
  kept: ReadonlySet<string>,
): string[] {
  return diff
    .filter(
      (e) =>
        e.status !== "D" &&
        isTestFile(e.path) &&
        (e.status === "A" || kept.has(e.path)),
    )
    .map((e) => e.path);
}

export type TestRunner = "vitest" | "jest" | "pytest";

/** The runner a test command ends in, from the line and the script it runs. */
export function testRunner(
  command: string,
  script: unknown,
): TestRunner | null {
  if (/^\s*(?:python\d*\s+-m\s+)?pytest\b/.test(command)) return "pytest";
  const text = `${command} ${typeof script === "string" ? script : ""}`;
  if (/\bvitest\b/.test(text)) return "vitest";
  if (/\bjest\b/.test(text)) return "jest";
  return null;
}

/** The command that runs one test file alone, coverage off. */
export function aloneCommand(
  command: string,
  file: string,
  runner: TestRunner,
): string[] {
  if (runner === "pytest") {
    const [binary = "pytest", ...args] = splitArgs(command);
    return [binary, ...args, file];
  }
  // A scoped run passes its packages after `--`; the file alone replaces them.
  const all = splitArgs(command);
  const cut = all.indexOf("--");
  const args = cut === -1 ? all : all.slice(0, cut);
  const off =
    runner === "vitest" ? "--coverage.enabled=false" : "--coverage=false";
  return [...args, "--", file, off];
}

/**
 * Run each file alone in `dir`, which holds the base with the change's
 * versions of the files. A run that can't start counts as a failure: it
 * didn't show the test passes without the change.
 */
export async function runOnBase(options: {
  dir: string;
  files: readonly string[];
  command: string;
  runner: TestRunner;
  timeoutS: number;
  env?: readonly string[] | undefined;
  log?: ((line: string) => void) | undefined;
}): Promise<BaseTestFile[]> {
  const out: BaseTestFile[] = [];
  for (const file of options.files) {
    const [binary, ...argv] = aloneCommand(
      options.command,
      file,
      options.runner,
    );
    const command = [binary, ...argv].join(" ");
    options.log?.(`running ${file} on the base: ${command}`);
    let passed = false;
    try {
      if (binary)
        passed =
          (
            await runTool(binary, argv, options.dir, {
              timeoutMs: options.timeoutS * 1000,
              env: allowlistedEnv(options.env),
            })
          ).exitCode === 0;
    } catch {
      passed = false;
    }
    out.push({ file, onBase: passed ? "pass" : "fail", command });
  }
  return out;
}

/** The files that passed on the base: they prove nothing about the change. */
export function provedNothing(tests: BaseTests | undefined): string[] {
  return (tests?.files ?? [])
    .filter((f) => f.onBase === "pass")
    .map((f) => f.file);
}

const base = (path: string) => path.split("/").pop() ?? path;

/** Whether a criterion names a test file, by path or file name. */
const names = (text: string, file: string) =>
  text.includes(file) || text.includes(base(file));

/**
 * The criteria each file backs: those that name it; for a file no criterion
 * names, the unit and e2e criteria that name no test file of the change.
 */
export function backedCriteria(
  card: Pick<Card, "acceptance">,
  files: readonly string[],
  all: readonly string[] = files,
): Map<string, string[]> {
  const backed = new Map<string, string[]>();
  const add = (id: string, file: string) =>
    backed.set(id, [...(backed.get(id) ?? []), file]);
  for (const file of files) {
    const naming = card.acceptance.filter((a) => names(a.text, file));
    const by =
      naming.length > 0
        ? naming
        : card.acceptance.filter(
            (a) =>
              (a.verify === "unit" || a.verify === "e2e") &&
              !all.some((f) => names(a.text, f)),
          );
    for (const a of by) add(a.id, file);
  }
  return backed;
}

/**
 * The review's acceptance with every criterion a proved-nothing test backs
 * made unverified: a test that passes without the change shows nothing is
 * done. A criterion already unmet stays unmet. When the tests had to run on
 * the base and couldn't, the criteria they back are unverified too.
 */
export function applyBaseTests<
  A extends {
    id: string;
    status: "met" | "unmet" | "unverified";
    note: string;
  },
>(
  acceptance: readonly A[],
  card: Pick<Card, "acceptance">,
  tests: BaseTests | undefined,
): A[] {
  if (!tests || (tests.status !== "ran" && tests.status !== "not run"))
    return [...acceptance];
  const all = tests.files.map((f) => f.file);
  const flagged = tests.status === "ran" ? provedNothing(tests) : all;
  if (flagged.length === 0) return [...acceptance];
  const backed = backedCriteria(card, flagged, all);
  const why = (files: string[]) =>
    tests.status === "ran"
      ? `${files.join(", ")} pass${files.length === 1 ? "es" : ""} on the base too, so ${files.length === 1 ? "it proves" : "they prove"} nothing about this change`
      : `${files.join(", ")} couldn't be run on the base (${tests.note}), so nothing shows ${files.length === 1 ? "it fails" : "they fail"} without this change`;
  const out = acceptance.map((a) => {
    const files = backed.get(a.id);
    if (!files || a.status === "unmet") return a;
    return { ...a, status: "unverified" as const, note: why(files) };
  });
  for (const [id, files] of backed)
    if (!out.some((a) => a.id === id))
      out.push({ id, status: "unverified", note: why(files) } as A);
  return out;
}

/** What the reviewer is told about the change's tests on the base. */
export function baseTestsSection(tests: BaseTests | undefined): string[] {
  if (!tests || tests.status === "none") return [];
  if (tests.status !== "ran")
    return [`## The change's tests on the base\n${tests.note}`];
  const lines = tests.files.map(
    (f) =>
      `- ${f.file}: ${f.onBase === "pass" ? "passes on the base too: it proves nothing about this change" : f.onBase === "fail" ? "fails on the base, passes on the change" : "not run on the base"}`,
  );
  return [
    `## The change's tests on the base\nTier 1 ran each new test file alone on the base commit. A test that passes there doesn't show the change does anything; a criterion it backs is unverified, not met.\n${lines.join("\n")}`,
  ];
}
