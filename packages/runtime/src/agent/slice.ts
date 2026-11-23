import { posix } from "node:path";

import { buildContext } from "@arynbht/rivetari-engine";

import { sourceTouches } from "../judge/fast-path.js";
import { isGeneratedPath } from "../judge/tier2.js";
import type { Card } from "../task/card.js";

const CODE = /\.(?:[cm]?[jt]sx?)$/i;
const TEST = /(?:\.(?:test|spec)\.|(?:^|\/)__tests__\/)/;
const IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"'\n]+)["']/g;
const EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];
const JS_TO_TS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

export const isTestPath = (path: string): boolean => TEST.test(path);

export const escapeGlob = (path: string): string =>
  path.replace(/[\\*?[\]{}()!+@]/g, "\\$&");

export function relativeImports(source: string): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(IMPORT)) {
    const spec = m[1];
    if (spec?.startsWith("./") || spec?.startsWith("../")) found.add(spec);
  }
  return [...found];
}

function candidates(from: string, spec: string): string[] {
  const target = posix.normalize(posix.join(posix.dirname(from), spec));
  if (target.startsWith("../") || target === "..") return [];
  const ext = posix.extname(target);
  const stem = target.slice(0, target.length - ext.length);
  return [
    ...(JS_TO_TS[ext] ?? []).map((e) => `${stem}${e}`),
    target,
    ...EXTENSIONS.map((e) => `${target}${e}`),
    ...EXTENSIONS.map((e) => `${target}/index${e}`),
  ];
}

function siblingTests(file: string): string[] {
  const dir = posix.dirname(file);
  const name = posix.basename(file, posix.extname(file));
  const base = `${dir === "." ? "" : `${escapeGlob(dir)}/`}${escapeGlob(name)}`;
  return [
    `${base}.{test,spec}.*`,
    `${base}.*.{test,spec}.*`,
    `${base}-*.{test,spec}.*`,
  ];
}

export function sliceSources(
  card: Card,
  exclude: Iterable<string> = [],
): string[] {
  const skip = new Set(exclude);
  return sourceTouches(card).filter((t) => !isTestPath(t) && !skip.has(t));
}

export async function capSlice(
  worktree: string,
  card: Card,
  exclude: Iterable<string> = [],
): Promise<string[]> {
  const skip = new Set(exclude);
  const ctx = buildContext(worktree);
  const globs = sliceSources(card, skip);
  const sources =
    globs.length > 0
      ? (await ctx.glob(globs)).filter(
          (p) => !isGeneratedPath(p) && !isTestPath(p) && !skip.has(p),
        )
      : [];

  const imports: string[] = [];
  for (const file of sources.filter((f) => CODE.test(f))) {
    const text = await ctx.readFile(file);
    if (text === null) continue;
    for (const spec of relativeImports(text)) {
      const options = candidates(file, spec);
      if (options.length === 0) continue;
      const exists = new Set(await ctx.glob(options.map(escapeGlob)));
      const hit = options.find((o) => exists.has(o));
      if (hit && !isGeneratedPath(hit)) imports.push(hit);
    }
  }

  const tests =
    sources.length > 0
      ? (await ctx.glob(sources.flatMap(siblingTests))).filter(isTestPath)
      : [];

  return [...new Set([...sources, ...imports, ...tests])]
    .filter((p) => !skip.has(p))
    .sort();
}
