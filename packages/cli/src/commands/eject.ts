import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import { FLOORPLAN_DIR, isFloorplanMap } from "@arynbht/rivetari-runtime";

/**
 * What Rivetari generates in a checkout and never commits, each with the test
 * that it's really Rivetari's: a folder of the same name that belongs to the
 * project is left where it is.
 */
const GENERATED: { path: string; ours: (abs: string) => Promise<boolean> }[] = [
  { path: FLOORPLAN_DIR, ours: isFloorplanMap },
];

/**
 * `rivetari eject [path]`: remove the local output Rivetari generated, which
 * git ignores and nothing else cleans up. Committed files are left alone.
 */
export async function runEject(path: string): Promise<number> {
  const root = resolve(path);
  const removed: string[] = [];
  for (const { path: rel, ours } of GENERATED) {
    const abs = resolve(root, rel);
    if (!(await ours(abs))) continue;
    await rm(abs, { recursive: true, force: true });
    removed.push(`${rel}/`);
  }
  process.stdout.write(
    removed.length > 0
      ? `Removed ${removed.join(", ")}\n`
      : "Nothing Rivetari generated is here to remove.\n",
  );
  return 0;
}
