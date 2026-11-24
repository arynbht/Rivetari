// The Project view's read: profile.yml held against what the repo shows now,
// with the autonomy, proof, skills and banned patterns it records. The repo is
// read with init's own detectors (the stack, the package manager, the project
// type) and the engine's flag inference, and the phase comes from the audit
// state.json records through the lens Posture uses, so nothing here works out
// a second answer to a question the CLI already answers. It's all local file
// reads: no model, no network, so it can run on every repo open for free.
// Kept free of any electron import so it unit-tests as plain functions.
import { basename } from "node:path";

import {
  FLAG_KEYS,
  loadBundledGates,
  type Profile,
} from "@arynbht/rivetari-catalog";
import {
  buildContext,
  declaredStacks,
  detectStacks,
  type InferredFlag,
  inferFlags,
  inferProjectType,
  loadProfile,
  type PackageManager,
  packageManagerAt,
  readRecordedAudit,
  type Stack,
} from "@arynbht/rivetari-engine";
import {
  AUTONOMY_DIR,
  autonomyEntries,
  autonomyLedger,
  loadBanned,
  parseAssembly,
  readLock,
  readState,
  skillsStatus,
  type TaskView,
} from "@arynbht/rivetari-runtime";

import type {
  ProjectField,
  ProjectGap,
  ProjectSkill,
  ProjectView,
} from "../../shared/ipc";
import { bundledControls } from "./audit";
import { postureLens } from "./posture";

export const PROFILE_PATH = ".rivetari/profile.yml";

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** What the repo shows now, read the way init reads it. */
export interface Detected {
  /** package.json's name without its scope, else the folder's. */
  name: string;
  type: string | null;
  stacks: Stack[];
  /** Null when there's no package.json to have one. */
  packageManager: PackageManager | null;
  flags: InferredFlag[];
  /** Null when no audit is recorded to infer a phase from. */
  phase: { inferred: string | null; recordedAt: string | null } | null;
}

async function readPackageName(repoPath: string): Promise<string | null> {
  const text = await buildContext(repoPath).readFile("package.json");
  if (text === null) return null;
  try {
    const name = (JSON.parse(text) as { name?: unknown }).name;
    return typeof name === "string" && name
      ? name.replace(/^@[^/]+\//, "")
      : null;
  } catch {
    // A package.json that won't parse names nothing.
    return null;
  }
}

export async function detectProject(
  repoPath: string,
  profile: Profile | null,
): Promise<Detected> {
  // The profile's own stack is left out, as init leaves it out on a re-init,
  // so the stacks are what the manifests show and nothing else.
  const ctx = {
    ...buildContext(repoPath),
    profile: () => Promise.resolve(null),
  };
  const [packageName, type, stacks, flags, recorded] = await Promise.all([
    readPackageName(repoPath),
    inferProjectType(repoPath),
    detectStacks(ctx),
    inferFlags(ctx),
    readRecordedAudit(repoPath),
  ]);
  const packageManager =
    (await ctx.readFile("package.json")) === null
      ? null
      : await packageManagerAt(repoPath);
  let phase: Detected["phase"] = null;
  if (recorded) {
    const [controls, bundled] = await Promise.all([
      bundledControls(),
      loadBundledGates(),
    ]);
    // A gate that didn't load would move the inferred phase, as in Posture.
    if (bundled.errors.length > 0)
      throw new Error(
        `Gate catalog is invalid: ${bundled.errors[0]?.message ?? "unknown error"}`,
      );
    phase = {
      inferred: postureLens(
        recorded,
        controls,
        bundled.gates,
        profile?.phase ?? null,
      ).inferredPhase,
      recordedAt: recorded.generatedAt,
    };
  }
  return {
    name: packageName ?? basename(repoPath),
    type,
    stacks,
    packageManager,
    flags,
    phase,
  };
}

const list = (items: readonly string[]) =>
  items.length > 0 ? items.join(", ") : "none";

const RUNNER = /^(npm|pnpm|yarn)(?=\s|$)/;

/**
 * Each field Rivetari can read from the repo, profile.yml's value beside the
 * repo's, and the change that brings the profile in line where they differ.
 * A field the repo says nothing about (no manifest to read a type from, no
 * audit to infer a phase from) is shown, never counted as a difference.
 */
export function projectFields(
  profile: Profile | null,
  detected: Detected,
): ProjectField[] {
  const row = (
    field: Omit<ProjectField, "differs" | "change">,
    change: ProjectField["change"],
  ): ProjectField => ({ ...field, differs: change !== null, change });
  const fields: ProjectField[] = [];

  const declaredName = profile?.name ?? null;
  fields.push(
    row(
      {
        key: "name",
        label: "Name",
        declared: declaredName,
        detected: detected.name,
        evidence: null,
      },
      declaredName !== null &&
        declaredName.toLowerCase() !== detected.name.toLowerCase()
        ? { path: "name", from: declaredName, to: detected.name }
        : null,
    ),
  );

  const declaredType = profile?.type ?? null;
  fields.push(
    row(
      {
        key: "type",
        label: "Type",
        declared: declaredType,
        detected: detected.type,
        evidence:
          detected.type === null
            ? "No manifest at the root says what kind of project this is."
            : null,
      },
      declaredType !== null &&
        detected.type !== null &&
        detected.type !== declaredType
        ? { path: "type", from: declaredType, to: detected.type }
        : null,
    ),
  );

  // The profile's stack is free text (`react`, `postgres`); what counts is
  // the stacks it implies. A detected stack it doesn't imply is missing, and
  // an entry whose stacks the repo doesn't show is stale. Text that implies no
  // stack is kept: nothing on disk can say it's wrong. With nothing detected
  // (an empty repo), the profile is the only word and stays as it is.
  const declaredStack = profile?.stack ?? [];
  const implied = declaredStacks(declaredStack);
  const missing = detected.stacks.filter((s) => !implied.includes(s));
  const stale =
    detected.stacks.length === 0
      ? []
      : declaredStack.filter((entry) => {
          const stacks = declaredStacks([entry]);
          return (
            stacks.length > 0 &&
            !stacks.some((s) => detected.stacks.includes(s))
          );
        });
  const toStack = [
    ...declaredStack.filter((e) => !stale.includes(e)),
    ...missing,
  ];
  fields.push(
    row(
      {
        key: "stack",
        label: "Stack",
        declared: profile ? list(declaredStack) : null,
        detected: detected.stacks.length > 0 ? list(detected.stacks) : null,
        evidence:
          [
            missing.length > 0
              ? `The manifests show ${list(missing)}, which profile.yml doesn't name.`
              : null,
            stale.length > 0
              ? `Nothing in the repo shows ${list(stale)}.`
              : null,
            detected.stacks.length === 0
              ? "No manifest the stack detector knows was found."
              : null,
          ]
            .filter(Boolean)
            .join(" ") || null,
      },
      profile && (missing.length > 0 || stale.length > 0)
        ? { path: "stack", from: list(declaredStack), to: list(toStack) }
        : null,
    ),
  );

  // profile.yml names a package manager only in the command proof serves the
  // app with, so that's what's held against the repo's.
  const start = profile?.proof?.start ?? null;
  const declaredPm = start ? (RUNNER.exec(start)?.[1] ?? null) : null;
  fields.push(
    row(
      {
        key: "package-manager",
        label: "Package manager",
        declared: declaredPm,
        detected: detected.packageManager,
        evidence:
          declaredPm === null
            ? detected.packageManager === null
              ? "There's no package.json."
              : "profile.yml names none (proof.start would)."
            : `From proof.start: ${start}`,
      },
      start &&
        declaredPm &&
        detected.packageManager &&
        declaredPm !== detected.packageManager
        ? {
            path: "proof.start",
            from: start,
            to: start.replace(RUNNER, detected.packageManager),
          }
        : null,
    ),
  );

  const declaredPhase = profile?.phase ?? null;
  const inferred = detected.phase?.inferred ?? null;
  fields.push(
    row(
      {
        key: "phase",
        label: "Phase",
        declared: declaredPhase,
        detected: inferred,
        evidence: detected.phase
          ? `Where the controls in the audit recorded ${
              detected.phase.recordedAt
                ? detected.phase.recordedAt.slice(0, 10)
                : "in state.json"
            } put the repo.`
          : "No audit is recorded yet; `rivetari audit` records one to infer the phase from.",
      },
      profile && inferred !== null && inferred !== declaredPhase
        ? { path: "phase", from: declaredPhase ?? "not set", to: inferred }
        : null,
    ),
  );

  // Only a flag the repo shows is suggested. One profile.yml sets that the
  // repo doesn't show stays: a risk flag comes off when a person says so.
  for (const flag of [
    "uses-ai",
    "open-source",
    "distributes-binaries",
  ] as const) {
    const set = profile?.flags[flag];
    const shown = detected.flags.find((f) => f.flag === flag);
    fields.push(
      row(
        {
          key: `flags.${flag}`,
          label: `Flag: ${flag}`,
          declared: profile
            ? set === true
              ? "set"
              : set === false
                ? "false"
                : "not set"
            : null,
          detected: shown ? "shown" : "not shown",
          evidence:
            shown?.evidence ??
            (set === true
              ? "Nothing in the repo shows it; a person decides when it comes off."
              : null),
        },
        profile && shown && set !== true
          ? {
              path: `flags.${flag}`,
              from: set === false ? "false" : "not set",
              to: "true",
            }
          : null,
      ),
    );
  }
  return fields;
}

/** The flags profile.yml sets that no file can show, in FLAG_KEYS order. */
export function otherFlags(profile: Profile | null): string[] {
  const inferable = new Set(["uses-ai", "open-source", "distributes-binaries"]);
  return FLAG_KEYS.filter(
    (f) => !inferable.has(f) && profile?.flags[f] === true,
  );
}

/** The part of the view that's checked, and held until it's due again. */
export interface ProjectCheck {
  repoPath: string;
  checkedAt: string;
  profileFound: boolean;
  fields: ProjectField[];
  otherFlags: string[];
  problems: string[];
}

/** Hold profile.yml against the repo now. */
export async function checkProject(
  repoPath: string,
  now: Date = new Date(),
): Promise<ProjectCheck> {
  const problems: string[] = [];
  const profile = await loadProfile(repoPath).catch((err: unknown) => {
    problems.push(`profile.yml: ${message(err)}`);
    return null;
  });
  if (!profile && problems.length === 0)
    problems.push(
      "There's no .rivetari/profile.yml; `rivetari init` writes one.",
    );
  const detected = await detectProject(repoPath, profile);
  return {
    repoPath,
    checkedAt: now.toISOString(),
    profileFound: profile !== null,
    fields: projectFields(profile, detected),
    otherFlags: otherFlags(profile),
    problems,
  };
}

/**
 * The autonomy ledger's entries, read without the repair `ladder()` makes:
 * the ledger is verified (its chain and seals) and its entries parsed, and
 * nothing is written. A ledger.md that no longer matches its jsonl is said,
 * since only the jsonl is sealed; `rivetari autonomy` re-renders it.
 */
export async function readAutonomy(
  repoPath: string,
  configured: string | null,
): Promise<ProjectView["autonomy"]> {
  try {
    const ledger = await autonomyLedger(repoPath);
    const check = await ledger.verify();
    const viewOnly = check.problems.every((p) => p.startsWith("ledger.md was"));
    if (!check.ok && !viewOnly)
      return {
        configured,
        entries: [],
        problems: check.problems.map(
          (p) => `${AUTONOMY_DIR}/ledger.jsonl doesn't verify: ${p}`,
        ),
      };
    return {
      configured,
      entries: await autonomyEntries(repoPath),
      problems: check.ok
        ? []
        : [
            `${AUTONOMY_DIR}/ledger.md doesn't match ledger.jsonl; \`rivetari autonomy\` re-renders it.`,
          ],
    };
  } catch (err) {
    return {
      configured,
      entries: [],
      problems: [`The autonomy ledger can't be read: ${message(err)}`],
    };
  }
}

/** A route's gap text, split into its sector and the router's reason. */
export function parseGap(text: string): {
  sector: string | null;
  reason: string;
} {
  const m = /^([a-z0-9-]+): (.+)$/.exec(text);
  return m
    ? { sector: m[1] ?? null, reason: m[2] ?? text }
    : { sector: null, reason: text };
}

/** Every gap the tasks' routes hit, each once, with the tasks that hit it. */
export function routeGaps(views: TaskView[]): ProjectGap[] {
  const byText = new Map<string, ProjectGap>();
  const newestFirst = [...views].sort((a, b) => b.id.localeCompare(a.id));
  for (const view of newestFirst) {
    if (view.assemblyText === undefined) continue;
    for (const text of parseAssembly(view.assemblyText).assembly?.gaps ?? []) {
      const gap = byText.get(text) ?? { ...parseGap(text), tasks: [] };
      if (!gap.tasks.includes(view.id)) gap.tasks.push(view.id);
      byText.set(text, gap);
    }
  }
  return [...byText.values()];
}

/** The skills lock, each skill's state after the last sync, and the gaps. */
export async function readSkills(
  repoPath: string,
  views: TaskView[],
): Promise<ProjectView["skills"]> {
  const gaps = routeGaps(views);
  try {
    const [lock, state, problems] = await Promise.all([
      readLock(repoPath),
      readState(repoPath),
      skillsStatus(repoPath),
    ]);
    const explained = new Set<string>();
    const about = (name: string) =>
      problems.find(
        (p) =>
          p.startsWith(`${name} is `) || p.includes(`/${name} was modified`),
      );
    const locked: ProjectSkill[] = lock.skills.map((entry) => {
      const synced = state?.skills.find((s) => s.name === entry.name);
      const blocked = state?.blocked.find((b) => b.name === entry.name);
      const problem = about(entry.name);
      if (problem) explained.add(problem);
      const skill = {
        name: entry.name,
        source: entry.source,
        pin: entry.pin,
        scope: entry.scope,
      };
      if (blocked)
        return { ...skill, state: "blocked", detail: blocked.reason };
      if (entry.scope === "task")
        return {
          ...skill,
          state: "per-task",
          detail: "fetched when a route picks it",
        };
      if (problem?.includes("was modified"))
        return { ...skill, state: "modified", detail: problem };
      if (synced?.installed && !problem)
        return { ...skill, state: "installed", detail: null };
      return {
        ...skill,
        state: "not-installed",
        detail: problem ?? "not installed by the last sync",
      };
    });
    return {
      locked,
      installed: state?.skills.filter((s) => s.installed).length ?? 0,
      syncedAt: state?.syncedAt ?? null,
      problems: problems.filter((p) => !explained.has(p)),
      gaps,
      error: null,
    };
  } catch (err) {
    return {
      locked: [],
      installed: 0,
      syncedAt: null,
      problems: [],
      gaps,
      error: message(err),
    };
  }
}

/**
 * The records the view shows beside the check, read fresh each time: they're
 * the runtime's own, so there's nothing to hold.
 */
export async function readRecords(
  repoPath: string,
  views: TaskView[],
): Promise<
  Pick<ProjectView, "autonomy" | "proof" | "skills" | "banned" | "openTask">
> {
  const profile = await loadProfile(repoPath).catch(() => null);
  const proof = profile?.proof;
  const banned = await loadBanned(repoPath).then(
    (list) => ({
      patterns: list.patterns.map((p) => ({
        id: p.id,
        pattern: p.pattern,
        files: p.files,
        why: p.why,
        source: p.source,
      })),
      error: null,
    }),
    (err: unknown) => ({
      patterns: [],
      error: `.rivetari/banned.json can't be read: ${message(err)}`,
    }),
  );
  const open = views.find(
    (v) => !v.done && v.card?.touches.includes(PROFILE_PATH),
  );
  return {
    autonomy: await readAutonomy(repoPath, profile?.autonomy ?? null),
    proof: proof
      ? {
          start: proof.start ?? null,
          url: proof.url ?? null,
          readyTimeout: proof.ready_timeout ?? null,
          auth: proof.auth !== undefined,
        }
      : null,
    skills: await readSkills(repoPath, views),
    banned,
    openTask: open ? { id: open.id, title: open.title } : null,
  };
}
