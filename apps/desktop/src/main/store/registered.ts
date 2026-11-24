// Which repo an IPC request is about, decided by main from its own list of
// registered repos (the sidebar's repos.json), never from the path the
// renderer sent: a renderer that's been talked into sending another folder
// gets a refusal, not a read or a write there. The path handed on is the
// registered entry's own.
// Kept free of any electron import so it unit-tests as plain functions.
import { posix, win32 } from "node:path";

import type { RepoEntry } from "../../shared/ipc";

/**
 * The registered repo `asked` names, as the list spells it; throws when it
 * names none of them. Windows paths match without regard to case, as the
 * file system does.
 */
export function registeredRepo(
  asked: string,
  repos: RepoEntry[],
  platform: NodeJS.Platform = process.platform,
): string {
  const path = platform === "win32" ? win32 : posix;
  const keyOf = (p: string) => {
    const full = path.resolve(p);
    return platform === "win32" ? full.toLowerCase() : full;
  };
  const key = path.isAbsolute(asked) ? keyOf(asked) : null;
  const repo =
    key === null ? undefined : repos.find((r) => keyOf(r.path) === key);
  if (!repo) throw new Error(`${asked} isn't one of the registered repos`);
  return repo.path;
}
