import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Where init records the files it wrote outside .rivetari/, for eject. */
export const MANIFEST_REL = ".rivetari/manifest.json";

/**
 * One file init wrote: its hash once init finished, and how it came to be.
 * `created` means there was no file before; `backup` names the copy of the
 * file init replaced; `added` lists the lines init appended to a file of the
 * repo's own, which has no backup.
 */
export interface ManifestEntry {
  sha256: string;
  created?: true;
  backup?: string;
  added?: string[];
}

export interface Manifest {
  version: 1;
  files: Record<string, ManifestEntry>;
}

/**
 * A file's hash with its line endings made LF, so a checkout that turned
 * them into CRLF still counts as unchanged.
 */
export const contentHash = (text: string): string =>
  createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");

/**
 * Every file init writes outside .rivetari/. The manifest is committed, so
 * a path it names is trusted only if it's one of these: anything else could
 * point eject at a file init never wrote, in the repo or outside it.
 */
export const INIT_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "CONSTRAINTS.md",
  ".gitattributes",
  ".gitignore",
  ".claude/settings.json",
  ".claude/skills/rivetari/SKILL.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/workflows/ci.yml",
  ".github/workflows/rivetari.yml",
];

/** Whether `backup` is a name init's keepBackup gives `rel`: `rel.bak` or `rel.bak.N`. */
const isBackupOf = (rel: string, backup: string): boolean =>
  backup.startsWith(`${rel}.bak`) &&
  /^(\.\d+)?$/.test(backup.slice(rel.length + 4));

/**
 * The manifest, or null when init never wrote one. Throws when it won't
 * parse, or names a file or backup init doesn't write.
 */
export async function readManifest(root: string): Promise<Manifest | null> {
  const text = await readFile(resolve(root, MANIFEST_REL), "utf8").catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    },
  );
  if (text === null) return null;
  const parsed = JSON.parse(text) as Partial<Manifest> | null;
  if (
    parsed?.version !== 1 ||
    typeof parsed.files !== "object" ||
    parsed.files === null
  )
    throw new Error(`${MANIFEST_REL} isn't a manifest init wrote`);
  for (const [rel, value] of Object.entries(parsed.files)) {
    const e = value as Partial<ManifestEntry> | null;
    if (!INIT_FILES.includes(rel))
      throw new Error(`${MANIFEST_REL} names ${rel}, which init never writes`);
    if (typeof e?.sha256 !== "string")
      throw new Error(`${MANIFEST_REL} has no hash for ${rel}`);
    if (
      e.backup !== undefined &&
      (typeof e.backup !== "string" || !isBackupOf(rel, e.backup))
    )
      throw new Error(
        `${MANIFEST_REL} names ${String(e.backup)} as the backup of ${rel}, which isn't a name init gives a backup`,
      );
    if (
      e.added !== undefined &&
      !(Array.isArray(e.added) && e.added.every((l) => typeof l === "string"))
    )
      throw new Error(
        `${MANIFEST_REL} lists lines for ${rel} that aren't text`,
      );
  }
  return parsed as Manifest;
}

type Origin = Omit<ManifestEntry, "sha256">;

/** What one init run did to files outside .rivetari/, written out at its end. */
export class ManifestRecorder {
  private readonly touched = new Map<string, Origin>();

  created(rel: string): void {
    this.touched.set(rel, { created: true });
  }

  backedUp(rel: string, backup: string): void {
    this.touched.set(rel, { backup });
  }

  appended(rel: string, line: string): void {
    const origin = this.touched.get(rel) ?? {};
    if (origin.created || origin.backup) return;
    this.touched.set(rel, { added: [...(origin.added ?? []), line] });
  }

  /**
   * Write the manifest with every touched file's hash as it is now. A file an
   * earlier init recorded keeps how it first came to be, so a re-init's backup
   * of init's own output is never taken for the repo's original.
   */
  async write(root: string, old: Manifest | null): Promise<void> {
    const files: Record<string, ManifestEntry> = { ...(old?.files ?? {}) };
    for (const [rel, origin] of this.touched) {
      const text = await readFile(resolve(root, rel), "utf8").catch(() => null);
      if (text === null) continue;
      const before = old?.files[rel];
      const kept: Origin =
        before && (before.created || before.backup)
          ? {
              ...(before.created ? { created: true as const } : {}),
              ...(before.backup ? { backup: before.backup } : {}),
            }
          : before?.added && origin.added
            ? { added: [...new Set([...before.added, ...origin.added])] }
            : origin;
      files[rel] = { sha256: contentHash(text), ...kept };
    }
    const sorted = Object.fromEntries(
      Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
    );
    await writeFile(
      resolve(root, MANIFEST_REL),
      `${JSON.stringify({ version: 1, files: sorted }, null, 2)}\n`,
      "utf8",
    );
  }
}
