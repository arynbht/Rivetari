import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { readState } from "@arynbht/rivetari-registry";
import {
  FLOORPLAN_DIR,
  FLOORPLAN_IGNORE,
  isFloorplanMap,
  listTasks,
  nextStep,
  pullTasks,
} from "@arynbht/rivetari-runtime";

import { isInitCiWorkflow } from "./init-ci.js";
import { houseRulesFrom, isRivetariHook } from "./init-files.js";

export interface EjectFlags {
  /** Do it; without this (or --apply) eject only says what it would do. */
  yes?: boolean;
  apply?: boolean;
}

export interface EjectOptions {
  /** The ids of the tasks still open (tests). Default: the runtime's listing. */
  openTasks?: ((root: string) => Promise<string[]>) | undefined;
}

/** What eject does to one file it keeps but edits; null text deletes it. */
interface Edit {
  rel: string;
  why: string;
  text: string | null;
}

interface Plan {
  /** Paths to delete, a directory with a trailing "/". */
  remove: string[];
  edit: Edit[];
  move: { from: string; to: string }[];
  keep: string[];
  /** Why eject can't go ahead, beyond open tasks. */
  blocked: string[];
  /** Things a person has to finish by hand. */
  notes: string[];
}

/** Where evidence that lived under .rivetari/ is kept. */
const EVIDENCE_HOME = "docs/evidence";

/** The docs eject keeps, with references to Rivetari taken out of them. */
const KEPT_DOCS = [
  "AGENTS.md",
  "CONSTRAINTS.md",
  "DESIGN.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
];

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

const readIfThere = (path: string): Promise<string | null> =>
  readFile(path, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT" || err.code === "EISDIR") return null;
    throw err;
  });

const exists = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false,
  );

const mentions = (s: string) => /rivetari/i.test(s);

/** The open tasks, from this checkout's records brought up to the tasks branch. */
// pullTasks already settles for the local copy when there's no origin or no
// tasks branch; any other failure means a task opened elsewhere could be
// missed, so it propagates and eject refuses.
async function openTasks(root: string): Promise<string[]> {
  await pullTasks(root);
  const tasks = await listTasks(root);
  return tasks.filter((t) => nextStep(t) !== "done").map((t) => t.card.id);
}

/**
 * The parts of AGENTS.md that only make sense with Rivetari: everything above
 * "This repo" that init wrote, except the protected paths and stop-and-ask
 * lists, which are still the repo's rules.
 */
const CONTRACT_SECTIONS = new Set([
  "Before anything",
  "Every task starts with /rivetari",
  "The beats",
  "Proof and review",
  "People merge",
]);

/** AGENTS.md as init rendered it, cut down to the rules that outlive Rivetari. */
function ejectAgentsContract(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [
    "# AGENTS.md",
    "",
    "These rules apply to every agent that works in this repo.",
    "",
  ];
  let section: string | null = null;
  for (const line of lines) {
    const h2 = /^##\s+(.*?)\s*$/.exec(line);
    if (h2) section = h2[1]!;
    // The title, init's comment and the intro are replaced above.
    if (section === null) continue;
    if (CONTRACT_SECTIONS.has(section)) continue;
    if (line.startsWith("A task never edits these. The judge marks")) {
      out.push("Agents don't change these without asking a person first:");
      continue;
    }
    if (line.startsWith("- Commands: none declared yet; the judge")) continue;
    if (line.startsWith("<!-- House patterns, naming, where things live")) {
      out.push(
        "<!-- House patterns, naming, where things live: add them here. -->",
      );
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s/;
const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * `text` with what refers to Rivetari taken out: the sentences of an HTML
 * comment, the list items, paragraphs, fenced blocks and whole sections that
 * mention it. A heading left with nothing under it goes too.
 */
export function stripRivetari(text: string): string {
  const crlf = text.includes("\r\n");
  let s = text.replace(/\r\n/g, "\n");
  if (s.includes("<!-- Written by `rivetari init`."))
    s = ejectAgentsContract(s);

  // Comments first, sentence by sentence, keeping the rest's wrapping.
  s = s.replace(/<!--([\s\S]*?)-->\n?/g, (whole, body: string) => {
    if (!mentions(body)) return whole;
    const parts = body.split(/(?<=[.!?])(\s+)/);
    let kept = "";
    for (let i = 0; i < parts.length; i += 2) {
      const sentence = parts[i]!;
      if (mentions(sentence)) continue;
      kept += (kept ? (parts[i - 1] ?? " ") : "") + sentence.trimStart();
    }
    kept = kept.trim();
    if (!kept) return "";
    return `<!-- ${kept} -->${whole.endsWith("\n") ? "\n" : ""}`;
  });

  // Then blocks: a heading opens a section, a blank line ends a paragraph.
  const lines = s.split("\n");
  const out: string[] = [];
  let dropLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const heading = /^(#{1,6})\s/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      if (dropLevel && level > dropLevel) continue;
      dropLevel = mentions(line) ? level : 0;
      if (!dropLevel) out.push(line);
      continue;
    }
    if (dropLevel) continue;
    const fence = FENCE.exec(line)?.[1];
    if (fence) {
      let end = i + 1;
      while (end < lines.length && !lines[end]!.trim().startsWith(fence)) end++;
      const block = lines.slice(i, end + 1);
      if (!block.some(mentions)) out.push(...block);
      i = end;
      continue;
    }
    if (line.trim() === "") {
      out.push(line);
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      // An item runs on through lines indented under it.
      let end = i + 1;
      while (
        end < lines.length &&
        lines[end]!.trim() !== "" &&
        !LIST_ITEM.test(lines[end]!) &&
        /^\s/.test(lines[end]!) &&
        !/^#/.test(lines[end]!)
      )
        end++;
      const block = lines.slice(i, end);
      if (!block.some(mentions)) out.push(...block);
      i = end - 1;
      continue;
    }
    let end = i + 1;
    while (
      end < lines.length &&
      lines[end]!.trim() !== "" &&
      !/^#{1,6}\s/.test(lines[end]!) &&
      !LIST_ITEM.test(lines[end]!) &&
      !FENCE.test(lines[end]!)
    )
      end++;
    const block = lines.slice(i, end);
    if (!block.some(mentions)) out.push(...block);
    i = end - 1;
  }

  // A heading with nothing under it before the next of its rank goes.
  const tidy: string[] = [];
  for (let i = 0; i < out.length; i++) {
    const heading = /^(#{1,6})\s/.exec(out[i]!);
    if (heading && i > 0) {
      let j = i + 1;
      while (j < out.length && out[j]!.trim() === "") j++;
      const next = j < out.length ? /^(#{1,6})\s/.exec(out[j]!) : null;
      if (j === out.length || (next && next[1]!.length <= heading[1]!.length))
        continue;
    }
    tidy.push(out[i]!);
  }
  let result = tidy.join("\n").replace(/\n{3,}/g, "\n\n");
  result = result.replace(/\n*$/, text.endsWith("\n") ? "\n" : "");
  return crlf ? result.replace(/\n/g, "\r\n") : result;
}

/** `text` without the lines whose trimmed value `drop` matches. */
function withoutLines(text: string, drop: (line: string) => boolean): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return text
    .split(/\r?\n/)
    .filter((l) => !drop(l.trim()))
    .join(eol);
}

/** An edit to `rel` when `next` differs, deleting it when nothing's left. */
function editFor(
  rel: string,
  text: string,
  next: string,
  why: string,
): Edit | null {
  if (next === text) return null;
  return next.trim() === ""
    ? { rel, why: `${why}; nothing else is in it, so it goes`, text: null }
    : { rel, why, text: next };
}

/** .claude/settings.json without Rivetari's hooks; undefined when it won't parse. */
function settingsWithoutHooks(text: string): string | null | undefined {
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    return undefined;
  }
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObject(settings) || !isObject(settings.hooks)) return text;
  const hooks: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups;
      continue;
    }
    const kept = groups.flatMap((group: unknown) => {
      if (!isObject(group) || !Array.isArray(group.hooks)) return [group];
      const inner: unknown[] = group.hooks;
      const rest = inner.filter(
        (h: unknown) => !isRivetariHook(isObject(h) ? h.command : undefined),
      );
      if (rest.length === inner.length) return [group];
      return rest.length > 0 ? [{ ...group, hooks: rest }] : [];
    });
    if (kept.length > 0) hooks[event] = kept;
  }
  const next: Record<string, unknown> = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  if (JSON.stringify(next) === JSON.stringify(settings)) return text;
  return Object.keys(next).length === 0
    ? null
    : `${JSON.stringify(next, null, 2)}\n`;
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
    edit: [],
    move: [],
    keep: [],
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
  const agentsSkills = await readdir(at(".agents/skills")).catch(
    () => [] as string[],
  );
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
  const skillsIgnore = await readIfThere(at(".claude/skills/.gitignore"));
  if (skillsIgnore !== null) {
    const next = skillsIgnore.replace(
      /# rivetari skills \(managed by `rivetari skills sync`\)[\s\S]*?# end rivetari skills\r?\n?/,
      "",
    );
    const edit = editFor(
      ".claude/skills/.gitignore",
      skillsIgnore,
      next,
      "drop the synced skills' lines",
    );
    if (edit) plan.edit.push(edit);
  }

  // The /rivetari skill init wrote, the workflow, and the files init put
  // beside the repo's own for a person to merge.
  await removeIfThere(".claude/skills/rivetari", true);
  for (const rel of BESIDE) await removeIfThere(rel);

  const settingsRel = ".claude/settings.json";
  const settings = await readIfThere(at(settingsRel));
  if (settings !== null) {
    const next = settingsWithoutHooks(settings);
    if (next === undefined)
      plan.notes.push(
        `${settingsRel} doesn't parse, so Rivetari's hooks are still in it: take out the \`rivetari hook\` commands by hand`,
      );
    else if (next === null)
      plan.edit.push({
        rel: settingsRel,
        why: "drop Rivetari's hooks; nothing else is in it, so it goes",
        text: null,
      });
    else if (next !== settings)
      plan.edit.push({
        rel: settingsRel,
        why: "drop Rivetari's hooks, keep the other settings",
        text: next,
      });
  }

  // CLAUDE.md that only points at AGENTS.md goes; one with rules of its own stays.
  const claudeLinked = await lstat(at("CLAUDE.md")).then(
    (s) => s.isSymbolicLink(),
    () => false,
  );
  const claude = claudeLinked ? null : await readIfThere(at("CLAUDE.md"));
  if (claude !== null) {
    if (houseRulesFrom(claude) === null) plan.remove.push("CLAUDE.md");
    else {
      plan.keep.push("CLAUDE.md");
      const edit = editFor(
        "CLAUDE.md",
        claude,
        stripRivetari(claude),
        "drop the lines about Rivetari",
      );
      if (edit) plan.edit.push(edit);
    }
  }

  if (await isFloorplanMap(at(FLOORPLAN_DIR)))
    plan.remove.push(`${FLOORPLAN_DIR}/`);

  // Lines init added to the repo's own ignore and attribute files.
  for (const [rel, drop] of [
    [
      ".gitignore",
      (l: string) => l === FLOORPLAN_IGNORE || /^\/?\.rivetari(\/|$)/.test(l),
    ],
    [".gitattributes", (l: string) => /^\/?\.rivetari\//.test(l)],
  ] as const) {
    const text = await readIfThere(at(rel));
    if (text === null) continue;
    const edit = editFor(
      rel,
      text,
      withoutLines(text, drop),
      "drop Rivetari's lines",
    );
    if (edit) plan.edit.push(edit);
  }

  // The docs and CI stay, without what pointed at Rivetari.
  for (const rel of KEPT_DOCS) {
    const text = await readIfThere(at(rel));
    if (text === null) continue;
    plan.keep.push(rel);
    const edit = editFor(
      rel,
      text,
      stripRivetari(text),
      "drop what refers to Rivetari",
    );
    if (edit) plan.edit.push(edit);
  }
  const workflows = (
    await readdir(at(".github/workflows")).catch(() => [] as string[])
  )
    .filter(
      (f) => /\.ya?ml$/.test(f) && !/^rivetari(\.rivetari)?\.ya?ml$/.test(f),
    )
    .sort();
  for (const f of workflows) {
    const rel = `.github/workflows/${f}`;
    plan.keep.push(rel);
    const text = await readIfThere(at(rel));
    if (text === null || !isInitCiWorkflow(text)) continue;
    const next = text.replace(
      /^# Written by `rivetari init` for [^\n]*?\.\s+/,
      "# ",
    );
    const edit = editFor(
      rel,
      text,
      next,
      "drop the line saying Rivetari wrote it",
    );
    if (edit) plan.edit.push(edit);
  }

  if (rivetariThere) {
    plan.remove.push(".rivetari/");
    // Task records aren't committed, so on a repo without the tasks branch
    // this copy is the only one: name them before they go.
    const ids = (
      await readdir(at(".rivetari/tasks")).catch(() => [] as string[])
    ).filter((n) => /^T-\d+$/.test(n));
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
  const stat = await lstat(abs).catch(() => null);
  if (!stat) return;
  await rm(abs, { recursive: !stat.isSymbolicLink(), force: true });
}

async function applyPlan(root: string, plan: Plan): Promise<void> {
  for (const { from, to } of plan.move) {
    await mkdir(dirname(resolve(root, to)), { recursive: true });
    await rename(resolve(root, from), resolve(root, to));
  }
  for (const e of plan.edit) {
    const abs = resolve(root, e.rel);
    if (e.text === null) await rm(abs, { force: true });
    else await writeFile(abs, e.text, "utf8");
  }
  // Links before the folders they point into.
  for (const rel of plan.remove) await removePath(root, rel);
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
    dryRun ? "Would move" : "Moved",
    plan.move.map((m) => `${m.from} to ${m.to}`),
  );
  list(
    dryRun ? "Would edit" : "Edited",
    plan.edit.map((e) => `${e.rel} (${e.why})`),
  );
  list(dryRun ? "Would keep" : "Kept", plan.keep);
  for (const n of plan.notes) lines.push(`Note: ${n}`);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/**
 * `rivetari eject [path]`: take Rivetari out of a repo. A dry run unless
 * --yes or --apply is given. It keeps the docs (AGENTS.md, CONSTRAINTS.md,
 * DESIGN.md, the PR template) without what refers to Rivetari, the repo's CI
 * and its evidence, and removes the rest: .rivetari/, rivetari.yml, the skills
 * and hooks under .claude/, a CLAUDE.md that only points at AGENTS.md, the
 * floorplan map and init's ignore lines. It refuses while a task is open.
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
    open = await (options.openTasks ?? openTasks)(root);
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
    plan.edit.length === 0 &&
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
      plan.notes.length > 0
        ? render(plan, !apply)
        : "Nothing Rivetari generated is here to remove.\n",
    );
    return 0;
  }
  if (!apply) {
    process.stdout.write(
      `Dry run: nothing has changed. Run \`rivetari eject --yes\` to do this.\n${render(plan, true)}`,
    );
    return 0;
  }
  await applyPlan(root, plan);
  process.stdout.write(render(plan, false));
  return 0;
}
