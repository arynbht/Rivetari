// The judge's persistent workspace: one prepared clone per repo, kept between
// rounds and tasks so an unchanged dependency set is installed once, not every
// round. It lives in the user's cache, never in the repo or a worktree, and its
// path is never handed to the agent. Dependencies in it come only from the
// base's lockfile and manifests, as with a fresh clone.
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { type ControlResult, runTool } from "@arynbht/rivetari-engine";
import picomatch from "picomatch";
import { type SimpleGit, simpleGit } from "simple-git";
import { parse as parseYaml } from "yaml";

export function judgeCacheRoot(): string {
  if (process.env.RIVETARI_JUDGE_CACHE) return process.env.RIVETARI_JUDGE_CACHE;
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "rivetari", "judge");
}

/** A judge run longer than this has crashed: its lock can be taken over. */
const LOCK_STALE_MS = 3 * 60 * 60_000;
const KEY_FILE = "rivetari-deps-key";

export interface Workspace {
  dir: string;
  /** True when the clone was made for this run. */
  created: boolean;
  release: () => Promise<void>;
}

async function takeLock(lock: string, now: number): Promise<boolean> {
  try {
    await mkdir(lock);
    return true;
  } catch {
    const age = await stat(lock)
      .then((s) => now - s.mtimeMs)
      .catch(() => 0);
    if (age <= LOCK_STALE_MS) return false;
    await rm(lock, { recursive: true, force: true });
    return mkdir(lock).then(
      () => true,
      () => false,
    );
  }
}

async function repoId(repoPath: string): Promise<string> {
  return createHash("sha256")
    .update(await realpath(repoPath))
    .digest("hex")
    .slice(0, 16);
}

/**
 * The repo's workspace, cloned on first use. Null when another judge holds
 * it: the caller then uses a fresh clone of its own, as before.
 */
export async function acquireWorkspace(
  repoPath: string,
  options: { root?: string | undefined; now?: number | undefined } = {},
): Promise<Workspace | null> {
  const root = options.root ?? judgeCacheRoot();
  const dir = join(root, await repoId(repoPath));
  const lock = `${dir}.lock`;
  await mkdir(root, { recursive: true });
  if (!(await takeLock(lock, options.now ?? Date.now()))) return null;
  const release = () =>
    rm(lock, { recursive: true, force: true }).catch(() => undefined);
  try {
    const ready = await stat(join(dir, ".git"))
      .then(() => simpleGit(dir).revparse(["--git-dir"]))
      .then(
        () => true,
        () => false,
      );
    if (!ready) {
      await rm(dir, { recursive: true, force: true });
      await simpleGit().clone(repoPath, dir, [
        "--quiet",
        "--shared",
        "--no-checkout",
      ]);
      // The target repo's hooks never run inside the judge.
      const noHooks = join(dir, ".git", "rivetari-no-hooks");
      await mkdir(noHooks, { recursive: true });
      await simpleGit(dir, {
        unsafe: { allowUnsafeHooksPath: true },
      }).addConfig("core.hooksPath", noHooks);
    }
    return { dir, created: !ready, release };
  } catch (err) {
    await release();
    throw err;
  }
}

const LOCKFILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
];

/**
 * What the installed dependencies depend on, at the checked-out commit: the
 * lockfile, every package manifest, the package manager's version and the
 * platform. Equal keys install the same tree.
 */
export async function dependencyKey(dir: string): Promise<string> {
  const git = simpleGit(dir);
  const manifests = (
    await git.raw(["ls-files", "-z", "--", "package.json", "**/package.json"])
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  const hash = createHash("sha256");
  for (const path of [...LOCKFILES, ...manifests]) {
    const bytes = await readFile(join(dir, path)).catch(() => null);
    if (bytes === null) continue;
    hash.update(path).update("\0").update(bytes).update("\0");
  }
  hash.update(
    `${await managerVersion(dir)}\0${process.platform}\0${process.arch}\0${process.version}`,
  );
  return hash.digest("hex");
}

async function managerVersion(dir: string): Promise<string> {
  for (const [file, tool] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
  ] as const) {
    const present = await stat(join(dir, file)).then(
      () => true,
      () => false,
    );
    if (!present) continue;
    const run = await runTool(tool, ["--version"], dir).catch(() => null);
    return `${tool} ${run?.stdout.trim() ?? "unknown"}`;
  }
  const run = await runTool("npm", ["--version"], dir).catch(() => null);
  return `npm ${run?.stdout.trim() ?? "unknown"}`;
}

export async function installedKey(dir: string): Promise<string | null> {
  return readFile(join(dir, ".git", KEY_FILE), "utf8").then(
    (s) => s.trim() || null,
    () => null,
  );
}

/** Record what's installed now, or (null) that it's unknown. */
export async function setInstalledKey(
  dir: string,
  key: string | null,
): Promise<void> {
  const path = join(dir, ".git", KEY_FILE);
  if (key === null) await rm(path, { force: true });
  else await writeFile(path, `${key}\n`, "utf8");
}

async function baseResultsPath(
  repoPath: string,
  key: string,
  root: string | undefined,
): Promise<string> {
  return join(
    root ?? judgeCacheRoot(),
    "base-results",
    await repoId(repoPath),
    `${key}.json`,
  );
}

/** Tier 1's results at a base commit, from an earlier round or task. */
export async function readBaseResults(
  repoPath: string,
  key: string,
  root?: string,
): Promise<ControlResult[] | null> {
  const text = await readFile(
    await baseResultsPath(repoPath, key, root),
    "utf8",
  ).catch(() => null);
  if (text === null) return null;
  try {
    return JSON.parse(text) as ControlResult[];
  } catch {
    return null;
  }
}

/**
 * Keep the base's results for the next round or task on that base. Only green
 * and n/a results are kept: a red check may be a flake, and a cached one
 * would mark the change's real failures as pre-existing for good, so it runs
 * again every time.
 */
export async function writeBaseResults(
  repoPath: string,
  key: string,
  results: readonly ControlResult[],
  root?: string,
): Promise<void> {
  const kept = results.filter((r) => r.status === "pass" || r.status === "n/a");
  const path = await baseResultsPath(repoPath, key, root);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(kept), "utf8");
}

// The repo's own pnpm workspace, which scopes tier 1 to the packages a change
// can affect: a full test run is most of a round's time.

/** One package of a pnpm workspace, as a commit has it. */
export interface WorkspacePackage {
  /** Its directory from the repo root, with forward slashes. */
  dir: string;
  name: string | undefined;
  /** Every package it depends on, by name, of any kind. */
  deps: string[];
}

export interface WorkspaceGraph {
  packages: WorkspacePackage[];
  /** What the root package.json depends on. */
  rootDeps: string[];
}

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

/**
 * The pnpm workspace's packages at a commit, read from git rather than a
 * checkout. Null when the repo isn't a pnpm workspace or a manifest can't be
 * read: the judge then checks everything, as it always has.
 */
export async function readWorkspaceGraph(
  repo: SimpleGit,
  rev: string,
): Promise<WorkspaceGraph | null> {
  const show = (path: string) =>
    repo.show([`${rev}:${path}`]).catch(() => null);
  const json = async (path: string) => {
    const text = await show(path);
    if (text === null) return null;
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const depsOf = (pkg: Record<string, unknown>) =>
    DEP_FIELDS.flatMap((field) => {
      const deps = pkg[field];
      return deps && typeof deps === "object" ? Object.keys(deps) : [];
    });

  const manifest = await show("pnpm-workspace.yaml");
  if (manifest === null) return null;
  let globs: string[];
  try {
    const listed = (parseYaml(manifest) as { packages?: unknown } | null)
      ?.packages;
    if (!Array.isArray(listed) || listed.length === 0) return null;
    if (!listed.every((g): g is string => typeof g === "string")) return null;
    globs = listed.map((g) => g.replace(/^(!?)\.\//, "$1").replace(/\/$/, ""));
  } catch {
    return null;
  }
  const include = picomatch(globs.filter((g) => !g.startsWith("!")));
  const negated = globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1));
  const exclude = negated.length > 0 ? picomatch(negated) : () => false;
  const dirs = (await repo.raw(["ls-tree", "-r", "-z", "--name-only", rev]))
    .split("\0")
    .filter((f) => f.endsWith("/package.json"))
    .map((f) => f.slice(0, -"/package.json".length))
    .filter(
      (d) =>
        !d.split("/").includes("node_modules") && include(d) && !exclude(d),
    );
  const packages: WorkspacePackage[] = [];
  for (const dir of dirs) {
    const pkg = await json(`${dir}/package.json`);
    // A manifest we can't read hides who depends on what.
    if (pkg === null) return null;
    packages.push({
      dir,
      name: typeof pkg["name"] === "string" ? pkg["name"] : undefined,
      deps: depsOf(pkg),
    });
  }
  const root = await json("package.json");
  return { packages, rootDeps: root ? depsOf(root) : [] };
}

/** What tier 1 checks: every package, or some of them, and why. */
export type CheckScope =
  | { kind: "all"; why: string }
  | {
      kind: "packages";
      /** The packages' directories: the touched ones, then their dependents. */
      dirs: string[];
      touched: string[];
      dependents: string[];
    };

/**
 * The packages a change can affect: the ones its paths sit in, plus every
 * package that depends on one of them, transitively. A path outside every
 * package (root config, the lockfile, shared scripts) can affect anything, so
 * it scopes to everything, as does a root package that depends on an affected
 * one (tests at the root may import it).
 */
export function affectedScope(
  paths: readonly string[],
  graph: WorkspaceGraph,
): CheckScope {
  if (paths.length === 0) return { kind: "all", why: "the diff is empty" };
  // The deepest directory owns a path, so a nested package isn't its parent's.
  const byDepth = [...graph.packages].sort(
    (a, b) => b.dir.length - a.dir.length,
  );
  const touched = new Set<WorkspacePackage>();
  for (const path of paths) {
    const owner = byDepth.find((p) => path.startsWith(`${p.dir}/`));
    if (!owner)
      return { kind: "all", why: `${path} is outside every workspace package` };
    touched.add(owner);
  }
  const affected = new Set(touched);
  const nameSet = () =>
    new Set([...affected].flatMap((p) => (p.name ? [p.name] : [])));
  for (let grew = true; grew;) {
    grew = false;
    const names = nameSet();
    for (const p of graph.packages) {
      if (affected.has(p) || !p.deps.some((d) => names.has(d))) continue;
      affected.add(p);
      grew = true;
    }
  }
  const rootUses = [...nameSet()].find((n) => graph.rootDeps.includes(n));
  if (rootUses)
    return {
      kind: "all",
      why: `the root package depends on ${rootUses}, which the change affects`,
    };
  if (affected.size === graph.packages.length)
    return { kind: "all", why: "the change reaches every workspace package" };
  const dirsOf = (list: Iterable<WorkspacePackage>) =>
    [...list].map((p) => p.dir).sort();
  const dependents = dirsOf([...affected].filter((p) => !touched.has(p)));
  return {
    kind: "packages",
    dirs: [...dirsOf(touched), ...dependents],
    touched: dirsOf(touched),
    dependents,
  };
}

/**
 * The scope from the graphs at base and on the change together, so a package
 * either side has, and a dependency either side declares, counts. Null when
 * either side isn't a readable pnpm workspace.
 */
export async function workspaceScope(
  repo: SimpleGit,
  revs: readonly string[],
  paths: readonly string[],
): Promise<CheckScope | null> {
  const graphs: WorkspaceGraph[] = [];
  for (const rev of revs) {
    const graph = await readWorkspaceGraph(repo, rev).catch(() => null);
    if (!graph) return null;
    graphs.push(graph);
  }
  const byDir = new Map<string, WorkspacePackage>();
  for (const p of graphs.flatMap((g) => g.packages)) {
    const seen = byDir.get(p.dir);
    byDir.set(
      p.dir,
      seen
        ? {
            dir: p.dir,
            name: p.name ?? seen.name,
            deps: [...new Set([...seen.deps, ...p.deps])],
          }
        : p,
    );
  }
  return affectedScope(paths, {
    packages: [...byDir.values()],
    rootDeps: [...new Set(graphs.flatMap((g) => g.rootDeps))],
  });
}
