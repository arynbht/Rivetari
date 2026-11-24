#!/usr/bin/env node
// Rivetari's cost bench: replay one task card end to end on a fresh fixture of
// breathband-console, intake through judge (never ship), and record what each
// beat cost. See bench/README.md.
//
//   node bench/run.mjs --card t0028|t0019|oneline [--keep] [--dry]
//   node bench/run.mjs --self-check
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { clearInterval, setInterval } from "node:timers";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  baseFromLedger,
  classifyCall,
  decideStop,
  DEFAULT_MAX_USD,
  ledgerUsage,
  resultOf,
  sumCalls,
  TABLE_HEAD,
  tableRow,
  totalOf,
  usageOf,
  verdictOf,
} from "./lib.mjs";

const BENCH = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(BENCH, "..");
const CLI = join(ROOT, "packages", "cli", "dist", "bin.js");
const RUNTIME = join(ROOT, "packages", "runtime", "dist", "index.js");
const ARCHIVE =
  process.env.BENCH_ARCHIVE ??
  "C:/Users/arynb/Documents/Projects/rivetari-session/pilot-archive/breathband-console-2026-11-24";
const WIN = process.platform === "win32";
/** The pilot's Rivetari setup that a fixture gets back (not tasks, history or state). */
const SETUP_FILES = [
  "profile.yml",
  "skills.lock",
  "banned.json",
  "waivers.yml",
  "evidence.yml",
  ".gitignore",
];
const MAX_BUILD_COMMANDS = 4;
/** The CLI commands running now, so none outlive the bench. */
const running = new Set();
const MAX_JUDGE_ROUNDS = 3;

function parseArgs(argv) {
  const out = { keep: false, dry: false, selfCheck: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--card") out.card = argv[++i];
    else if (a === "--keep") out.keep = true;
    else if (a === "--dry") out.dry = true;
    else if (a === "--self-check") out.selfCheck = true;
    else if (a === "--rescore") out.rescore = argv[++i];
    else if (a === "--work") out.work = argv[++i];
    else if (a === "--max-usd") out.maxUsd = Number(argv[++i]);
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const HELP = `usage: node bench/run.mjs --card <t0028|t0019|oneline> [--keep] [--dry] [--work <dir>] [--max-usd <n>]
       node bench/run.mjs --self-check
       node bench/run.mjs --rescore bench/results/<result>.json
  --dry       build the fixture and the card up to route approval, with no AI calls
  --keep      keep the fixture directory afterwards
  --work      where fixtures go (default $BENCH_WORK, else <tmp>/bench-work)
  --max-usd   stop the card past this spend (default ${DEFAULT_MAX_USD})`;

const log = (line) => process.stdout.write(`bench: ${line}\n`);
const seconds = (a, b) => (Date.parse(b) - Date.parse(a)) / 1000;
const tail = (s, n = 1500) => {
  const t = String(s ?? "").trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
};

/** Run a command to completion; throws with its output when it fails. */
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: opts.shell ?? false,
    ...opts,
  });
  if (r.error) throw r.error;
  if (r.status !== 0 && !opts.allowFail)
    throw new Error(
      `${cmd} ${args.join(" ")} exited ${r.status}: ${tail(r.stderr || r.stdout, 800)}`,
    );
  return r;
}
const git = (args, opts = {}) => sh("git", args, opts).stdout.trim();

/** Fixtures never go near a real checkout. */
function assertScratch(dir) {
  const norm = resolve(dir).replace(/\\/g, "/").toLowerCase();
  const root = ROOT.replace(/\\/g, "/").toLowerCase();
  if (norm.includes("/documents/projects/") || norm.startsWith(`${root}/`))
    throw new Error(
      `refusing to build a fixture in ${dir}: fixtures live in scratch space, never under Documents/Projects or this repo (set --work or BENCH_WORK)`,
    );
}

/** The real claude on PATH, skipping any bench shim. */
function realClaude() {
  const r = WIN
    ? spawnSync("where.exe", ["claude"], { encoding: "utf8" })
    : spawnSync("sh", ["-c", "command -v -a claude"], { encoding: "utf8" });
  const hits = String(r.stdout ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => !/bench-shim/i.test(p));
  return hits.find((p) => (WIN ? /\.(exe|cmd|bat)$/i.test(p) : true)) ?? null;
}

/**
 * Put a claude stand-in first on PATH that keeps each call's output. In a dry
 * run it points at nothing, so any AI call fails loudly and is still recorded.
 */
function buildShim(dir, dry) {
  const shim = join(dir, "bench-shim");
  mkdirSync(join(shim, "calls"), { recursive: true });
  const real = dry ? join(dir, "bench-no-claude.exe") : realClaude();
  if (!real) throw new Error("the claude CLI isn't on PATH");
  writeFileSync(join(shim, "real-claude.txt"), real);
  if (WIN) {
    const csc = [
      "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
      "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe",
    ].find((p) => existsSync(p));
    if (!csc)
      throw new Error(
        "csc.exe (.NET Framework 4) isn't here to build the shim",
      );
    sh(csc, [
      "-nologo",
      `-out:${join(shim, "claude.exe")}`,
      join(BENCH, "shim", "claude-shim.cs"),
    ]);
  } else {
    const script = `#!/bin/sh
d=$(cd "$(dirname "$0")" && pwd)
id=$(date -u +%Y%m%dT%H%M%S)-$$
printf '{"started":"%s","cwd":"%s","args":"%s"}\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$PWD" "$(printf '%s ' "$@" | head -c 4000 | tr -d '"\\\\\\n')" > "$d/calls/$id.start.json"
"$(cat "$d/real-claude.txt")" "$@" | tee "$d/calls/$id.out"
code=$?
printf '{"ended":"%s","exit":%s}\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$code" > "$d/calls/$id.end.json"
exit $code
`;
    writeFileSync(join(shim, "claude"), script, { mode: 0o755 });
  }
  return shim;
}

/** A file the shim may still be writing: its text, or null for now. */
function readSoft(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
const jsonSoft = (path) => {
  try {
    return JSON.parse(readSoft(path) ?? "");
  } catch {
    return null;
  }
};

/** Every call the shim has seen, oldest first, with its usage. */
function readCalls(shim) {
  const dir = join(shim, "calls");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".start.json"))
    .sort()
    .map((f) => {
      const id = f.replace(/\.start\.json$/, "");
      const start = jsonSoft(join(dir, f)) ?? { args: "", started: null };
      const end = jsonSoft(join(dir, `${id}.end.json`));
      const out = readSoft(join(dir, `${id}.out`)) ?? "";
      const result = resultOf(out);
      return {
        id,
        kind: classifyCall(start.args),
        cwd: start.cwd,
        started: start.started,
        ended: end?.ended ?? null,
        exit: end?.exit ?? null,
        seconds: end ? seconds(start.started, end.ended) : null,
        usage: usageOf(result),
        error: result?.is_error ? tail(result.result, 300) : null,
      };
    });
}

const spent = (calls) => calls.reduce((s, c) => s + (c.usage?.usd ?? 0), 0);

function killTree(pid) {
  if (WIN)
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
    });
  else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** Processes still running out of the fixture, so none outlive the bench. */
function leftovers(dir) {
  if (!WIN) return [];
  const needle = resolve(dir).replace(/'/g, "''");
  const r = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') -and $_.ProcessId -ne $PID } | ForEach-Object { "$($_.ProcessId)\`t$($_.Name)" }`,
    ],
    { encoding: "utf8" },
  );
  return String(r.stdout ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [pid, name] = l.split("\t");
      return { pid: Number(pid), name };
    })
    .filter((p) => p.pid && p.pid !== process.pid);
}

function listItems(yamlText, key) {
  const lines = String(yamlText ?? "").split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (i === -1) return [];
  const inline = lines[i].slice(key.length + 1).trim();
  if (inline === "[]") return [];
  if (inline) return [inline];
  const out = [];
  for (const l of lines.slice(i + 1)) {
    const m = /^\s+-\s+(.*)$/.exec(l);
    if (!m) break;
    out.push(m[1].trim());
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (args.selfCheck) {
    const { selfCheck } = await import("./selfcheck.mjs");
    return selfCheck();
  }
  if (args.rescore) return rescore(args.rescore);
  const cards = JSON.parse(
    readFileSync(join(BENCH, "cards", "cards.json"), "utf8"),
  );
  const spec = cards.cards[args.card];
  if (!spec) {
    process.stderr.write(`${HELP}\n\nno card "${args.card ?? ""}"\n`);
    return 2;
  }
  if (!existsSync(CLI) || !existsSync(RUNTIME)) {
    process.stderr.write(
      "bench: the CLI isn't built; run `pnpm install --frozen-lockfile && pnpm run build` first\n",
    );
    return 2;
  }
  const maxUsd = Number.isFinite(args.maxUsd) ? args.maxUsd : DEFAULT_MAX_USD;
  const work = resolve(
    args.work ?? process.env.BENCH_WORK ?? join(tmpdir(), "bench-work"),
  );
  assertScratch(work);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const dir = join(work, `bench-${args.card}-${stamp}`);
  const repo = join(dir, "repo");
  const logs = join(dir, "logs");
  mkdirSync(logs, { recursive: true });

  const rivetariSha = git(["log", "-1", "--format=%h", "--", ".", ":!bench"], {
    cwd: ROOT,
  });
  const rec = {
    card: args.card,
    date: new Date().toISOString().slice(0, 10),
    dry: args.dry,
    rivetari: {
      sha: rivetariSha,
      head: git(["rev-parse", "--short", "HEAD"], { cwd: ROOT }),
      branch: git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ROOT }),
    },
    fixture: { repo: cards.repo, pilotTask: spec.pilotTask, dir },
    maxUsd,
    setup: [],
    network: [],
    manual: [],
    errors: [],
    commands: [],
    task: null,
    beats: [],
    totals: null,
    stops: [],
    buildRounds: 0,
    judgeRounds: 0,
    verdict: null,
    committed: null,
    outcome: "not run",
  };

  /** A setup step: "ok", "failed" with why, or "not run". Never a silent pass. */
  const setup = (name, fn, extra = {}) => {
    const t0 = new Date().toISOString();
    try {
      const detail = fn();
      rec.setup.push({
        name,
        status: "ok",
        seconds: Math.round(seconds(t0, new Date().toISOString())),
        ...(detail ? { detail } : {}),
        ...extra,
      });
      return true;
    } catch (err) {
      rec.setup.push({
        name,
        status: "failed",
        seconds: Math.round(seconds(t0, new Date().toISOString())),
        why: tail(err.message, 1200),
        ...extra,
      });
      rec.errors.push(`setup ${name}: ${tail(err.message, 600)}`);
      return false;
    }
  };

  // The fixture: a cached mirror, a fresh clone at the card's base, and a
  // local bare origin so fetches and pulls work and nothing reaches GitHub.
  const cache = join(work, "bench-cache", "breathband-console.git");
  if (!existsSync(cache)) {
    rec.network.push(
      "gh repo clone of BreathBand/breathband-console (the fixture's mirror cache, once)",
    );
    setup("mirror cache", () => {
      mkdirSync(dirname(cache), { recursive: true });
      sh("gh", ["repo", "clone", cards.repo, cache, "--", "--mirror"]);
    });
  }
  let base = spec.base;
  const pilotLedger = join(
    ARCHIVE,
    "dot-rivetari",
    "tasks",
    spec.pilotTask,
    "ledger.jsonl",
  );
  setup("base from the pilot's ledger", () => {
    if (!existsSync(pilotLedger))
      throw new Error(
        `no pilot ledger at ${pilotLedger}; using the base cards.json records`,
      );
    const short = baseFromLedger(readFileSync(pilotLedger, "utf8").split("\n"));
    if (!short) throw new Error("the pilot ledger has no isolate entry");
    const full = git(["rev-parse", "--verify", `${short}^{commit}`], {
      cwd: cache,
    });
    if (full !== spec.base)
      throw new Error(
        `the pilot ledger says ${full}, cards.json says ${spec.base}`,
      );
    base = full;
    return `${short} → ${full}`;
  });
  rec.fixture.base = base;

  const ok = setup("fixture clone", () => {
    // main only: the mirror also holds every PR and dependabot ref.
    sh("git", [
      "-c",
      "core.longpaths=true",
      "clone",
      "-q",
      "--no-checkout",
      "--single-branch",
      "--branch",
      "main",
      "--no-tags",
      cache,
      repo,
    ]);
    git(["config", "core.longpaths", "true"], { cwd: repo });
    git(["checkout", "-q", "-B", "main", base], { cwd: repo });
    git(["remote", "remove", "origin"], { cwd: repo });
    git(["config", "user.name", "Rivetari Bench"], { cwd: repo });
    git(["config", "user.email", "bench@rivetari.invalid"], { cwd: repo });
    git(["config", "core.autocrlf", "false"], { cwd: repo });
    // The pilot's setup, minus tasks, history and state.
    const from = join(ARCHIVE, "dot-rivetari");
    const to = join(repo, ".rivetari");
    mkdirSync(to, { recursive: true });
    for (const f of SETUP_FILES) copyFileSync(join(from, f), join(to, f));
    rmSync(join(to, "skills", "manifests"), { recursive: true, force: true });
    cpSync(join(from, "skills", "manifests"), join(to, "skills", "manifests"), {
      recursive: true,
    });
    // Guard-free: the repo's hooks call `rivetari hook guard`, which would
    // block the harness's own agents.
    const settings = join(repo, ".claude", "settings.json");
    let restored = "no .claude/settings.json at the base";
    if (existsSync(settings)) {
      const s = JSON.parse(readFileSync(settings, "utf8"));
      delete s.hooks;
      writeFileSync(settings, `${JSON.stringify(s, null, 2)}\n`);
      restored = "hooks removed from .claude/settings.json";
    }
    git(["add", "-A", ".rivetari", ".claude"], { cwd: repo });
    git(
      [
        "commit",
        "-q",
        "--no-verify",
        "-m",
        "chore(bench): the pilot's rivetari setup, guard-free",
      ],
      { cwd: repo, env: { ...process.env, LEFTHOOK: "0" } },
    );
    const origin = join(dir, "origin.git");
    sh("git", ["init", "-q", "--bare", "-b", "main", origin]);
    git(["fetch", "-q", repo, "main:main"], { cwd: origin });
    git(["remote", "add", "origin", origin], { cwd: repo });
    git(["fetch", "-q", "origin"], { cwd: repo });
    git(["branch", "-q", "-u", "origin/main", "main"], { cwd: repo });
    git(["remote", "set-head", "origin", "main"], { cwd: repo });
    const remotes = git(["remote", "-v"], { cwd: repo });
    if (/github\.com|git@/i.test(remotes))
      throw new Error(`the fixture still has a GitHub remote: ${remotes}`);
    rec.fixture.head = git(["rev-parse", "HEAD"], { cwd: repo });
    rec.fixture.origin = origin;
    return restored;
  });
  if (!ok) return finish(rec, args, dir, null);

  rec.network.push(
    "npm ci in the fixture (npm registry, unless npm's cache has every package)",
  );
  setup("npm ci", () => {
    sh("npm", ["ci", "--no-audit", "--no-fund", "--prefer-offline"], {
      cwd: repo,
      shell: WIN,
    });
  });

  let shim = null;
  setup("claude shim", () => {
    shim = buildShim(dir, args.dry);
    return args.dry
      ? "dry: points at no claude"
      : readFileSync(join(shim, "real-claude.txt"), "utf8");
  });
  if (!shim) return finish(rec, args, dir, null);

  const ghEmpty = join(dir, "bench-gh-empty");
  mkdirSync(ghEmpty, { recursive: true });
  const env = {
    ...process.env,
    PATH: `${shim}${delimiter}${process.env.PATH ?? ""}`,
    // token: null. No GitHub token reaches Rivetari: an empty gh config, and
    // the env tokens dropped.
    GH_CONFIG_DIR: ghEmpty,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    LEFTHOOK: "0",
  };
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  delete env.GITHUB_ACTIONS;
  delete env.CI;

  let n = 0;
  /** Run the CLI; keeps its output, its wall time and the claude calls it made. */
  const cli = (label, argv) =>
    new Promise((done) => {
      const before = new Set(readCalls(shim).map((c) => c.id));
      const started = new Date().toISOString();
      const file = join(logs, `${String(++n).padStart(2, "0")}-${label}.log`);
      writeFileSync(file, `$ rivetari ${argv.join(" ")}\n`);
      log(`rivetari ${argv.join(" ")}`);
      const child = spawn(process.execPath, [CLI, ...argv], {
        cwd: repo,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: !WIN,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        stdout += d;
        appendFileSync(file, d);
      });
      child.stderr.on("data", (d) => {
        stderr += d;
        appendFileSync(file, d);
      });
      running.add(child.pid);
      let capped = false;
      // Checked on finished calls, so a call already running can overshoot.
      const watch = setInterval(() => {
        let total = 0;
        try {
          total = spent(readCalls(shim));
        } catch {
          return;
        }
        if (total > maxUsd && !capped) {
          capped = true;
          appendFileSync(
            file,
            `\nbench: cost cap $${maxUsd} passed ($${total.toFixed(2)}); stopping\n`,
          );
          killTree(child.pid);
        }
      }, 5000);
      child.on("close", (code) => {
        running.delete(child.pid);
        clearInterval(watch);
        const ended = new Date().toISOString();
        const calls = readCalls(shim)
          .filter((c) => !before.has(c.id))
          .map((c) => c.id);
        const cmd = {
          label,
          args: argv,
          exit: code,
          started,
          ended,
          seconds: Math.round(seconds(started, ended) * 10) / 10,
          calls,
          log: relative(dir, file),
          stdout: tail(stdout, 800),
          stderr: tail(stderr, 800),
          ...(capped ? { capped: true } : {}),
        };
        rec.commands.push(cmd);
        done(cmd);
      });
    });

  rec.network.push(
    "rivetari skills sync (fetches pinned skills from GitHub unless cached)",
  );
  const sync = await cli("skills-sync", ["skills", "sync", repo]);
  rec.setup.push({
    name: "rivetari skills sync",
    status: sync.exit === 0 ? "ok" : "failed",
    seconds: sync.seconds,
    ...(sync.exit === 0 ? {} : { why: tail(sync.stderr || sync.stdout, 800) }),
  });
  if (sync.exit !== 0)
    rec.errors.push(
      `skills sync exited ${sync.exit}: ${tail(sync.stderr || sync.stdout, 400)}`,
    );
  const doctor = await cli("doctor", ["doctor", repo]);
  rec.setup.push({
    name: "rivetari doctor (recorded, not gating)",
    status: doctor.exit === 0 ? "ok" : "failed",
    seconds: doctor.seconds,
    detail: tail(doctor.stdout || doctor.stderr, 1200),
  });

  const rt = await import(pathToFileURL(RUNTIME).href);
  const load = (id) => rt.loadTask(repo, id);

  // Intake and route.
  const cardFile = join(BENCH, "cards", spec.file);
  const drafted = await cli("task-new", [
    "task",
    "new",
    "--from",
    cardFile,
    "--path",
    repo,
  ]);
  const id = /drafted (T-\d{4})/.exec(drafted.stdout)?.[1];
  if (drafted.exit !== 0 || !id) {
    rec.outcome = `stopped: task new exited ${drafted.exit}: ${tail(drafted.stderr || drafted.stdout, 400)}`;
    rec.errors.push(rec.outcome);
    return finish(rec, args, dir, shim);
  }
  let task = await load(id);
  if (!task.confirmed)
    await cli("task-confirm", ["task", "confirm", id, "--yes", "--path", repo]);
  task = await load(id);
  if (task.confirmed && !task.approved) {
    if (task.assemblyText === undefined)
      await cli("task-route", ["task", "route", id, "--path", repo]);
    task = await load(id);
    if (task.assemblyText !== undefined)
      await cli("task-approve", [
        "task",
        "approve",
        id,
        "--yes",
        "--path",
        repo,
      ]);
  }
  task = await load(id);
  rec.task = {
    id,
    risk: task.card.risk,
    confirmed: task.confirmed,
    approved: task.approved,
    sectors: listItems(task.assemblyText, "sectors"),
    skills: listItems(task.assemblyText, "skills"),
    proof: /^proof:\s*(\S+)/m.exec(task.assemblyText ?? "")?.[1] ?? null,
    next: rt.nextStep(task),
  };

  if (args.dry) {
    const calls = readCalls(shim).filter((c) => c.kind !== "probe");
    const checks = [
      ["no AI calls", calls.length === 0, `${calls.length} call(s)`],
      ["card confirmed", task.confirmed, ""],
      ["route approved", task.approved, ""],
      ["next is isolate", rec.task.next.startsWith("isolate:"), rec.task.next],
      [
        "origin is local",
        !/github\.com|git@/i.test(git(["remote", "-v"], { cwd: repo })),
        git(["remote", "get-url", "origin"], { cwd: repo }),
      ],
      [
        "fixture at the card's base",
        git(["rev-parse", "HEAD~1"], { cwd: repo }) === base,
        base,
      ],
    ];
    rec.dryChecks = checks.map(([name, pass, detail]) => ({
      name,
      pass,
      detail,
    }));
    rec.outcome = checks.every((c) => c[1])
      ? "dry: fixture and card ready"
      : "dry: a check failed";
    return finish(rec, args, dir, shim);
  }

  // isolate → build → prove → judge, answering stops by the policy, until
  // ship is next (never run) or something stops it.
  const count = (label) => rec.commands.filter((c) => c.label === label).length;
  const capHit = () => spent(readCalls(shim)) > maxUsd;
  for (let i = 0; i < 30; i++) {
    task = await load(id);
    const next = rt.nextStep(task);
    const open = rt.openStops(task);
    if (open.length > 0) {
      const decisions = open.map((stop) => ({
        stop,
        beat: task.beat,
        ...decideStop(stop, task.card),
      }));
      for (const d of decisions)
        rec.stops.push({
          beat: d.beat,
          stop: d.stop,
          decision: d.allow ? "allowed" : "stopped",
          note: d.allow ? d.note : d.why,
          by: "bench policy (standing in for a person)",
        });
      const denied = decisions.find((d) => !d.allow);
      if (denied) {
        rec.outcome = `stopped: ${denied.stop}`;
        break;
      }
      const note = decisions.map((d) => d.note).join("; ");
      const answered = await cli("task-answer", [
        "task",
        "answer",
        id,
        note,
        "--allow",
        "--path",
        repo,
      ]);
      if (answered.exit !== 0) {
        rec.outcome = `stopped: task answer exited ${answered.exit}: ${tail(answered.stderr, 300)}`;
        rec.errors.push(rec.outcome);
        break;
      }
      continue;
    }
    let cmd;
    if (next.startsWith("isolate:"))
      cmd = await cli("isolate", ["task", "isolate", id, "--path", repo]);
    else if (next.startsWith("build:")) {
      if (count("build") >= MAX_BUILD_COMMANDS) {
        rec.outcome = `stopped: ${MAX_BUILD_COMMANDS} build commands without reaching ship`;
        break;
      }
      cmd = await cli("build", ["task", "build", id, "--path", repo]);
    } else if (next === "prove")
      cmd = await cli("prove", ["task", "prove", id, "--path", repo]);
    else if (next === "judge") {
      if (count("judge") >= MAX_JUDGE_ROUNDS) {
        rec.outcome = `stopped: ${MAX_JUDGE_ROUNDS} judge rounds without reaching ship`;
        break;
      }
      cmd = await cli("judge", ["task", "judge", id, "--path", repo]);
    } else if (next === "ship") {
      rec.outcome = "reached ship (not run)";
      break;
    } else {
      rec.outcome = `stopped: ${next}`;
      break;
    }
    if (cmd.capped || capHit()) {
      rec.outcome = `stopped: cost cap $${maxUsd} passed ($${spent(readCalls(shim)).toFixed(2)})`;
      break;
    }
    const after = await load(id);
    const moved =
      after.entries.length > task.entries.length || rt.nextStep(after) !== next;
    // Exit 2 with a stop-and-ask is a pause, not a failure; derive() sorts them.
    if (cmd.exit !== 0) {
      if (!moved) {
        rec.outcome = `stopped: rivetari ${cmd.label} exited ${cmd.exit}`;
        break;
      }
    } else if (!moved) {
      rec.outcome = `stopped: ${cmd.label} ran but the task is still at "${next}"`;
      break;
    }
  }
  return finish(rec, args, dir, shim, { repo, id, rt });
}

/** Per-beat rows from the commands, the shim's calls and the ledger. */
function beatRows(rec, calls, entries) {
  const byId = new Map(calls.map((c) => [c.id, c]));
  const of = (cmd) => cmd.calls.map((id) => byId.get(id)).filter(Boolean);
  const rows = [];
  const at = (re) => entries.find((e) => re.test(e.text ?? ""))?.at;
  const intakeCmds = rec.commands.filter((c) =>
    ["task-new", "task-confirm", "task-route", "task-approve"].includes(
      c.label,
    ),
  );
  if (intakeCmds.length > 0) {
    const start = intakeCmds[0].started;
    const end = intakeCmds.at(-1).ended;
    const confirmed = at(/^intake confirmed/) ?? end;
    const intakeCalls = intakeCmds.flatMap(of);
    rows.push(
      sumCalls(
        "intake",
        intakeCalls.filter((c) => c.started <= confirmed),
        Math.max(0, seconds(start, confirmed)),
      ),
      sumCalls(
        "route",
        intakeCalls.filter((c) => c.started > confirmed),
        Math.max(0, seconds(confirmed, end)),
      ),
    );
  }
  let plan = { calls: [], seconds: 0 };
  let buildRound = 0;
  let judgeRound = 0;
  let proveRound = 0;
  let answers = { calls: [], seconds: 0 };
  for (const cmd of rec.commands) {
    const cs = of(cmd);
    if (cmd.label === "isolate")
      rows.push(sumCalls("isolate", cs, cmd.seconds));
    else if (cmd.label === "build") {
      const planCalls = cs.filter((c) => c.kind === "plan");
      const buildCalls = cs.filter((c) => c.kind !== "plan");
      const planSec = planCalls.reduce((s, c) => s + (c.seconds ?? 0), 0);
      plan.calls.push(...planCalls);
      if (buildCalls.length === 0) plan.seconds += cmd.seconds;
      else {
        plan.seconds += planSec;
        // One build command can hold a build call and its retry: each is a round.
        const rest = cmd.seconds - planSec;
        const callSec = buildCalls.reduce((s, c) => s + (c.seconds ?? 0), 0);
        for (const c of buildCalls) {
          const share =
            callSec > 0 ? (c.seconds ?? 0) / callSec : 1 / buildCalls.length;
          rows.push(sumCalls(`build round ${++buildRound}`, [c], rest * share));
        }
      }
    } else if (cmd.label === "prove")
      rows.push(
        sumCalls(
          `prove${++proveRound > 1 ? ` round ${proveRound}` : ""}`,
          cs,
          cmd.seconds,
        ),
      );
    else if (cmd.label === "judge")
      rows.push(sumCalls(`judge round ${++judgeRound}`, cs, cmd.seconds));
    else if (cmd.label === "task-answer") {
      answers.calls.push(...cs);
      answers.seconds += cmd.seconds;
    }
  }
  if (plan.calls.length > 0 || plan.seconds > 0) {
    const i = rows.findIndex((r) => r.beat.startsWith("build round"));
    const row = sumCalls("plan", plan.calls, plan.seconds);
    if (i === -1) rows.push(row);
    else rows.splice(i, 0, row);
  }
  if (answers.seconds > 0)
    rows.push(sumCalls("stop answers", answers.calls, answers.seconds));
  // Show the order the beats ran in: build rounds and judges can interleave.
  return rows;
}

const JUDGE_NPM =
  "the judge's npm ci in its workspace (npm registry, unless npm's cache has every package)";

/**
 * Everything worked out from the raw record (commands, calls, ledger), so a
 * stored result can be scored again by the same rules (`--rescore`).
 * `logOf` gives a command's full log when it still exists, else its tails.
 */
function derive(rec, entries, logOf = () => null) {
  const text = (c) => logOf(c) ?? `${c.stdout ?? ""}\n${c.stderr ?? ""}`;
  // A beat that exits 2 to ask a person has paused, not failed.
  const paused = (c) =>
    c.exit === 2 && /next: stop-and-ask/.test(c.stdout ?? "");
  rec.pauses = rec.commands.filter(paused).map((c) => ({
    command: c.label,
    stops: String(c.stdout)
      .split(/\r?\n/)
      .filter((l) => l.startsWith("stop: "))
      .map((l) => l.slice(6)),
  }));
  const failures = rec.commands
    .filter((c) => c.exit !== 0 && c.label !== "doctor" && !paused(c))
    .map(
      (c) =>
        `rivetari ${c.args.join(" ")} exited ${c.exit}: ${tail(c.stderr || c.stdout, 600)}`,
    );
  rec.errors = [
    ...rec.errors.filter((e) => !/^rivetari (task|skills) /.test(e)),
    ...failures,
  ];
  // The judge clones into a workspace of its own outside the fixture, and
  // installs there.
  const judges = rec.commands.filter((c) => c.label === "judge").map(text);
  const workspaces = [
    ...new Set(
      judges.flatMap((t) =>
        [...t.matchAll(/cloning into the judge workspace (\S+)/g)].map(
          (m) => m[1],
        ),
      ),
    ),
  ];
  if (workspaces.length > 0) rec.judgeWorkspaces = workspaces;
  if (
    judges.some((t) => /installing dependencies/.test(t)) &&
    !rec.network.includes(JUDGE_NPM)
  )
    rec.network.push(JUDGE_NPM);
  const byId = new Map(rec.calls.map((c) => [c.id, c]));
  const buildCalls = rec.commands
    .filter((c) => c.label === "build")
    .flatMap((c) => c.calls.map((id) => byId.get(id)))
    .filter((c) => c && c.kind !== "plan");
  rec.buildCommands = rec.commands.filter((c) => c.label === "build").length;
  rec.buildRounds = buildCalls.length;
  rec.planCalls = rec.calls.filter((c) => c.kind === "plan").length;
  rec.judgeRounds = rec.commands.filter((c) => c.label === "judge").length;
  rec.beats = beatRows(rec, rec.calls, entries);
  rec.totals = totalOf(rec.beats);
  rec.totals.stops = rec.stops.length;
  rec.stopsCount = rec.stops.length;
}

async function finish(rec, args, dir, shim, ctx = null) {
  const calls = shim ? readCalls(shim) : [];
  rec.calls = calls;
  let entries = [];
  if (ctx) {
    try {
      const task = await ctx.rt.loadTask(ctx.repo, ctx.id);
      entries = task.entries;
      rec.task.problems = task.problems;
      rec.task.next = ctx.rt.nextStep(task);
    } catch (err) {
      rec.errors.push(`reading the ledger: ${err.message}`);
    }
    rec.ledger = entries.map((e) => ({
      seq: e.seq,
      at: e.at,
      beat: e.beat,
      section: e.section,
      text: String(e.text).slice(0, 400),
    }));
    rec.ledgerUsage = ledgerUsage(entries);
    rec.ledgerTotals = rec.ledgerUsage.reduce(
      (s, u) => ({
        tokens: s.tokens + u.tokens,
        usd: Math.round((s.usd + u.usd) * 100) / 100,
      }),
      { tokens: 0, usd: 0 },
    );
    rec.verdict = verdictOf(entries);
    // The history row is written at close, which the bench never reaches.
    const history = join(ctx.repo, ".rivetari", "history.jsonl");
    const row = existsSync(history)
      ? readFileSync(history, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
          .find((r) => r.task === ctx.id)
      : undefined;
    rec.history = row ?? {
      row: null,
      why: "close never runs in the bench, so no history row exists",
    };
    const envPath = join(ctx.repo, ".rivetari", "tasks", ctx.id, "env.json");
    if (existsSync(envPath)) {
      const iso = JSON.parse(readFileSync(envPath, "utf8"));
      try {
        const commits = Number(
          git(["rev-list", "--count", `${iso.base}..HEAD`], {
            cwd: iso.worktree,
          }),
        );
        const dirty = git(["status", "--porcelain"], { cwd: iso.worktree })
          .split("\n")
          .filter(Boolean);
        const files = git(["diff", "--stat", `${iso.base}..HEAD`], {
          cwd: iso.worktree,
        });
        rec.committed = {
          committed: commits > 0 && dirty.length === 0,
          commits,
          uncommitted: dirty,
          diffstat: tail(files, 1500),
        };
      } catch (err) {
        rec.committed = { committed: null, why: err.message };
      }
    } else
      rec.committed = {
        committed: null,
        why: "no worktree (isolate didn't run)",
      };
  }
  derive(rec, entries, (c) => readSoft(join(dir, c.log)));

  // Nothing outlives the bench.
  const left = leftovers(dir);
  for (const p of left) killTree(p.pid);
  if (left.length > 0)
    rec.errors.push(
      `processes still running from the fixture, killed: ${left.map((p) => `${p.name} ${p.pid}`).join(", ")}`,
    );

  if (!args.dry) {
    rec.file = `${rec.date}-${rec.rivetari.sha}-${rec.card}.json`;
    writeResults(rec);
  } else {
    writeFileSync(
      join(dir, "bench-dry.json"),
      `${JSON.stringify(rec, null, 2)}\n`,
    );
  }
  printSummary(rec);
  if (!args.keep) {
    if (ctx) spawnSync("git", ["worktree", "prune"], { cwd: ctx.repo });
    try {
      rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 1000,
      });
    } catch (err) {
      log(`couldn't remove ${dir}: ${err.message}`);
    }
  } else log(`kept ${dir}`);
  if (args.dry) return rec.dryChecks?.every((c) => c.pass) ? 0 : 1;
  return rec.outcome.startsWith("reached ship") ? 0 : 1;
}

/** The result's JSON, and its row in results/README.md (replaced when it's there). */
function writeResults(rec) {
  const out = join(BENCH, "results", rec.file);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(rec, null, 2)}\n`);
  const table = join(BENCH, "results", "README.md");
  if (!existsSync(table))
    writeFileSync(
      table,
      `# Bench results\n\nOne row per run of \`node bench/run.mjs\`. Tokens include cache reads and writes; $ is the claude CLI's own figure.\n\n${TABLE_HEAD.join("\n")}\n`,
    );
  const lines = readFileSync(table, "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes(`](${rec.file})`));
  if (i === -1) appendFileSync(table, `${tableRow(rec)}\n`);
  else {
    lines[i] = tableRow(rec);
    writeFileSync(table, lines.join("\n"));
  }
  log(`results: ${relative(ROOT, out)}`);
}

/** `--rescore <result.json>`: work the derived fields out again from its raw record. */
function rescore(file) {
  const path = resolve(file);
  const rec = JSON.parse(readFileSync(path, "utf8"));
  derive(rec, rec.ledger ?? []);
  rec.rescored = new Date().toISOString();
  rec.file = relative(join(BENCH, "results"), path).replace(/\\/g, "/");
  writeResults(rec);
  printSummary(rec);
  return 0;
}

function printSummary(rec) {
  const lines = [
    `card ${rec.card} · rivetari ${rec.rivetari.sha} · outcome: ${rec.outcome}`,
    "beat | calls | turns | tokens (in/out/cache-write/cache-read) | $ | s | model",
  ];
  for (const r of rec.beats)
    lines.push(
      `${r.beat} | ${r.calls} | ${r.turns} | ${r.tokens.total} (${r.tokens.input}/${r.tokens.output}/${r.tokens.cacheCreation}/${r.tokens.cacheRead}) | ${r.usd.toFixed(2)} | ${r.seconds} | ${r.models.join(",")}`,
    );
  const t = rec.totals;
  lines.push(
    `total | ${t.calls} | ${t.turns} | ${t.tokens.total} | ${t.usd.toFixed(2)} | ${t.seconds} |`,
  );
  lines.push(
    `stops ${rec.stops.length} · plan calls ${rec.planCalls ?? "—"} · build rounds ${rec.buildRounds} (${rec.buildCommands ?? "—"} build commands) · judge rounds ${rec.judgeRounds} · verdict ${rec.verdict ?? "—"} · committed ${rec.committed?.committed ?? "—"}`,
  );
  for (const c of rec.dryChecks ?? [])
    lines.push(`${c.pass ? "pass" : "FAIL"}: ${c.name} ${c.detail}`);
  for (const s of rec.setup.filter((x) => x.status !== "ok"))
    lines.push(`setup ${s.name}: ${s.status}: ${s.why ?? ""}`);
  for (const e of rec.errors) lines.push(`error: ${e}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

// A bench that fails part-way takes its running command (and its claude) with it.
const stopRunning = () => {
  for (const pid of running) killTree(pid);
  running.clear();
};
process.on("SIGINT", () => {
  stopRunning();
  process.exit(130);
});

main().then(
  (code) => {
    stopRunning();
    process.exit(code);
  },
  (err) => {
    stopRunning();
    process.stderr.write(`bench: ${err.stack ?? err}\n`);
    process.exit(1);
  },
);
