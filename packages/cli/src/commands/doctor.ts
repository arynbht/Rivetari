import { spawn } from "node:child_process";
import { access, mkdir, opendir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  buildContext,
  CI_BUDGET_WARN,
  type CiMinutes,
  ciMonth,
  githubToken,
  loadProfile,
  monthCiMinutes,
  resolveRepoSlug,
  runTool,
} from "@arynbht/rivetari-engine";
import {
  loadManifests,
  readLock,
  skillsStatus,
} from "@arynbht/rivetari-registry";
import { lockShortfall } from "@arynbht/rivetari-runtime";

import { guardSelfTest } from "./hook.js";

export interface DoctorCheck {
  name: string;
  /** `fail` stops a task from starting; `warn` limits what it can do. */
  status: "ok" | "warn" | "fail";
  detail: string;
}

const exists = (path: string) =>
  access(path)
    .then(() => true)
    .catch(() => false);

/**
 * Run the guard the way Claude Code does, through a shell, on a `.rivetari/**`
 * edit: true when it ran and refused it. `Rivetari` missing from that shell's
 * PATH is the case this catches.
 */
function guardRunsInShell(root: string): Promise<boolean> {
  return new Promise((done) => {
    const child = spawn("rivetari hook guard", {
      cwd: root,
      shell: true,
      stdio: ["pipe", "ignore", "pipe"],
      timeout: 30_000,
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", () => done(false));
    // A shell that exits before reading its input mustn't crash doctor.
    child.stdin.on("error", () => undefined);
    child.on("close", (code) =>
      done(code === 2 && stderr.startsWith("rivetari: ")),
    );
    child.stdin.end(
      JSON.stringify({
        cwd: root,
        tool_input: { file_path: join(root, ".rivetari", "profile.yml") },
      }),
    );
  });
}

/**
 * The machine and the repo, checked before a task starts: a git repo
 * with a rivetari profile, its guard hook live, the Claude CLI the agent runs
 * on, a way to reach GitHub for ship and close, and skills that match their
 * lock.
 */
export async function doctorChecks(
  root: string,
  options: {
    token?: string | null;
    claude?: () => Promise<string>;
    guardInShell?: (root: string) => Promise<boolean>;
  } = {},
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const isRepo = await runTool("git", ["rev-parse", "--git-dir"], root)
    .then((r) => r.exitCode === 0)
    .catch(() => false);
  checks.push(
    isRepo
      ? { name: "git", status: "ok", detail: "a git repository" }
      : { name: "git", status: "fail", detail: "not a git repository" },
  );

  const profile = await exists(join(root, ".rivetari", "profile.yml"));
  checks.push(
    profile
      ? { name: "profile", status: "ok", detail: ".rivetari/profile.yml" }
      : {
          name: "profile",
          status: "fail",
          detail: "no .rivetari/profile.yml: run `rivetari init`",
        },
  );

  if (profile) {
    const guard = await guardSelfTest(root);
    const live =
      guard.ok && (await (options.guardInShell ?? guardRunsInShell)(root));
    checks.push(
      live
        ? { name: "hooks", status: "ok", detail: guard.detail }
        : {
            name: "hooks",
            status: "fail",
            detail: guard.ok
              ? "`rivetari hook guard` can't run from a shell here (is Rivetari CLI on PATH?), so the guard blocks every edit and command"
              : guard.detail,
          },
    );
  }

  const version = await (
    options.claude ??
    (async () => {
      const res = await runTool("claude", ["--version"], root, {
        timeoutMs: 30_000,
      });
      if (res.exitCode !== 0) throw new Error(res.stderr.trim());
      return res.stdout.trim();
    })
  )().catch(() => null);
  checks.push(
    version
      ? { name: "claude", status: "ok", detail: version }
      : {
          name: "claude",
          status: "fail",
          detail:
            "the `claude` CLI isn't on PATH; the agent and the judge run on it",
        },
  );

  const slug = isRepo ? await resolveRepoSlug(root) : null;
  const auth =
    options.token === undefined
      ? slug
        ? await githubToken(root)
        : null
      : options.token
        ? { token: options.token, source: "explicit" as const }
        : null;
  checks.push(
    slug && auth
      ? {
          name: "github",
          status: "ok",
          detail:
            auth.source === "app"
              ? `${slug.owner}/${slug.repo}, as Rivetari's App`
              : `${slug.owner}/${slug.repo}, as you (${auth.source} token); with Rivetari's App, reviews and evidence come from the rivetari: \`rivetari app status\``,
        }
      : {
          name: "github",
          status: "warn",
          detail: slug
            ? "no way to reach GitHub (Rivetari's App, GITHUB_TOKEN or `gh auth login`): ship and close can't run"
            : "no GitHub origin remote: ship and close can't run",
        },
  );

  const problems = isRepo
    ? await skillsStatus(root).catch((err: Error) => [err.message])
    : [];
  const locked = await exists(join(root, ".rivetari", "skills.lock"));
  const short =
    isRepo && locked && problems.length === 0
      ? await lockShortDetail(root).catch(
          (err: Error) =>
            `couldn't check the lock against this repo's files: ${err.message}`,
        )
      : null;
  checks.push(
    problems.length > 0
      ? { name: "skills", status: "fail", detail: problems.join("; ") }
      : locked
        ? short
          ? {
              name: "skills",
              status: "warn",
              detail: `installed skills match the lock, but ${short}`,
            }
          : {
              name: "skills",
              status: "ok",
              detail: "installed skills match the lock",
            }
        : {
            name: "skills",
            status: "warn",
            detail:
              "no .rivetari/skills.lock: tasks run on the spine alone (`rivetari skills init`, then `rivetari skills sync`)",
          },
  );
  return checks;
}

/**
 * What the lock is short of for this repo, or null: sectors its files route
 * task skills into with none of them locked (a spine-only lock routes every
 * task without sector skills, and nothing else says so), and a floorplan the
 * profile keeps without the skill that draws it.
 */
async function lockShortDetail(root: string): Promise<string | null> {
  const { manifests } = await loadManifests(root);
  const lock = await readLock(root);
  const locked = new Set(lock.skills.map((s) => s.name));
  const listed = await runTool("git", ["ls-files"], root);
  if (listed.exitCode !== 0)
    throw new Error(`git ls-files failed: ${listed.stderr.trim()}`);
  const files = listed.stdout
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
  const short = lockShortfall({ manifests, locked, files });
  // A missing or broken profile is the profile check's to report; it
  // shouldn't hide what the lock is short of.
  const profile = await loadProfile(root).catch(() => null);
  const floorplan = profile?.floorplan === true && !locked.has("floorplan");
  const gaps: string[] = [];
  if (short[0])
    gaps.push(
      `it holds no task skill for ${short.map((s) => `${s.sector} (${s.skills.join(", ")})`).join(", ")}, which files like ${short[0].file} route to`,
    );
  if (floorplan)
    gaps.push(
      "the profile keeps a floorplan and the floorplan skill isn't locked",
    );
  if (gaps.length === 0) return null;
  return `${gaps.join("; ")}: lock them with \`rivetari skills add <source>\` (or \`rivetari skills init\` for every shipped skill), then \`rivetari skills sync\``;
}

export const CROWDED_TEMP = 20_000;

export async function tempCheck(
  dir: string = tmpdir(),
  limit: number = CROWDED_TEMP,
): Promise<DoctorCheck | null> {
  let count = 0;
  try {
    const entries = await opendir(dir);
    for await (const entry of entries) {
      if (entry.name) count++;
      if (count >= limit) break;
    }
  } catch {
    return null;
  }
  if (count < limit) return null;
  return {
    name: "temp",
    status: "warn",
    detail: `${dir} holds ${limit.toLocaleString("en-US")}+ entries: every proof and judge run makes and removes temp repos there, so local runs are several times slower. Clear out what you don't need.`,
  };
}

const CI_MINUTES_CACHE = join(".rivetari", "cache", "ci-minutes.json");

/**
 * The month's CI minutes, keeping what earlier runs counted in
 * `.rivetari/cache/` so a doctor run only looks up runs that are new.
 */
async function cachedMonthMinutes(
  root: string,
  token: string,
  now: Date,
): Promise<CiMinutes | null> {
  const gh = await buildContext(root, { token }).github();
  if (!gh) return null;
  const path = join(root, CI_MINUTES_CACHE);
  const cache = (await readFile(path, "utf8")
    .then((t) => JSON.parse(t) as unknown)
    .catch(() => null)) as {
    month?: string;
    runs?: Record<string, number>;
  } | null;
  const known = new Map(
    cache?.month === ciMonth(now) ? Object.entries(cache.runs ?? {}) : [],
  );
  const used = await monthCiMinutes(gh, now, { known });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ month: used.month, runs: Object.fromEntries(known) })}\n`,
  ).catch(() => undefined);
  return used;
}

/**
 * A warning once the month's CI minutes reach 75% of the profile's
 * `ci.budget_minutes_per_month`. Silent below it, without a budget, without
 * a token, or when the Actions API can't be read: it's advice, not a gate.
 */
export async function ciBudgetCheck(
  root: string,
  options: {
    token?: string | null;
    now?: Date;
    minutes?: () => Promise<CiMinutes | null>;
  } = {},
): Promise<DoctorCheck | null> {
  const profile = await loadProfile(root).catch(() => null);
  const budget = profile?.ci?.budget_minutes_per_month;
  if (!budget) return null;
  const now = options.now ?? new Date();
  const minutes =
    options.minutes ??
    (async () => {
      const token =
        options.token === undefined
          ? (await githubToken(root))?.token
          : options.token;
      return token ? cachedMonthMinutes(root, token, now) : null;
    });
  const used = await minutes().catch(() => null);
  if (!used || used.minutes / budget < CI_BUDGET_WARN) return null;
  return {
    name: "ci",
    status: "warn",
    detail: `${used.partial ? "at least " : ""}${used.minutes.toLocaleString("en-US")} of the ${budget.toLocaleString("en-US")} CI minutes budgeted for ${ciMonth(now)} used (${Math.round((used.minutes / budget) * 100)}%)`,
  };
}

/** `rivetari doctor`: exit 1 when anything a task needs is missing. */
export async function runDoctor(path: string): Promise<number> {
  const temp = await tempCheck();
  const ci = await ciBudgetCheck(resolve(path));
  const checks = [
    ...(await doctorChecks(resolve(path))),
    ...(temp ? [temp] : []),
    ...(ci ? [ci] : []),
  ];
  const mark = { ok: "✓", warn: "!", fail: "✗" } as const;
  for (const c of checks)
    process.stdout.write(`${mark[c.status]} ${c.name.padEnd(8)} ${c.detail}\n`);
  return checks.some((c) => c.status === "fail") ? 1 : 0;
}
