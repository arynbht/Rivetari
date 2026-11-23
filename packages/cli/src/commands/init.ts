import {
  access,
  lstat,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

import {
  bundledSkillDir,
  FLAG_KEYS,
  PHASE_KEYS,
  PROJECT_TYPES,
  SEVERITIES,
} from "@arynbht/rivetari-catalog";
import {
  buildContext,
  declaredStacks,
  detectStacks,
  packageManagerAt,
  ProfileError,
  resolveRepoSlug,
  githubToken,
  saveProfile,
} from "@arynbht/rivetari-engine";
import { initLock } from "@arynbht/rivetari-registry";
import {
  BANNED_PATH,
  defaultsFor,
  drawFloorplan,
  FLOORPLAN_DIR,
  FLOORPLAN_IGNORE,
  type FloorplanOptions,
  floorplanUsage,
  isFloorplanMap,
} from "@arynbht/rivetari-runtime";
import {
  cancel,
  intro,
  isCancel,
  multiselect,
  outro,
  select,
  text,
} from "@clack/prompts";
import { parse as parseYaml } from "yaml";

import { runAudit, type RunAuditOptions } from "./audit.js";
import {
  ACTION_REPO,
  type ActionPin,
  isUnpinnedWorkflow,
  parseActionRef,
  renderRivetariWorkflow,
  resolveReleasePin,
} from "./init-action.js";
import {
  CLAUDE_MD,
  houseRulesFrom,
  mergeRivetariHooks,
  movedRulesIn,
  PR_TEMPLATE,
  renderAgentsMd,
  renderConstraintsMd,
  type RepoFacts,
  SETTINGS_JSON,
} from "./init-files.js";

export interface InitFlags {
  type?: string;
  name?: string;
  phase?: string;
  stack?: string;
  flag?: string[];
  severityFloor?: string;
  license?: string;
  owner?: string;
  securityContact?: string;
  yes?: boolean;
  force?: boolean;
  /** Pin the Rivetari action to this commit: `<sha>` or `<sha>:<tag>`. */
  actionRef?: string;
}

/** A file's text, or null when there's no such file. */
const readIfThere = (path: string): Promise<string | null> =>
  readFile(path, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });

/**
 * Keep `existing` as `rel.bak` (or `rel.bak.1`, …): a backup is never
 * overwritten. Returns the backup's path relative to `root`.
 */
async function keepBackup(
  root: string,
  rel: string,
  existing: string,
): Promise<string> {
  let bak = `${rel}.bak`;
  for (let n = 1; ; n++) {
    // "wx" fails if the file exists: the first free name wins, race-free.
    const ok = await writeFile(resolve(root, bak), existing, {
      encoding: "utf8",
      flag: "wx",
    })
      .then(() => true)
      .catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "EEXIST") throw err;
        return false;
      });
    if (ok) return bak;
    bak = `${rel}.bak.${n}`;
  }
}

/**
 * Write a generated file under --force: a missing one is written, and a
 * different one is replaced, the old one kept as a backup. Returns a note when
 * it replaced one.
 */
async function writeReplacing(
  root: string,
  rel: string,
  content: string,
  force: boolean | undefined,
): Promise<string | null> {
  const path = resolve(root, rel);
  const existing = await readFile(path, "utf8").catch(() => null);
  if (existing === content || (existing !== null && !force)) return null;
  await mkdir(dirname(path), { recursive: true });
  const bak = existing === null ? null : await keepBackup(root, rel, existing);
  await writeFile(path, content, "utf8");
  return bak ? `${rel} replaced; the old one is ${bak}` : null;
}

/**
 * Write a generated file without clobbering: a missing file is written,
 * an identical one left alone, and a different one gets Rivetari's version
 * beside it as `name.rivetari.ext`. With --force it's replaced, and the old
 * one kept as a backup. Returns a note when it did anything but write `rel`.
 */
async function writeBeside(
  root: string,
  rel: string,
  content: string,
  force: boolean | undefined,
): Promise<string | null> {
  if (force) return writeReplacing(root, rel, content, force);
  const path = resolve(root, rel);
  const existing = await readFile(path, "utf8").catch(() => null);
  if (existing === content) return null;
  await mkdir(dirname(path), { recursive: true });
  if (existing === null) {
    await writeFile(path, content, "utf8");
    return null;
  }
  const ext = extname(rel);
  const besideRel = `${rel.slice(0, rel.length - ext.length)}.rivetari${ext}`;
  await writeFile(resolve(root, besideRel), content, "utf8");
  return `${rel} exists; wrote ${besideRel}: merge it by hand`;
}

/**
 * Put Rivetari's hooks into `.claude/settings.json`. A sibling file
 * would be safe but dead, since Claude Code never reads it, so an existing
 * file is merged: its other settings kept, the old one backed up. Only a file
 * that won't parse gets the sibling, and `rivetari doctor` stays red until the
 * hooks are in. Returns a note when it did anything but write a new file.
 */
async function writeSettings(root: string): Promise<string | null> {
  const rel = ".claude/settings.json";
  const path = resolve(root, rel);
  const existing = await readFile(path, "utf8").catch(() => null);
  await mkdir(dirname(path), { recursive: true });
  if (existing === null) {
    await writeFile(path, SETTINGS_JSON, "utf8");
    return null;
  }
  let merged: string;
  try {
    merged = `${JSON.stringify(mergeRivetariHooks(JSON.parse(existing)), null, 2)}\n`;
  } catch (err) {
    const beside = ".claude/settings.rivetari.json";
    await writeFile(resolve(root, beside), SETTINGS_JSON, "utf8");
    return `couldn't merge the hooks into ${rel} (${(err as Error).message}); they're in ${beside}. Merge them by hand: until then the guard is off and \`rivetari doctor\` fails`;
  }
  // Already merged (formatting aside): nothing to back up or rewrite.
  if (
    JSON.stringify(JSON.parse(merged)) === JSON.stringify(JSON.parse(existing))
  )
    return null;
  const bak = await keepBackup(root, rel, existing);
  await writeFile(path, merged, "utf8");
  return `merged Rivetari's hooks into ${rel}; the old one is ${bak} (delete it once you've checked the merge)`;
}

/** Add lines to .rivetari/.gitignore that aren't there yet. */
async function ignoreInRivetari(root: string, lines: string[]): Promise<void> {
  const path = resolve(root, ".rivetari", ".gitignore");
  const text = await readFile(path, "utf8").catch(() => "");
  const have = new Set(text.split(/\r?\n/));
  const add = lines.filter((l) => !have.has(l));
  if (add.length === 0) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${text}${text && !text.endsWith("\n") ? "\n" : ""}${add.join("\n")}\n`,
    "utf8",
  );
}

/** What AGENTS.md and CONSTRAINTS.md say about the repo: stacks and its own commands. */
async function repoFacts(
  root: string,
  draft: ProfileDraft,
): Promise<RepoFacts> {
  const stacks = await detectStacks(buildContext(root)).catch(() => []);
  const commands: RepoFacts["commands"] = {};
  const pkg = await readFile(resolve(root, "package.json"), "utf8")
    .then((t) => JSON.parse(t) as { scripts?: Record<string, string> })
    .catch(() => null);
  if (pkg) {
    const pm = await packageManagerAt(root);
    commands.install = `${pm} install`;
    const scripts = pkg.scripts ?? {};
    for (const [key, names] of [
      ["lint", ["lint"]],
      ["typecheck", ["typecheck", "type-check", "tsc"]],
      ["test", ["test"]],
    ] as const) {
      const name = names.find((n) => scripts[n]);
      if (name) commands[key] = `${pm} run ${name}`;
    }
  }
  return {
    name: draft.name,
    type: draft.type,
    phase: draft.phase,
    stack: draft.stack,
    flags: Object.keys(draft.flags).filter((f) => draft.flags[f]),
    stacks,
    commands,
  };
}

interface ProfileDraft {
  version: 1;
  name: string;
  type: string;
  stack: string[];
  phase?: string;
  flags: Record<string, boolean>;
  "severity-floor": string;
  project?: ProjectDraft;
  floorplan?: boolean;
}

interface ProjectDraft {
  license?: string | undefined;
  owner?: string | undefined;
  "security-contact"?: string | undefined;
}

/**
 * Defaults for the `project:` block from the repo's GitHub remote: the owner
 * handle, and GitHub's private vulnerability reporting as the security contact.
 * No remote means no default — templates then say what to set rather than
 * shipping a placeholder.
 */
async function projectDefaults(root: string): Promise<ProjectDraft> {
  const slug = await resolveRepoSlug(root);
  return {
    license: "MIT",
    ...(slug
      ? {
          owner: `@${slug.owner}`,
          "security-contact": `https://github.com/${slug.owner}/${slug.repo}/security/advisories/new`,
        }
      : {}),
  };
}

function withoutEmpty(project: ProjectDraft): ProjectDraft | undefined {
  const entries = Object.entries(project).filter(([, v]) => Boolean(v));
  return entries.length > 0
    ? (Object.fromEntries(entries) as ProjectDraft)
    : undefined;
}

const splitList = (csv: string): string[] =>
  csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * The profile's `stack`: what the repo's manifests show, then what the person
 * named, mapped onto the stacks it implies (`nextjs` is node). A name that maps
 * onto nothing (`Postgres`) is kept, lower-cased, since the profile's stack is
 * free text. The profile on disk is ignored, so a re-init with --force reflects the
 * repo now rather than the old profile.
 */
async function initStack(root: string, given: string[]): Promise<string[]> {
  const ctx = { ...buildContext(root), profile: () => Promise.resolve(null) };
  const detected = await detectStacks(ctx).catch(() => []);
  const unmapped = given
    .filter((g) => declaredStacks([g]).length === 0)
    .map((g) => g.toLowerCase());
  return [
    ...new Set<string>([...detected, ...declaredStacks(given), ...unmapped]),
  ];
}

async function draftFromFlags(
  flags: InitFlags,
  root: string,
): Promise<ProfileDraft> {
  const defaults = await projectDefaults(root);
  const draft: ProfileDraft = {
    version: 1,
    name: flags.name ?? basename(root),
    type: flags.type ?? "",
    stack: await initStack(root, splitList(flags.stack ?? "")),
    flags: Object.fromEntries((flags.flag ?? []).map((f) => [f, true])),
    "severity-floor": flags.severityFloor ?? "low",
    phase: flags.phase ?? "scaffold",
  };
  const project = withoutEmpty({
    license: flags.license ?? defaults.license,
    owner: flags.owner ?? defaults.owner,
    "security-contact": flags.securityContact ?? defaults["security-contact"],
  });
  if (project) draft.project = project;
  return draft;
}

async function draftInteractive(root: string): Promise<ProfileDraft | null> {
  intro("rivetari init");

  const name = await text({
    message: "Project name",
    initialValue: basename(root),
  });
  if (isCancel(name)) return null;

  const type = await select({
    message: "Project type",
    options: PROJECT_TYPES.map((t) => ({ value: t, label: t })),
  });
  if (isCancel(type)) return null;

  const phase = await select({
    message: "Current phase",
    options: PHASE_KEYS.map((p) => ({ value: p, label: p })),
    initialValue: "scaffold",
  });
  if (isCancel(phase)) return null;

  const stack = await text({
    message: "Stack (comma-separated, optional)",
    placeholder: "typescript, react, postgres",
    defaultValue: "",
  });
  if (isCancel(stack)) return null;

  const chosen = await multiselect({
    message: "Risk flags that apply (space to toggle)",
    options: FLAG_KEYS.map((f) => ({ value: f, label: f })),
    required: false,
  });
  if (isCancel(chosen)) return null;

  const floor = await select({
    message: "Severity floor (ignore controls below this)",
    options: SEVERITIES.map((s) => ({ value: s, label: s })),
    initialValue: "low",
  });
  if (isCancel(floor)) return null;

  const defaults = await projectDefaults(root);
  const license = await text({
    message: "License (SPDX id)",
    initialValue: defaults.license ?? "",
  });
  if (isCancel(license)) return null;

  const owner = await text({
    message: "Code owner (GitHub @handle or @org/team)",
    initialValue: defaults.owner ?? "",
    placeholder: "@your-handle",
  });
  if (isCancel(owner)) return null;

  const contact = await text({
    message: "Where to report vulnerabilities (email or URL)",
    initialValue: defaults["security-contact"] ?? "",
  });
  if (isCancel(contact)) return null;

  const draft: ProfileDraft = {
    version: 1,
    name: String(name),
    type: String(type),
    stack: await initStack(root, splitList(String(stack))),
    phase: String(phase),
    flags: Object.fromEntries((chosen as string[]).map((f) => [f, true])),
    "severity-floor": String(floor),
  };
  const project = withoutEmpty({
    license: String(license).trim(),
    owner: String(owner).trim(),
    "security-contact": String(contact).trim(),
  });
  if (project) draft.project = project;
  return draft;
}

export interface InitOptions extends RunAuditOptions {
  /**
   * How the floorplan is drawn. Offline (`token: null`) skips it unless this
   * is given, since it fetches the pinned skill and calls the model.
   */
  floorplan?: FloorplanOptions | undefined;
  /** Find the commit to pin the Rivetari action to (tests). Default: the GitHub API. */
  resolveActionPin?: (() => Promise<ActionPin>) | undefined;
}

/**
 * The commit rivetari.yml pins the Rivetari action to: --action-ref, else the
 * release this CLI belongs to. Offline there's no way to know it, so that
 * comes back as the reason instead.
 */
async function actionPin(
  root: string,
  flags: InitFlags,
  options: InitOptions,
): Promise<{ pin: ActionPin } | { reason: string }> {
  const given = flags.actionRef ? parseActionRef(flags.actionRef) : null;
  if (given) return { pin: given };
  try {
    if (options.resolveActionPin)
      return { pin: await options.resolveActionPin() };
    if (options.token === null) return { reason: "init ran offline" };
    return {
      pin: await resolveReleasePin({
        token:
          options.token ?? (await githubToken(root).catch(() => null))?.token,
      }),
    };
  } catch (err) {
    return { reason: (err as Error).message };
  }
}

/** Add `line` to the repo's `rel` (.gitignore, .gitattributes) unless it's there. */
async function ensureLine(
  root: string,
  rel: string,
  line: string,
): Promise<void> {
  const path = resolve(root, rel);
  const text = await readFile(path, "utf8").catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return "";
      throw err;
    },
  );
  if (text.split(/\r?\n/).some((l) => l.trim() === line)) return;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  await writeFile(
    path,
    `${text}${text && !text.endsWith("\n") ? eol : ""}${line}${eol}`,
    "utf8",
  );
}

/**
 * "Make me a floorplan": the floorplan skill's map in floorplan/, kept out of
 * git. Never fails init; returns a note for the summary, or null.
 */
async function initFloorplan(
  root: string,
  options: InitOptions,
): Promise<string | null> {
  if (options.token === null && !options.floorplan) return null;
  const dir = resolve(root, FLOORPLAN_DIR);
  const there = await access(dir)
    .then(() => true)
    .catch(() => false);
  if (there && !(await isFloorplanMap(dir)))
    return `${FLOORPLAN_DIR}/ is part of the project, so no floorplan was drawn; set \`floorplan: false\` in the profile`;
  try {
    // The skill can't put the map anywhere else, so git is told to leave it.
    await ensureLine(root, ".gitignore", FLOORPLAN_IGNORE);
    process.stdout.write("Drawing the floorplan (a few minutes)…\n");
    const r = await drawFloorplan(root, options.floorplan);
    return `drew the floorplan: ${FLOORPLAN_DIR}/index.html${floorplanUsage(r)}${r.notes.length > 0 ? ` (${r.notes.join("; ")})` : ""}`;
  } catch (err) {
    return `couldn't draw the floorplan: ${(err as Error).message}. The next merged task's close tries again`;
  }
}

/**
 * `rivetari init`: the profile, Rivetari workflow, and the contract files (the
 * AGENTS.md contract, the /rivetari skill and its hooks, the PR template), the
 * floorplan, then the first audit.
 */
export async function runInit(
  path: string,
  flags: InitFlags,
  options: InitOptions = {},
): Promise<number> {
  const root = resolve(path);

  const profileExists = await access(resolve(root, ".rivetari", "profile.yml"))
    .then(() => true)
    .catch(() => false);
  if (profileExists && !flags.force) {
    console.error(
      "rivetari init: .rivetari/profile.yml already exists. Use --force to overwrite, or `rivetari profile set`.",
    );
    return 1;
  }

  if (flags.actionRef !== undefined && !parseActionRef(flags.actionRef)) {
    console.error(
      `rivetari init: --action-ref takes a 40-hex commit SHA of ${ACTION_REPO}, optionally followed by :<tag>, not "${flags.actionRef}".`,
    );
    return 1;
  }

  const interactive =
    !flags.yes && !flags.type && process.stdout.isTTY === true;

  let draft: ProfileDraft | null;
  if (interactive) {
    draft = await draftInteractive(root);
    if (!draft) {
      cancel("Cancelled.");
      return 1;
    }
  } else {
    draft = await draftFromFlags(flags, root);
    if (!draft.type) {
      console.error(
        `rivetari init: --type is required in non-interactive mode (one of: ${PROJECT_TYPES.join(", ")}).`,
      );
      return 1;
    }
  }

  // --force never deletes. The profile it replaces is backed up first.
  const beside: string[] = [];
  const profileRel = ".rivetari/profile.yml";
  const oldProfile = profileExists
    ? await readFile(resolve(root, profileRel), "utf8")
    : null;
  // New inits keep a floorplan; a re-init keeps what the profile said.
  if (oldProfile === null) draft.floorplan = true;
  else {
    const old = (() => {
      try {
        return (parseYaml(oldProfile) as { floorplan?: unknown } | null)
          ?.floorplan;
      } catch {
        return undefined;
      }
    })();
    if (typeof old === "boolean") draft.floorplan = old;
  }
  // Backed up before it's overwritten, so a failed save can't lose it; a
  // backup of a profile that came out identical is removed again.
  const bak =
    oldProfile === null ? null : await keepBackup(root, profileRel, oldProfile);
  try {
    await saveProfile(root, draft);
  } catch (err) {
    console.error(err instanceof ProfileError ? err.message : String(err));
    return 1;
  }
  if (bak) {
    if ((await readFile(resolve(root, profileRel), "utf8")) === oldProfile)
      await rm(resolve(root, bak));
    else beside.push(`${profileRel} replaced; the old one is ${bak}`);
  }

  // Waivers and evidence are a person's decisions: written when missing, and
  // never reset, --force or not.
  for (const rel of [".rivetari/waivers.yml", ".rivetari/evidence.yml"])
    await writeFile(resolve(root, rel), "[]\n", { flag: "wx" }).catch(
      (err: NodeJS.ErrnoException) => {
        if (err.code !== "EEXIST") throw err;
      },
    );
  await writeFile(
    resolve(root, BANNED_PATH),
    `${JSON.stringify({ version: 1, patterns: defaultsFor(draft.stack) }, null, 2)}\n`,
    { flag: "wx" },
  ).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "EEXIST") throw err;
  });
  const pinned = await actionPin(root, flags, options);
  const pin = "pin" in pinned ? pinned.pin : null;
  const workflowRel = ".github/workflows/rivetari.yml";
  const workflowText = renderRivetariWorkflow(draft.phase ?? "build", pin);
  const oldWorkflow = await readIfThere(resolve(root, workflowRel));
  // An unpinned rivetari.yml is init's own placeholder: a pin replaces it.
  const workflow =
    pin && oldWorkflow !== null && isUnpinnedWorkflow(oldWorkflow)
      ? await writeFile(resolve(root, workflowRel), workflowText, "utf8").then(
          () => null,
        )
      : await writeBeside(root, workflowRel, workflowText, false);
  if ("reason" in pinned)
    beside.push(
      `couldn't pin the Rivetari action to a commit (${pinned.reason}), so ${workflowRel} fails until it's pinned: run \`rivetari init --force --action-ref <sha>\` with the commit of a ${ACTION_REPO} release, or set the step as the file says`,
    );
  if (workflow)
    beside.push(
      `${workflow}, then delete it (every file in .github/workflows runs on GitHub, so don't commit it)`,
    );

  // Rivetari's state is hashed and diffed byte for byte; a Windows checkout
  // with autocrlf would otherwise rewrite it with CRLF.
  await ensureLine(root, ".gitattributes", ".rivetari/** text eol=lf");

  // Backups init leaves under .rivetari/ are for the person to look at, not commit.
  await ignoreInRivetari(root, [
    "tasks/",
    "ai-usage.log",
    "cache/",
    "history.jsonl",
    "*.bak",
    "*.bak.*",
  ]);

  // The contract, the /rivetari skill, the hooks, the PR template.
  const facts = await repoFacts(root, draft);
  // A CLAUDE.md that's a link (often to AGENTS.md itself) already does what
  // the pointer does, and writing it would write through the link.
  const claudeLinked = await lstat(resolve(root, "CLAUDE.md")).then(
    (s) => s.isSymbolicLink(),
    () => false,
  );
  const oldClaude = claudeLinked
    ? null
    : await readIfThere(resolve(root, "CLAUDE.md"));
  // Rules an earlier init moved stay in AGENTS.md when --force renders it
  // again, with anything added to CLAUDE.md since after them.
  const fromClaude =
    oldClaude === null || oldClaude === CLAUDE_MD
      ? null
      : houseRulesFrom(oldClaude);
  const moved = movedRulesIn(
    (await readIfThere(resolve(root, "AGENTS.md"))) ?? "",
  );
  const houseRules =
    moved && fromClaude && !moved.includes(fromClaude)
      ? `${moved}\n\n${fromClaude}`
      : (moved ?? fromClaude);
  facts.houseRules = houseRules ?? undefined;
  const agents = renderAgentsMd(facts);
  // The skill ships with the CLI; a broken install shouldn't stop init.
  const skill = await readFile(
    join(bundledSkillDir(), "SKILL.md"),
    "utf8",
  ).catch(() => null);
  const files: [string, string][] = [
    ["AGENTS.md", agents],
    ["CONSTRAINTS.md", renderConstraintsMd(facts)],
    [".github/PULL_REQUEST_TEMPLATE.md", PR_TEMPLATE],
    ...(skill
      ? [[".claude/skills/rivetari/SKILL.md", skill] as [string, string]]
      : []),
  ];
  if (!skill)
    beside.push(
      "the /rivetari skill couldn't be read from the CLI install; reinstall the CLI",
    );
  for (const [rel, content] of files) {
    const note = await writeBeside(root, rel, content, flags.force);
    if (note) beside.push(note);
  }
  // A CLAUDE.md of the repo's own is replaced by the pointer once its rules
  // are in the AGENTS.md init wrote; one beside theirs is theirs to merge.
  const agentsWritten =
    (await readIfThere(resolve(root, "AGENTS.md"))) === agents;
  if (claudeLinked) {
    // Left as it is: see above.
  } else if (oldClaude !== null && oldClaude !== CLAUDE_MD && agentsWritten) {
    // An earlier init's pointer has nothing to keep; anything else is backed up.
    if (fromClaude) {
      const bak = await keepBackup(root, "CLAUDE.md", oldClaude);
      beside.push(
        `moved the rules in CLAUDE.md into AGENTS.md's "This repo" section, where every agent reads them; CLAUDE.md now points at AGENTS.md (the old one is ${bak}; delete it once you've checked the move)`,
      );
    }
    await writeFile(resolve(root, "CLAUDE.md"), CLAUDE_MD, "utf8");
  } else {
    const note = await writeBeside(root, "CLAUDE.md", CLAUDE_MD, flags.force);
    if (note) beside.push(note);
  }
  const settings = await writeSettings(root);
  if (settings) beside.push(settings);

  // The spine skills, locked; `rivetari skills sync` installs them.
  let locked = "";
  try {
    const added = await initLock(root, { spineOnly: true });
    if (added.length > 0)
      locked = ` Locked the spine skills (${added.map((e) => e.name).join(", ")}); run \`rivetari skills sync\`.`;
  } catch (err) {
    locked = ` Couldn't lock the spine skills: ${(err as Error).message}`;
  }

  if (draft.floorplan) {
    const floorplan = await initFloorplan(root, options);
    if (floorplan) beside.push(floorplan);
  }

  const wrote = `Wrote .rivetari/, AGENTS.md, CLAUDE.md, CONSTRAINTS.md, the /rivetari skill and hooks under .claude/, .github/ (rivetari.yml, the PR template) and a .gitattributes line keeping .rivetari/ LF.${locked} Commit them to the default branch before the first task: the agent and the judge read the contract from there.`;
  const notes = beside.map((b) => `  - ${b}`).join("\n");
  if (interactive) {
    outro(`${wrote}${notes ? `\n${notes}` : ""} Running first audit…`);
  } else {
    process.stdout.write(
      `${wrote}\n${notes ? `${notes}\n` : ""}Running first audit…\n\n`,
    );
  }

  return runAudit(root, {}, options);
}
