import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import picomatch from "picomatch";
import { simpleGit } from "simple-git";
import { z } from "zod";

import type { CheckOutcome } from "./outcome.js";

export const BANNED_PATH = ".rivetari/banned.json";

const validRegex = (source: string) => {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
};

export const BannedPatternSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  pattern: z
    .string()
    .min(1)
    .refine(validRegex, "not a valid regular expression"),
  files: z.string().min(1).default("**/*"),
  allow: z.array(z.string().min(1)).default([]),
  why: z.string().min(1),
  source: z.string().min(1),
  covered_by: z.string().min(1).optional(),
});
export type BannedPattern = z.infer<typeof BannedPatternSchema>;

export const BannedListSchema = z.strictObject({
  version: z.literal(1),
  patterns: z.array(BannedPatternSchema).default([]),
});
export type BannedList = z.infer<typeof BannedListSchema>;

const JS = "**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}";

export const STACK_DEFAULTS: Record<string, BannedPattern[]> = {
  node: [
    {
      id: "no-eval",
      pattern: String.raw`(?<![\w.$])eval\s*\(`,
      files: JS,
      allow: [],
      why: "eval runs a string as code; parse the data or look it up instead",
      source: "stack default: node",
    },
    {
      id: "no-new-function",
      pattern: String.raw`\bnew\s+Function\s*\(`,
      files: JS,
      allow: [],
      why: "new Function is eval by another name",
      source: "stack default: node",
    },
    {
      id: "no-debugger",
      pattern: String.raw`^\s*debugger\s*;?\s*$`,
      files: JS,
      allow: [],
      why: "a debugger statement left in stops every run under an inspector",
      source: "stack default: node",
    },
    {
      id: "no-inner-html",
      pattern: String.raw`\bdangerouslySetInnerHTML\b|\.innerHTML\s*=`,
      files: JS,
      allow: [],
      why: "raw HTML from a string is an injection path; render elements, or sanitise in one shared place",
      source: "stack default: node",
    },
  ],
  python: [
    {
      id: "no-eval",
      pattern: String.raw`(?<![\w.])eval\s*\(`,
      files: "**/*.py",
      allow: [],
      why: "eval runs a string as code; parse the data instead",
      source: "stack default: python",
    },
    {
      id: "no-exec",
      pattern: String.raw`(?<![\w.])exec\s*\(`,
      files: "**/*.py",
      allow: [],
      why: "exec runs a string as code",
      source: "stack default: python",
    },
    {
      id: "no-pickle-load",
      pattern: String.raw`\bpickle\.loads?\s*\(`,
      files: "**/*.py",
      allow: [],
      why: "unpickling untrusted bytes runs code; use JSON or a schema",
      source: "stack default: python",
    },
    {
      id: "no-shell-true",
      pattern: String.raw`\bshell\s*=\s*True\b`,
      files: "**/*.py",
      allow: [],
      why: "shell=True hands the command line to a shell; pass an argument list",
      source: "stack default: python",
    },
    {
      id: "no-breakpoint",
      pattern: String.raw`^\s*breakpoint\s*\(\s*\)`,
      files: "**/*.py",
      allow: [],
      why: "a breakpoint() left in stops every run",
      source: "stack default: python",
    },
  ],
};

export function defaultsFor(stacks: readonly string[]): BannedPattern[] {
  const out: BannedPattern[] = [];
  for (const stack of stacks)
    for (const p of STACK_DEFAULTS[stack === "typescript" ? "node" : stack] ??
      [])
      if (!out.some((o) => o.id === p.id && o.files === p.files)) out.push(p);
  return out;
}

export async function loadBanned(
  repoPath: string,
  rev?: string,
): Promise<BannedList> {
  const text = rev
    ? await simpleGit(repoPath)
        .show([`${rev}:${BANNED_PATH}`])
        .catch(() => null)
    : await readFile(join(repoPath, BANNED_PATH), "utf8").catch(() => null);
  if (text === null) return { version: 1, patterns: [] };
  return BannedListSchema.parse(JSON.parse(text));
}

export async function saveBanned(
  repoPath: string,
  list: BannedList,
): Promise<void> {
  const path = join(repoPath, BANNED_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(BannedListSchema.parse(list), null, 2)}\n`,
    "utf8",
  );
}

export function addBanned(
  list: BannedList,
  entry: BannedPattern,
): { list: BannedList; added: boolean } {
  if (list.patterns.some((p) => p.id === entry.id))
    return { list, added: false };
  return {
    list: { ...list, patterns: [...list.patterns, entry] },
    added: true,
  };
}

export function bannedHits(
  list: BannedList,
  added: ReadonlyMap<string, string[]>,
): string[] {
  const hits: string[] = [];
  for (const p of list.patterns) {
    const inScope = picomatch(p.files, { dot: true });
    const allowed = picomatch(p.allow.length > 0 ? p.allow : ["\0"], {
      dot: true,
    });
    const re = new RegExp(p.pattern);
    for (const [path, lines] of added) {
      if (!inScope(path) || allowed(path)) continue;
      for (const line of lines)
        if (re.test(line))
          hits.push(`${p.id}: ${path}: ${line.trim().slice(0, 80)}`);
    }
  }
  return hits;
}

export const BANNED_CHECK = {
  id: "diff.no-banned-patterns",
  title: "The change adds nothing the repo has banned",
} as const;

export function bannedCheck(
  list: BannedList,
  added: ReadonlyMap<string, string[]>,
): CheckOutcome {
  if (list.patterns.length === 0)
    return {
      ...BANNED_CHECK,
      base: "n/a",
      head: "n/a",
      outcome: "n/a",
      message: `no banned patterns (${BANNED_PATH})`,
    };
  const hits = bannedHits(list, added);
  return {
    ...BANNED_CHECK,
    base: "n/a",
    head: hits.length > 0 ? "red" : "green",
    outcome: hits.length > 0 ? "fail" : "pass",
    message:
      hits.length > 0
        ? `banned patterns: ${hits.slice(0, 5).join("; ")}${hits.length > 5 ? `; and ${hits.length - 5} more` : ""}`
        : "",
  };
}

export function bannedSection(list: BannedList): string[] {
  if (list.patterns.length === 0) return [];
  return [
    `## Banned patterns (the repo's own rules)\nA change that adds one of these breaks the repo's contract: report it as a "contract" finding.\n${list.patterns.map((p) => `- ${p.id}: /${p.pattern}/ in ${p.files}${p.allow.length > 0 ? ` (allowed in ${p.allow.join(", ")})` : ""}: ${p.why}`).join("\n")}`,
  ];
}
