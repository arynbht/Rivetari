import { resolve } from "node:path";

import { loadProfile } from "@arynbht/factory-engine";
import {
  addBanned,
  BANNED_PATH,
  BannedPatternSchema,
  defaultsFor,
  loadBanned,
  saveBanned,
} from "@arynbht/factory-runtime";

export interface BannedAddFlags {
  pattern?: string;
  why?: string;
  files?: string;
  allow?: string[];
  source?: string;
  coveredBy?: string;
  path?: string;
}

export async function runBannedList(flags: { path?: string }): Promise<number> {
  const list = await loadBanned(resolve(flags.path ?? "."));
  if (list.patterns.length === 0) {
    process.stdout.write(`no banned patterns (${BANNED_PATH})\n`);
    return 0;
  }
  for (const p of list.patterns)
    process.stdout.write(
      `${p.id}  /${p.pattern}/  ${p.files}${p.allow.length > 0 ? `  allow ${p.allow.join(", ")}` : ""}${p.covered_by ? `  (covered by ${p.covered_by})` : ""}\n  ${p.why} · ${p.source}\n`,
    );
  return 0;
}

export async function runBannedSeed(flags: { path?: string }): Promise<number> {
  const root = resolve(flags.path ?? ".");
  const profile = await loadProfile(root).catch(() => null);
  let list = await loadBanned(root);
  const added: string[] = [];
  for (const entry of defaultsFor(profile?.stack ?? [])) {
    const next = addBanned(list, entry);
    if (next.added) added.push(entry.id);
    list = next.list;
  }
  await saveBanned(root, list);
  process.stdout.write(
    added.length > 0
      ? `added ${added.join(", ")} to ${BANNED_PATH}\n`
      : `nothing to add: ${BANNED_PATH} already has the defaults for ${profile?.stack.join(", ") || "this stack"}\n`,
  );
  return 0;
}

export async function runBannedAdd(
  id: string,
  flags: BannedAddFlags,
): Promise<number> {
  const root = resolve(flags.path ?? ".");
  const parsed = BannedPatternSchema.safeParse({
    id,
    pattern: flags.pattern,
    why: flags.why,
    files: flags.files,
    allow: flags.allow ?? [],
    source: flags.source ?? "added by a person",
    ...(flags.coveredBy ? { covered_by: flags.coveredBy } : {}),
  });
  if (!parsed.success) {
    console.error(
      `factory banned add: ${parsed.error.issues.map((i) => `${i.path.join(".") || "entry"}: ${i.message}`).join("; ")}`,
    );
    return 1;
  }
  const entry = parsed.data;
  const { list, added } = addBanned(await loadBanned(root), entry);
  if (!added) {
    console.error(`factory banned add: ${id} is already in ${BANNED_PATH}`);
    return 1;
  }
  await saveBanned(root, list);
  process.stdout.write(`added ${id} to ${BANNED_PATH}\n`);
  return 0;
}

export async function runBannedAllow(
  id: string,
  glob: string,
  flags: { path?: string },
): Promise<number> {
  const root = resolve(flags.path ?? ".");
  const list = await loadBanned(root);
  const entry = list.patterns.find((p) => p.id === id);
  if (!entry) {
    console.error(`factory banned allow: no ${id} in ${BANNED_PATH}`);
    return 1;
  }
  if (!entry.allow.includes(glob)) entry.allow.push(glob);
  await saveBanned(root, list);
  process.stdout.write(`${id} is now allowed in ${glob}\n`);
  return 0;
}
