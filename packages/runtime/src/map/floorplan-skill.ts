// The floorplan skill (haydenschmitty/floorplan, pinned in the registry): an
// interactive map of the codebase in floorplan/ at the repo root. Not the
// engine's deep-audit "Floor Plan" (packages/engine/src/floorplan/), which is
// a different thing with a similar name.
//
// Rivetari drives the skill's unattended workflow (its workflow.json) itself:
// the runtime runs the skill's offline scripts, the model only answers each
// job with one JSON object through the build agent's transport, read-only, and
// the runtime writes the answer. The map's server (serve.mjs, started by
// open.mjs) is the only part of the skill that reaches the network, so it's
// never run from here.
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  agentEnv,
  appendUsage,
  extractJson,
  loadProfile,
} from "@arynbht/rivetari-engine";
import {
  activeAllows,
  ensureCached,
  licenseProblem,
  loadManifests,
  loadSkill,
  readLock,
  scanSkill,
} from "@arynbht/rivetari-registry";

import {
  type AgentReply,
  type AgentRunner,
  claudeAgent,
  usageNote,
} from "../agent/build.js";

export const FLOORPLAN_SKILL = "floorplan";
/** Where the skill puts the map. Its scripts can't be pointed anywhere else. */
export const FLOORPLAN_DIR = "floorplan";
/** The line `rivetari init` adds to the repo's .gitignore, anchored so a nested floorplan/ is left alone. */
export const FLOORPLAN_IGNORE = `/${FLOORPLAN_DIR}/`;

/**
 * The only scripts Rivetari runs. Each reads the repo and writes inside
 * floorplan/, with no network; open.mjs and serve.mjs are left out on purpose.
 */
export const FLOORPLAN_SCRIPTS = [
  "status.mjs",
  "scan.mjs",
  "build.mjs",
  "describe.mjs",
  "refresh.mjs",
  "recent.mjs",
] as const;
export type FloorplanScript = (typeof FLOORPLAN_SCRIPTS)[number];

export class FloorplanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FloorplanError";
  }
}

export interface ScriptResult {
  ok: boolean;
  /** The script's one JSON object (every script runs with --json), or {}. */
  json: Record<string, unknown>;
  stderr: string;
}

export type ScriptRunner = (
  skillDir: string,
  root: string,
  script: FloorplanScript,
) => Promise<ScriptResult>;

export interface FloorplanOptions {
  /** The model transport (default: the build agent's `claude -p`). */
  agent?: AgentRunner | undefined;
  model?: string | undefined;
  /** The skill directory (default: the pinned skill, hash-checked and scanned). */
  skillDir?: string | undefined;
  runScript?: ScriptRunner | undefined;
  log?: ((line: string) => void) | undefined;
  now?: Date | undefined;
}

export interface FloorplanResult {
  /** A first map, or a refresh of the one that was there. */
  made: "first" | "refresh";
  calls: number;
  tokens: number;
  costUsd: number;
  notes: string[];
}

/** The profile's switch: absent (every repo from before the flag) is off. */
export const floorplanEnabled = (
  profile: { floorplan?: boolean | undefined } | null | undefined,
): boolean => profile?.floorplan === true;

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * True for a folder holding a map, so a project's own folder that happens to
 * be called floorplan/ is never taken for one (the skill uses the same test).
 */
export async function isFloorplanMap(dir: string): Promise<boolean> {
  for (const f of ["architecture.json", "plan.json", "graph.json", ".cache"])
    if (await exists(join(dir, f))) return true;
  return false;
}

/**
 * The pinned skill's directory: the lock's entry when the repo locked it,
 * else the shipped manifest's pin, verified against its hash and scanned the
 * way `rivetari skills sync` scans, so a dirty scan fails closed here too.
 */
export async function floorplanSkillDir(repoPath: string): Promise<string> {
  const { manifests } = await loadManifests(repoPath);
  const manifest = manifests.get(FLOORPLAN_SKILL);
  if (!manifest)
    throw new FloorplanError("no manifest for the floorplan skill");
  const license = licenseProblem(manifest);
  if (license) throw new FloorplanError(license);
  const entry = (await readLock(repoPath)).skills.find(
    (s) => s.name === FLOORPLAN_SKILL,
  );
  const dir = entry
    ? (await loadSkill(repoPath, entry, {})).dir
    : (await ensureCached(manifest, manifest.hash)).dir;
  const findings = await scanSkill(
    dir,
    activeAllows(manifest, entry?.pin ?? manifest.pin),
  );
  if (findings.length > 0)
    throw new FloorplanError(
      `the skill scan found ${findings.length} problem(s): ${findings
        .map((f) => `${f.rule} ${f.file}:${f.line}`)
        .join(", ")}`,
    );
  return dir;
}

/** The scripts get no tokens or keys: they read the repo and need none. */
function scriptEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (!/TOKEN|SECRET|PASSWORD|API_KEY|_KEY$/i.test(key)) env[key] = value;
  return {
    ...env,
    // Unattended: nothing written outside floorplan/, and failures fail.
    FLOORPLAN_UNATTENDED: "1",
    FLOORPLAN_AGENT: "none",
    FLOORPLAN_NO_PROMPTS: "1",
  };
}

const SCRIPT_TIMEOUT_MS = 10 * 60_000;

/**
 * Run one of the offline scripts with --json --unattended, from the repo
 * root, the skill's path passed as an argument. Anything else is refused.
 */
export const runFloorplanScript: ScriptRunner = (skillDir, root, script) => {
  if (!(FLOORPLAN_SCRIPTS as readonly string[]).includes(script))
    return Promise.reject(
      new FloorplanError(
        `${String(script)} isn't one of floorplan's offline scripts; Rivetari never runs it`,
      ),
    );
  return new Promise((done) => {
    execFile(
      process.execPath,
      [join(skillDir, "scripts", script), root, "--json", "--unattended"],
      {
        cwd: root,
        env: scriptEnv(),
        windowsHide: true,
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: 256 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        let json: Record<string, unknown> = {};
        try {
          json = JSON.parse(stdout) as Record<string, unknown>;
        } catch {
          // No JSON: the errors below say why.
        }
        if (err && !Array.isArray(json.errors))
          json = { ...json, errors: [String(stderr || err.message).trim()] };
        done({ ok: !err, json, stderr: String(stderr) });
      },
    );
  });
};

interface Job {
  read?: string[];
  input?: { name: string; from?: string; file?: string; optional?: boolean }[];
  instructions: string[];
  writes: string;
  set?: Record<string, string>;
}

interface Workflow {
  conventions?: { answerRetries?: number };
  jobs: Record<string, Job>;
}

const SYSTEM = [
  "You are doing one step of drawing a map of this codebase, following the floorplan skill's unattended workflow for Rivetari.",
  "You can read and search files; you can't change anything, run anything else or ask anyone. Where the instructions name read_file, list_files or grep, use Read, Glob and Grep.",
  "Where they say submit, reply with ONLY that one JSON object: no prose before or after it.",
].join("\n");

const oneLine = (text: string, max = 300) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

const errorsOf = (r: ScriptResult) =>
  Array.isArray(r.json.errors) ? r.json.errors.map(String).join("; ") : "";

class Run {
  readonly saved: Record<string, unknown> = {};
  readonly result: FloorplanResult;
  private readonly agent: AgentRunner;
  private readonly runScript: ScriptRunner;
  private readonly log: (line: string) => void;
  readonly now: Date;

  constructor(
    readonly root: string,
    readonly skillDir: string,
    readonly workflow: Workflow,
    readonly options: FloorplanOptions,
  ) {
    this.agent = options.agent ?? claudeAgent;
    this.runScript = options.runScript ?? runFloorplanScript;
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? new Date();
    this.result = { made: "first", calls: 0, tokens: 0, costUsd: 0, notes: [] };
  }

  async script(name: FloorplanScript, save?: string): Promise<ScriptResult> {
    const r = await this.runScript(this.skillDir, this.root, name);
    if (save) this.saved[save] = r.json;
    return r;
  }

  /** {a.b} from a saved result, or {now}. */
  private template(s: string): string {
    return s.replace(/\{([\w.]+)\}/g, (_, path: string) =>
      path === "now" ? this.now.toISOString() : String(this.lookup(path) ?? ""),
    );
  }

  private lookup(path: string): unknown {
    let at: unknown = this.saved;
    for (const key of path.split(".")) {
      if (typeof at !== "object" || at === null) return undefined;
      at = (at as Record<string, unknown>)[key];
    }
    return at;
  }

  /** A path the skill names for a job to read or write, kept inside floorplan/. */
  private inMap(rel: string): string {
    const abs = resolve(this.root, rel);
    const r = relative(join(this.root, FLOORPLAN_DIR), abs);
    if (r === "" || r.startsWith("..") || isAbsolute(r))
      throw new FloorplanError(`refusing ${rel}: it's outside floorplan/`);
    return abs;
  }

  /** One model job: its references and inputs in, one JSON object out, written by us. */
  async job(name: string): Promise<void> {
    const job = this.workflow.jobs[name];
    if (!job) throw new FloorplanError(`the skill has no ${name} job`);
    const parts: string[] = [];
    for (const rel of job.read ?? [])
      parts.push(
        `# ${rel}\n${await readFile(join(this.skillDir, ...rel.split("/")), "utf8")}`,
      );
    for (const input of job.input ?? []) {
      const value = input.from
        ? this.lookup(input.from)
        : input.file
          ? await readFile(this.inMap(this.template(input.file)), "utf8").catch(
              () => undefined,
            )
          : undefined;
      if (value === undefined || value === "") {
        if (input.optional) continue;
        throw new FloorplanError(`${name}: no ${input.name}`);
      }
      parts.push(
        `# ${input.name}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`,
      );
    }
    const system = [SYSTEM, ...job.instructions].join("\n");
    const prompt = parts.join("\n\n");
    const retries = this.workflow.conventions?.answerRetries ?? 2;
    let problem = "";
    for (let attempt = 0; ; attempt++) {
      const reply = await this.ask(
        name,
        system,
        problem
          ? `${prompt}\n\n# Your last reply\nIt wasn't one JSON object (${problem}). Reply with only the object.`
          : prompt,
      );
      try {
        const answer = extractJson(reply.text);
        if (
          typeof answer !== "object" ||
          answer === null ||
          Array.isArray(answer)
        )
          throw new Error("not a JSON object");
        const out = answer as Record<string, unknown>;
        for (const [k, v] of Object.entries(job.set ?? {}))
          out[k] = this.template(v);
        const path = this.inMap(this.template(job.writes));
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${JSON.stringify(out, null, 2)}\n`, "utf8");
        return;
      } catch (err) {
        if (err instanceof FloorplanError || attempt >= retries) throw err;
        problem = (err as Error).message;
      }
    }
  }

  /** One call through the transport, its usage logged where `rivetari ai usage` reads it. */
  private async ask(
    job: string,
    system: string,
    prompt: string,
  ): Promise<AgentReply> {
    const raw = await this.agent({
      mode: "plan",
      system,
      prompt,
      cwd: this.root,
      model: this.options.model,
      env: agentEnv(),
    });
    const reply: AgentReply = typeof raw === "string" ? { text: raw } : raw;
    this.result.calls++;
    this.result.tokens += reply.tokens ?? 0;
    this.result.costUsd += reply.costUsd ?? 0;
    this.log(`floorplan ${job}${usageNote(reply)}`);
    await mkdir(join(this.root, ".rivetari"), { recursive: true });
    await appendUsage(this.root, {
      date: this.now.toISOString().slice(0, 10),
      task: `floorplan:${job}`,
      model: this.options.model ?? "claude",
      // The CLI reports one total, cache included; it's counted as input.
      inputTokens: reply.tokens ?? 0,
      outputTokens: 0,
      costUsd: reply.costUsd ?? 0,
    });
    return reply;
  }

  build(): Promise<ScriptResult> {
    return this.script("build.mjs", "build");
  }

  /** The latest build's result. */
  get built(): BuildJson {
    return (this.saved.build ?? {}) as BuildJson;
  }
}

interface BuildJson {
  ok?: boolean;
  errors?: unknown[];
  files?: { unassignedPercent?: number };
  descriptions?: { complete?: boolean };
}

/** A first map: scan, architecture until it builds, descriptions, cleared recent work. */
async function firstMap(run: Run): Promise<void> {
  const scan = await run.script("scan.mjs", "scan");
  if (!scan.ok) throw new FloorplanError(`scan failed: ${errorsOf(scan)}`);
  for (let attempt = 0; attempt < 3; attempt++) {
    await run.job("architecture");
    await run.build();
    if (run.built.ok && (run.built.files?.unassignedPercent ?? 0) < 10) break;
  }
  if (!run.built.ok)
    throw new FloorplanError(
      `architecture.json still doesn't build: ${(run.built.errors ?? []).map(String).join("; ")}`,
    );
  if ((run.built.files?.unassignedPercent ?? 0) >= 10)
    run.result.notes.push(
      `${run.built.files?.unassignedPercent}% of files sit in no part of the map`,
    );
  await describe(run);
  await recentWork(run, { clear: true });
}

async function describe(run: Run): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const d = await run.script("describe.mjs", "describe");
    if (!d.ok) throw new FloorplanError(`describe failed: ${errorsOf(d)}`);
    if (d.json.nothingToDo === true) return;
    const sheets = Array.isArray(d.json.worksheets) ? d.json.worksheets : [];
    for (const sheet of sheets) {
      run.saved.worksheet = sheet;
      await run.job("descriptions");
    }
    await run.build();
    if (run.built.ok && run.built.descriptions?.complete) return;
  }
  run.result.notes.push("some files or endpoints are still undescribed");
}

/** A first map has no recent work to show; an update marks what changed. */
async function recentWork(
  run: Run,
  { clear }: { clear: boolean },
): Promise<void> {
  const r = await run.script("recent.mjs", "recent");
  if (!r.ok) throw new FloorplanError(`recent failed: ${errorsOf(r)}`);
  if (clear || r.json.nothingRecent === true) {
    const path = join(run.root, FLOORPLAN_DIR, "recent-work.json");
    await writeFile(
      path,
      `${JSON.stringify({ updatedAt: run.now.toISOString(), tasks: [] }, null, 2)}\n`,
      "utf8",
    );
  } else await run.job("recent_work");
  await run.build();
}

/** A refresh: refresh.mjs does the bookkeeping, then only what its NEXT list asks. */
async function refresh(run: Run): Promise<void> {
  run.result.made = "refresh";
  const r = await run.script("refresh.mjs", "refresh");
  run.saved.build = r.json.build ?? run.saved.build;
  const next = Array.isArray(r.json.next)
    ? (r.json.next as { code?: string }[])
    : [];
  if (!r.ok && next.length === 0)
    throw new FloorplanError(`refresh failed: ${errorsOf(r)}`);
  for (const item of next) {
    run.saved.item = item;
    switch (item.code) {
      case "first_map":
        await firstMap(run);
        return;
      case "fix_build":
      case "assign_new_files":
      case "review_structure":
        for (let attempt = 0; attempt < 2; attempt++) {
          await run.job("update_architecture");
          await run.build();
          if (run.built.ok) break;
        }
        break;
      case "describe":
        await describe(run);
        break;
      case "recent_work":
        await recentWork(run, { clear: false });
        break;
      case "blueprint":
        break;
      default:
        throw new FloorplanError(
          `refresh asks for ${item.code ?? "something unnamed"}, which needs a person`,
        );
    }
  }
}

/**
 * Make the map, or bring the one there up to date ("make me a floorplan",
 * "update the floorplan"). Throws a FloorplanError when it can't; callers log
 * that and carry on.
 */
export async function drawFloorplan(
  repoPath: string,
  options: FloorplanOptions = {},
): Promise<FloorplanResult> {
  const root = resolve(repoPath);
  const mapDir = join(root, FLOORPLAN_DIR);
  if ((await exists(mapDir)) && !(await isFloorplanMap(mapDir)))
    throw new FloorplanError(
      `${FLOORPLAN_DIR}/ is part of the project, not a map; leaving it alone`,
    );
  const skillDir = options.skillDir ?? (await floorplanSkillDir(root));
  const workflow = JSON.parse(
    await readFile(join(skillDir, "workflow.json"), "utf8"),
  ) as Workflow;
  const run = new Run(root, skillDir, workflow, options);
  const status = await run.script("status.mjs", "status");
  const state = String(status.json.state ?? "");
  if (state === "map" || state === "blueprint") await refresh(run);
  else if (state === "none" || state === "unbuilt") await firstMap(run);
  else
    throw new FloorplanError(
      `floorplan/ holds a map that needs a person (status ${state || "unknown"})`,
    );
  if (!run.built.ok) throw new FloorplanError("the map didn't build");
  return run.result;
}

/** " · 3 call(s) · 12345 tokens · $0.42" for a log line. */
export function floorplanUsage(r: FloorplanResult): string {
  return ` · ${r.calls} call(s)${usageNote({ text: "", tokens: r.tokens, costUsd: r.costUsd })}`;
}

/**
 * The close beat's hook for a merged task: update the map when the profile
 * turns it on. Never throws; returns the ledger line, or null when it's off.
 */
export async function floorplanOnMerge(
  repoPath: string,
  options: FloorplanOptions = {},
): Promise<string | null> {
  let enabled: boolean;
  try {
    enabled = floorplanEnabled(await loadProfile(repoPath));
  } catch {
    // An unreadable profile turns nothing on; the other beats report it.
    return null;
  }
  if (!enabled) return null;
  try {
    const r = await drawFloorplan(repoPath, options);
    return `floorplan ${r.made === "first" ? "made" : "updated"}${floorplanUsage(r)}${r.notes.length > 0 ? ` · ${r.notes.join("; ")}` : ""}`;
  } catch (err) {
    return `floorplan update failed (close goes on): ${oneLine((err as Error).message)}`;
  }
}
