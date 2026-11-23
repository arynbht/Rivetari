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
import { join } from "node:path";

import { runTool } from "@arynbht/factory-engine";
import { simpleGit } from "simple-git";

export function judgeCacheRoot(): string {
  if (process.env.FACTORY_JUDGE_CACHE) return process.env.FACTORY_JUDGE_CACHE;
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "factory", "judge");
}

/** A judge run longer than this has crashed: its lock can be taken over. */
const LOCK_STALE_MS = 3 * 60 * 60_000;
const KEY_FILE = "factory-deps-key";

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

/**
 * The repo's workspace, cloned on first use. Null when another judge holds
 * it: the caller then uses a fresh clone of its own, as before.
 */
export async function acquireWorkspace(
  repoPath: string,
  options: { root?: string | undefined; now?: number | undefined } = {},
): Promise<Workspace | null> {
  const root = options.root ?? judgeCacheRoot();
  const id = createHash("sha256")
    .update(await realpath(repoPath))
    .digest("hex")
    .slice(0, 16);
  const dir = join(root, id);
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
      const noHooks = join(dir, ".git", "factory-no-hooks");
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
