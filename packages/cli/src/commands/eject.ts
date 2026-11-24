import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { readState } from "@arynbht/rivetari-registry";
import {
  FLOORPLAN_DIR,
  FLOORPLAN_IGNORE,
  isFloorplanMap,
  listTasks,
  nextStep,
  pullTasks,
} from "@arynbht/rivetari-runtime";

import { contentHash, readManifest } from "./init-manifest.js";

const run = promisify(execFile);

export interface EjectFlags {
  /** Do it; without this (or --apply) eject only says what it would do. */
  yes?: boolean;
  apply?: boolean;
}

export interface EjectOptions {
  /** The ids of the tasks still open (tests). Default: the runtime's listing. */
  openTasks?: ((root: string) => Promise<string[]>) | undefined;
}

/** A file eject leaves as it is, and the lines in it a person may take out. */
interface ByHand {
  rel: string;
  why: string;
  lines: string[];
}

interface Plan {
  /** Paths to delete, a directory with a trailing "/". */
  remove: string[];
  /** Init's backups put back over the file init wrote. */
  restore: { from: string; to: string }[];
  move: { from: string; to: string }[];
  byHand: ByHand[];
  /** Why eject can't go ahead, beyond open tasks. */
  blocked: string[];
  notes: string[];
}

/** Where evidence that lived under .rivetari/ is kept. */
const EVIDENCE_HOME = "docs/evidence";

/** What init writes beside a file of the repo's own, for a person to merge. */
const BESIDE = [
  "AGENTS.rivetari.md",
  "CONSTRAINTS.rivetari.md",
  "CLAUDE.rivetari.md",
  ".github/PULL_REQUEST_TEMPLATE.rivetari.md",
  ".claude/settings.rivetari.json",
  ".github/workflows/rivetari.yml",
  ".github/workflows/rivetari.rivetari.yml",
];

/** Rivetari's own paths: nothing of the repo's lives in them, so they go whole. */
const OWN_DIRS = [".rivetari/", ".claude/skills/rivetari/"];
const isOwn = (rel: string) =>
  BESIDE.includes(rel) || OWN_DIRS.some((d) => rel.startsWith(d));

/**
 * Files a repo keeps for itself that init may have written to. Eject never
 * edits them: it shows what in them still names Rivetari.
 */
const SHARED = [
  "AGENTS.md",
  "CLAUDE.md",
  "CONSTRAINTS.md",
  "DESIGN.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".claude/settings.json",
  ".claude/skills/.gitignore",
  ".gitignore",
  ".gitattributes",
  ".dockerignore",
  ".npmignore",
  ".prettierignore",
  ".eslintignore",
];

/** Directories eject may leave empty, deepest first; they go too. */
const PRUNE = [
  ".github/workflows",
  ".github",
  ".claude/skills",
  ".claude",
  ".agents/skills",
  ".agents",
];

/** A skill name a sync state can name without leaving the skills folder. */
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The block `rivetari skills sync` keeps in .claude/skills/.gitignore. */
const SYNC_BLOCK =
  /# rivetari skills \(managed by `rivetari skills sync`\)[\s\S]*?# end rivetari skills\r?\n?/;

const readIfThere = (path: string): Promise<string | null> =>
  readFile(path, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT" || err.code === "EISDIR") return null;
    throw err;
  });

/** A directory's entries; none when it isn't there. */
const listDir = (path: string): Promise<string[]> =>
  readdir(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return [];
    throw err;
  });

const exists = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") return false;
      throw err;
    },
  );

const mentions = (s: string) => /rivetari/i.test(s);

/** The lines of `text` that `pick` matches, numbered as an editor shows them. */
const numbered = (text: string, pick: (line: string) => boolean): string[] =>
  text.split(/\r?\n/).flatMap((l, i) => (pick(l) ? [`${i + 1}: ${l}`] : []));

/** Whether `root` or a folder above it has a .git entry, file or folder. */
async function underGit(root: string): Promise<boolean> {
  for (let dir = root; ; dir = dirname(dir)) {
    if (await exists(resolve(dir, ".git"))) return true;
    if (dirname(dir) === dir) return false;
  }
}

/**
 * pullTasks reads a git that fails as a repo with no origin, so git has to
 * answer first. Only a folder with no .git anywhere above it and no GIT_DIR
 * is really outside a repo; git says "not a git repository" for a broken
 * .git too. Any other failure (a broken config, an unsafe directory, no git
 * at all) means the tasks branch can't be checked, and eject refuses rather
 * than trust the local copy.
 */
async function checkGit(root: string): Promise<void> {
  try {
    await run("git", ["remote"], { cwd: root });
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "").trim();
    if (
      /not a git repository/i.test(stderr) &&
      !process.env.GIT_DIR &&
      !(await underGit(root))
    )
      return;
    throw new Error(`git couldn't read the repo: ${stderr || String(err)}`);
  }
}

/**
 * The open tasks, from this checkout's records, brought up to the tasks
 * branch first when `pull` is set. pullTasks settles for the local copy only
 * when there's no origin or no tasks branch; any other failure propagates and
 * eject refuses. So does a record the listing had to skip, since it may be a
 * task still being opened. A dry run doesn't pull, since a pull writes the
 * records it fetches.
 */
async function openTasks(root: string, pull: boolean): Promise<string[]> {
  if (pull) {
    await checkGit(root);
    await pullTasks(root);
  }
  // The listing reads a tasks folder it can't open as no tasks at all.
  await readdir(resolve(root, ".rivetari", "tasks")).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    },
  );
  const skipped: string[] = [];
  const tasks = await listTasks(root, (m) => skipped.push(m));
  if (skipped.length > 0) throw new Error(skipped.join("; "));
  return tasks.filter((t) => nextStep(t) !== "done").map((t) => t.card.id);
}

/** Whether an evidence file is init's empty seed, which has nothing to keep. */
function emptySeed(name: string, text: string | null): boolean {
  return (
    name === "evidence.yml" && text !== null && /^\s*(\[\])?\s*$/.test(text)
  );
}

async function planEject(root: string): Promise<Plan> {
  const plan: Plan = {
    remove: [],
    restore: [],
    move: [],
    byHand: [],
    blocked: [],
    notes: [],
  };
  const at = (rel: string) => resolve(root, rel);
  const removeIfThere = async (rel: string, dir = false) => {
    if (await exists(at(rel))) plan.remove.push(dir ? `${rel}/` : rel);
  };

  // Evidence is a person's record: it moves out of .rivetari/ before that goes.
  const rivetariThere = await exists(at(".rivetari"));
  if (rivetariThere) {
    const moves: string[] = [];
    for (const name of (await readdir(at(".rivetari"))).sort()) {
      if (!name.startsWith("evidence")) continue;
      const from = `.rivetari/${name}`;
      // A folder of evidence is emptied into docs/evidence/, not nested in it.
      if ((await stat(at(from))).isDirectory())
        for (const entry of (await readdir(at(from))).sort())
          moves.push(`${from}/${entry}`);
      else if (!emptySeed(name, await readIfThere(at(from)))) moves.push(from);
    }
    for (const from of moves) {
      const to = `${EVIDENCE_HOME}/${from.slice(from.lastIndexOf("/") + 1)}`;
      if ((await exists(at(to))) || plan.move.some((m) => m.to === to))
        plan.blocked.push(
          `${to} is already there, so ${from} has nowhere to go`,
        );
      else plan.move.push({ from, to });
    }
  }

  // Skills a sync installed: the copy under .agents/ and the link to it.
  const state = rivetariThere ? await readState(root) : null;
  const synced = (state?.skills ?? [])
    .filter((s) => s.installed && SKILL_NAME.test(s.name))
    .map((s) => s.name);
  for (const name of synced) {
    await removeIfThere(`.claude/skills/${name}`, true);
    await removeIfThere(`.agents/skills/${name}`, true);
  }
  const agentsSkills = await listDir(at(".agents/skills"));
  const theirSkills = agentsSkills.filter(
    (n) => n !== ".gitignore" && !synced.includes(n),
  );
  const agentsIgnore = await readIfThere(at(".agents/skills/.gitignore"));
  if (
    agentsSkills.length > 0 &&
    theirSkills.length === 0 &&
    (agentsIgnore === null || agentsIgnore.trim() === "*")
  ) {
    plan.remove = plan.remove.filter((r) => !r.startsWith(".agents/skills/"));
    plan.remove.push(".agents/skills/");
  }
  // The sync's ignore file goes only when its block is all there is in it.
  const skillsIgnore = await readIfThere(at(".claude/skills/.gitignore"));
  if (
    skillsIgnore !== null &&
    skillsIgnore.replace(SYNC_BLOCK, "").trim() === ""
  )
    plan.remove.push(".claude/skills/.gitignore");

  // The /rivetari skill init wrote, the workflow, and the files init put
  // beside the repo's own for a person to merge.
  await removeIfThere(".claude/skills/rivetari", true);
  for (const rel of BESIDE) await removeIfThere(rel);
  const mapped = await isFloorplanMap(at(FLOORPLAN_DIR));
  if (mapped) plan.remove.push(`${FLOORPLAN_DIR}/`);

  // What init recorded writing is undone only where it's as init left it: a
  // file it created goes, a file it replaced gets its backup back. Anything
  // changed since is left as it is.
  const manifest = rivetariThere ? await readManifest(root) : null;
  const recorded = new Set<string>();
  for (const [rel, e] of Object.entries(manifest?.files ?? {}).sort()) {
    if (isOwn(rel)) continue;
    recorded.add(rel);
    const text = await readIfThere(at(rel));
    if (text === null) continue;
    const backupThere = e.backup !== undefined && (await exists(at(e.backup)));
    const added = new Set(e.added ?? []);
    if (contentHash(text) !== e.sha256) {
      plan.byHand.push({
        rel,
        why: `changed since init, so eject leaves it${backupThere ? `; the file from before init is ${e.backup}` : ""}`,
        lines: numbered(text, (l) => mentions(l) || added.has(l.trim())),
      });
    } else if (e.created) {
      plan.remove.push(rel);
    } else if (e.backup && backupThere) {
      plan.restore.push({ from: e.backup, to: rel });
    } else if (e.backup) {
      plan.byHand.push({
        rel,
        why: `init's backup of it, ${e.backup}, is gone, so the file from before init can't be put back`,
        lines: numbered(text, mentions),
      });
    } else {
      const added = new Set(e.added ?? []);
      plan.byHand.push({
        rel,
        why: "init added these lines to it",
        lines: numbered(text, (l) => added.has(l.trim())),
      });
    }
  }

  // The repo's own files init has no record of are never touched; what in
  // them names Rivetari is listed for a person.
  const workflows = (await listDir(at(".github/workflows")))
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => `.github/workflows/${f}`)
    .filter((rel) => !isOwn(rel))
    .sort();
  for (const rel of [...SHARED, ...workflows]) {
    if (recorded.has(rel) || plan.remove.includes(rel)) continue;
    const text = await readIfThere(at(rel));
    if (text === null) continue;
    const lines = numbered(
      text,
      (l) =>
        mentions(l) ||
        (mapped && rel === ".gitignore" && l.trim() === FLOORPLAN_IGNORE),
    );
    if (lines.length === 0) continue;
    plan.byHand.push({
      rel,
      why: manifest
        ? "init has no record of writing it, so eject leaves it"
        : "init kept no record of what it wrote here (it predates the manifest), so eject leaves it",
      lines,
    });
  }
  const settings = plan.byHand.find((b) => b.rel === ".claude/settings.json");
  if (settings?.lines.some((l) => /rivetari hook/.test(l)))
    plan.notes.push(
      "take the `rivetari hook` commands out of .claude/settings.json before you uninstall the CLI: Claude Code runs them on every tool call, and once `rivetari` is gone the guard blocks every one",
    );

  if (rivetariThere) {
    plan.remove.push(".rivetari/");
    // Task records aren't committed, so on a repo without the tasks branch
    // this copy is the only one: name them before they go.
    const ids = (await listDir(at(".rivetari/tasks"))).filter((n) =>
      /^T-\d+$/.test(n),
    );
    if (ids.length > 0)
      plan.notes.push(
        `.rivetari/ holds the records of ${ids.sort().join(", ")}; they go with it unless the rivetari/tasks branch has them`,
      );
    plan.notes.push(
      "the rivetari/tasks and evidence branches, where the repo has them, are left as they are: they're the record of past tasks",
    );
  }
  return plan;
}

/** Remove `rel`: a link as a link, never by walking into what it points at. */
async function removePath(root: string, rel: string): Promise<void> {
  const abs = resolve(root, rel.replace(/\/$/, ""));
  const stat = await lstat(abs).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (!stat) return;
  await rm(abs, { recursive: !stat.isSymbolicLink(), force: true });
}

/** Carry out `plan`, recording each step in `done` as it finishes. */
async function applyPlan(
  root: string,
  plan: Plan,
  done: string[],
): Promise<void> {
  for (const { from, to } of plan.move) {
    await mkdir(dirname(resolve(root, to)), { recursive: true });
    await rename(resolve(root, from), resolve(root, to));
    done.push(`moved ${from} to ${to}`);
  }
  for (const { from, to } of plan.restore) {
    await rename(resolve(root, from), resolve(root, to));
    done.push(`put ${from} back as ${to}`);
  }
  // Links before the folders they point into; .rivetari/ and its manifest last.
  for (const rel of plan.remove) {
    await removePath(root, rel);
    done.push(`removed ${rel}`);
  }
  for (const rel of PRUNE)
    await rmdir(resolve(root, rel)).catch(() => undefined);
}

function render(plan: Plan, dryRun: boolean): string {
  const lines: string[] = [];
  const list = (title: string, items: string[]) => {
    if (items.length === 0) return;
    if (dryRun) lines.push(`${title}:`, ...items.map((i) => `  ${i}`));
    else lines.push(`${title} ${items.join(", ")}`);
  };
  list(dryRun ? "Would remove" : "Removed", plan.remove);
  list(
    dryRun ? "Would put back from init's backups" : "Put back",
    plan.restore.map((r) => `${r.to} (from ${r.from})`),
  );
  list(
    dryRun ? "Would move" : "Moved",
    plan.move.map((m) => `${m.from} to ${m.to}`),
  );
  if (plan.byHand.length > 0) {
    // Eject edits no file it keeps, so these are shown line by line instead.
    lines.push("Left as they are; take these lines out by hand if you want:");
    for (const b of plan.byHand) {
      lines.push(`  ${b.rel} (${b.why})`);
      lines.push(...b.lines.map((l) => `      ${l}`));
    }
  }
  for (const n of plan.notes) lines.push(`Note: ${n}`);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/**
 * `rivetari eject [path]`: take Rivetari out of a repo. A dry run unless
 * --yes or --apply is given. It removes Rivetari's own paths (.rivetari/,
 * rivetari.yml, the /rivetari skill and synced skills, the files init wrote
 * beside the repo's own, the floorplan map) and undoes what init's manifest
 * says it wrote, where the file is as init left it: a file init created
 * goes, a file it replaced gets init's backup back. It edits no file it
 * keeps; what's left of Rivetari in them is listed for a person. Evidence
 * moves to docs/evidence/. It refuses while a task is open, or when it can't
 * tell.
 *
 * A caller that passes no flags (the API before the dry run) applies.
 */
export async function runEject(
  path: string,
  flags: EjectFlags = { yes: true },
  options: EjectOptions = {},
): Promise<number> {
  const root = resolve(path);
  const apply = Boolean(flags.yes || flags.apply);

  let open: string[];
  try {
    open = await (options.openTasks ?? ((r) => openTasks(r, apply)))(root);
  } catch (err) {
    console.error(
      `rivetari eject: couldn't read the task records, so nothing was changed: ${(err as Error).message}`,
    );
    return 1;
  }
  let plan: Plan;
  try {
    plan = await planEject(root);
  } catch (err) {
    console.error(
      `rivetari eject: couldn't work out what to remove, so nothing was changed: ${(err as Error).message}`,
    );
    return 1;
  }
  const nothing =
    plan.remove.length === 0 &&
    plan.restore.length === 0 &&
    plan.move.length === 0;

  if (open.length > 0 || plan.blocked.length > 0) {
    if (!apply && !nothing) process.stdout.write(render(plan, true));
    const why = [
      ...(open.length > 0
        ? [
            `${open.join(", ")} ${open.length === 1 ? "is" : "are"} still open: close ${open.length === 1 ? "it" : "them"} first (\`rivetari task close <id>\`)`,
          ]
        : []),
      ...plan.blocked,
    ];
    console.error(
      `rivetari eject: not ejecting, nothing was changed: ${why.join("; ")}.`,
    );
    return 1;
  }
  if (nothing) {
    process.stdout.write(
      plan.byHand.length > 0 || plan.notes.length > 0
        ? render(plan, !apply)
        : "Nothing Rivetari generated is here to remove.\n",
    );
    return 0;
  }
  if (!apply) {
    process.stdout.write(
      `Dry run: nothing has changed. Run \`rivetari eject --yes\` to do this. Open tasks were read from this checkout's records without pulling; --yes pulls them first.\n${render(plan, true)}`,
    );
    return 0;
  }
  const done: string[] = [];
  try {
    await applyPlan(root, plan, done);
  } catch (err) {
    console.error(
      `rivetari eject: stopped part-way: ${(err as Error).message}. Done so far: ${done.length > 0 ? done.join("; ") : "nothing"}. Fix that and run it again; it picks up what's left.`,
    );
    return 1;
  }
  process.stdout.write(render(plan, false));
  return 0;
}
