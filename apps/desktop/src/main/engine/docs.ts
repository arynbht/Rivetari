// Docs adapter: list the repo's Markdown docs and read one. Uses the engine's
// contained glob/readFile (symlink-safe, repo-rooted), so the renderer can only
// read Markdown inside the repo. Electron-free.
import { basename } from "node:path";

import { buildContext } from "@arynbht/rivetari-engine";

import type { DocContent, DocEntry } from "../../shared/ipc";

const DOC_GLOBS = [
  "*.md",
  "docs/**/*.md",
  ".rivetari/**/*.md",
  ".github/**/*.md",
];

/**
 * Task ledgers live under here. Tasks already shows each task's record, so
 * listing them again would bury the repo's own docs among them.
 */
const TASKS_DIR = ".rivetari/tasks/";

export async function listDocs(repoPath: string): Promise<DocEntry[]> {
  const ctx = buildContext(repoPath, {});
  const matches = await ctx.glob(DOC_GLOBS);
  const unique = [...new Set(matches)]
    .filter((path) => !path.startsWith(TASKS_DIR))
    .sort((a, b) => a.localeCompare(b));
  return unique.map((path) => ({ path, name: path }));
}

export async function readDoc(
  repoPath: string,
  path: string,
): Promise<DocContent> {
  const ctx = buildContext(repoPath, {});
  const markdown = await ctx.readFile(path);
  if (markdown === null) {
    throw new Error(`document not found: ${basename(path)}`);
  }
  return { path, markdown };
}
