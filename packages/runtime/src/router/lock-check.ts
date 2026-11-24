// Sector skills a repo's files route to but its lock doesn't hold. A lock
// with only the spine routes every task without sector skills, and nothing
// fails: doctor says so instead of reporting the lock as fine.
import {
  AGENTS_SKILLS,
  CLAUDE_SKILLS,
  type Manifest,
  type Sector,
  SECTORS,
} from "@arynbht/rivetari-registry";
import picomatch from "picomatch";

export interface LockShortfall {
  sector: Sector;
  /** Task skills for the sector that trigger on the repo's files, unlocked. */
  skills: string[];
  /** A tracked file they trigger on, to show why. */
  file: string;
}

/**
 * Sectors the repo's tracked files would route a task skill into while the
 * lock holds no task skill for them. A sector the lock already covers with
 * any task skill isn't short, even if other skills for it are left out.
 */
export function lockShortfall(input: {
  manifests: ReadonlyMap<string, Manifest>;
  locked: ReadonlySet<string>;
  files: readonly string[];
}): LockShortfall[] {
  const tasks = [...input.manifests.values()].filter((m) => m.scope === "task");
  const covered = new Set<Sector>(
    tasks.filter((m) => input.locked.has(m.name)).flatMap((m) => m.sectors),
  );
  // Installed skills and Rivetari's own state aren't work a task routes on.
  const own = picomatch(
    [`${AGENTS_SKILLS}/**`, `${CLAUDE_SKILLS}/**`, ".rivetari/**"],
    { dot: true },
  );
  const files = input.files.filter((f) => !own(f));
  const short = new Map<Sector, LockShortfall>();
  for (const m of tasks) {
    if (input.locked.has(m.name) || m.triggers.paths.length === 0) continue;
    const isMatch = picomatch([...m.triggers.paths], { dot: true });
    const file = files.find((f) => isMatch(f));
    if (!file) continue;
    for (const sector of m.sectors) {
      if (covered.has(sector)) continue;
      const s = short.get(sector) ?? { sector, skills: [], file };
      s.skills.push(m.name);
      short.set(sector, s);
    }
  }
  return SECTORS.flatMap((sector) => {
    const s = short.get(sector);
    return s ? [{ ...s, skills: s.skills.sort() }] : [];
  });
}
