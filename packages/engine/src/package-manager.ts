// Which package manager a Node repo uses. Init, the fix templates, verify and
// proof all ask this, and a repo they disagree on gets a lockfile from one tool
// and commands from another, so there is one answer for all of them.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type PackageManager = "npm" | "pnpm" | "yarn";

/** Reads a file relative to the repo root; null when it isn't there. */
export type RepoReader = (rel: string) => Promise<string | null>;

const MANAGERS: readonly string[] = ["npm", "pnpm", "yarn"];

// A lockfile is what the repo last installed with; a workspace or config file
// is the next best thing when nothing has been installed yet.
const FILES: [string, PackageManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["pnpm-workspace.yaml", "pnpm"],
  [".yarnrc.yml", "yarn"],
];

/**
 * The repo's package manager: package.json's `packageManager` field first,
 * then a lockfile or workspace file, then the one its scripts call. It's
 * `fallback` when nothing says otherwise: npm unless the caller says, since npm
 * is the one every Node install has.
 */
export async function inferPackageManager(
  read: RepoReader,
  fallback: PackageManager = "npm",
): Promise<PackageManager> {
  let pkg: { packageManager?: unknown; scripts?: unknown } = {};
  try {
    const parsed: unknown = JSON.parse((await read("package.json")) ?? "{}");
    if (parsed && typeof parsed === "object") pkg = parsed as typeof pkg;
  } catch {
    // An unparseable package.json says nothing; the files below still might.
  }
  const declared =
    typeof pkg.packageManager === "string"
      ? pkg.packageManager.split("@")[0]
      : undefined;
  if (declared && MANAGERS.includes(declared))
    return declared as PackageManager;

  for (const [file, pm] of FILES) if ((await read(file)) !== null) return pm;

  // Scripts that call pnpm or yarn by name show the one the authors run. Both
  // named, or neither, isn't a hint.
  const scripts =
    pkg.scripts && typeof pkg.scripts === "object"
      ? Object.values(pkg.scripts as Record<string, unknown>)
          .filter((s): s is string => typeof s === "string")
          .join("\n")
      : "";
  const pnpm = /(?<![\w-])(pnpm|pnpx)(?![\w.-])/.test(scripts);
  const yarn = /(?<![\w-])yarn(?![\w.-])/.test(scripts);
  if (pnpm !== yarn) return pnpm ? "pnpm" : "yarn";
  return fallback;
}

/** {@link inferPackageManager} for a checkout on disk. */
export function packageManagerAt(
  dir: string,
  fallback: PackageManager = "npm",
): Promise<PackageManager> {
  return inferPackageManager(
    (rel) => readFile(resolve(dir, rel), "utf8").catch(() => null),
    fallback,
  );
}
