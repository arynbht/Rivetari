import picomatch from "picomatch";
import { simpleGit } from "simple-git";

import { CardError } from "./card.js";

export const TOUCHES_CAP = 20;

const SHOWN = 5;

export async function trackedFiles(repoPath: string): Promise<string[]> {
  const git = simpleGit(repoPath);
  if (!(await git.checkIsRepo())) return [];
  let out: string;
  try {
    out = await git.raw(["ls-files", "-z"]);
  } catch (err) {
    throw new Error(
      `couldn't list the tracked files to check the card's touches: ${(err as Error).message}`,
      { cause: err },
    );
  }
  return out.split("\0").filter(Boolean);
}

export async function checkTouches(
  repoPath: string,
  touches: readonly string[],
): Promise<void> {
  const globs = touches.filter((t) => picomatch.scan(t).isGlob);
  if (globs.length === 0) return;
  const files = await trackedFiles(repoPath);
  const issues: string[] = [];
  for (const glob of globs) {
    const isMatch = picomatch(glob, { dot: true });
    const matched = files.filter((f) => isMatch(f));
    if (matched.length <= TOUCHES_CAP) continue;
    const more = matched.length - SHOWN;
    issues.push(
      `touches: ${glob} matches ${matched.length} tracked files (${matched.slice(0, SHOWN).join(", ")}, and ${more} more), over the cap of ${TOUCHES_CAP}; name the files the task changes, or narrow the glob`,
    );
  }
  if (issues.length > 0) throw new CardError(issues);
}
