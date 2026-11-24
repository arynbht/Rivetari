// The "before" side of a UI proof depends only on the base tree and how it's
// shot, yet each proof round checked the base out, installed it, served it
// and shot it again. Keep what it produced, keyed on exactly those inputs, in
// the repo's git dir (local, never committed), and reuse it while they hold.
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";

import { simpleGit } from "simple-git";

import type { AxeViolation, Shot } from "./shoot.js";

/** Entries kept; the oldest go first. Each is one base's images. */
const KEEP = 20;

interface Entry {
  shots: (Omit<Shot, "file"> & { file: string })[];
  violations: AxeViolation[];
}

async function cacheRoot(repoPath: string): Promise<string> {
  const commonDir = (
    await simpleGit(repoPath).raw([
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])
  ).trim();
  return join(commonDir, "rivetari-proof-cache");
}

/**
 * The cache key: the base's tree (not its commit, so a rebase that leaves
 * the tree alone still hits) and everything that shapes the shots.
 */
export async function baseKey(
  repoPath: string,
  base: string,
  inputs: Record<string, unknown>,
): Promise<string> {
  const tree = (
    await simpleGit(repoPath).raw(["rev-parse", `${base}^{tree}`])
  ).trim();
  return createHash("sha256")
    .update(JSON.stringify({ v: 1, tree, ...inputs }))
    .digest("hex")
    .slice(0, 32);
}

/** The cached base side, its images copied into `outDir`; null on a miss. */
export async function loadBase(
  repoPath: string,
  key: string,
  outDir: string,
): Promise<{ shots: Shot[]; violations: AxeViolation[] } | null> {
  const dir = join(await cacheRoot(repoPath), key);
  let entry: Entry;
  try {
    entry = JSON.parse(
      await readFile(join(dir, "entry.json"), "utf8"),
    ) as Entry;
    const shots: Shot[] = [];
    for (const s of entry.shots) {
      const file = join(outDir, s.file);
      await copyFile(join(dir, s.file), file);
      shots.push({ ...s, file });
    }
    return { shots, violations: entry.violations };
  } catch {
    // A missing or partial entry is a miss: the base is shot again.
    return null;
  }
}

/** Keep the base side for next time, and drop the oldest entries past KEEP. */
export async function saveBase(
  repoPath: string,
  key: string,
  result: { shots: readonly Shot[]; violations: readonly AxeViolation[] },
): Promise<void> {
  const root = await cacheRoot(repoPath);
  const dir = join(root, key);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const s of result.shots)
    await copyFile(s.file, join(dir, basename(s.file)));
  const entry: Entry = {
    shots: result.shots.map((s) => ({ ...s, file: basename(s.file) })),
    violations: [...result.violations],
  };
  // entry.json last: a save cut short leaves no entry to load.
  await writeFile(
    join(dir, "entry.json"),
    `${JSON.stringify(entry)}\n`,
    "utf8",
  );
  const entries = await Promise.all(
    (await readdir(root)).map(async (name) => ({
      name,
      at: (await stat(join(root, name)).catch(() => null))?.mtimeMs ?? 0,
    })),
  );
  for (const old of entries.sort((a, b) => b.at - a.at).slice(KEEP))
    await rm(join(root, old.name), { recursive: true, force: true });
}
