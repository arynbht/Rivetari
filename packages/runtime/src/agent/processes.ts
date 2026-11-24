// The servers a task leaves running: a `next dev` the build agent started in
// the background, or one an earlier run never took down. They hold the task's
// port, so the next round and the proof can't bind it, and they outlive an
// abandoned task. A server is the task's when it, or a process above it,
// names the task's worktree on its command line (or, on Linux, runs in it);
// the runtime stops each such server with its whole process tree after every
// build round and proof, and on close. A server it can't tie to the worktree
// is never killed: it is reported, and isolate skips its port.
import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
  /** Linux only: where it runs. */
  cwd?: string | undefined;
}

export interface ProcessSnapshot {
  processes: ProcessRow[];
  /** Listening TCP sockets: the port and the process that holds it. */
  listening: { port: number; pid: number }[];
}

// One PowerShell call for both, so a teardown costs one process start.
const WINDOWS_SNAPSHOT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  // Otherwise a path outside the OEM code page reaches node mangled.
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "$p = @(Get-CimInstance Win32_Process | ForEach-Object { @{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; command = [string]$_.CommandLine } })",
  "$l = @(Get-NetTCPConnection -State Listen | ForEach-Object { @{ port = [int]$_.LocalPort; pid = [int]$_.OwningProcess } })",
  "@{ processes = $p; listening = $l } | ConvertTo-Json -Compress -Depth 3",
].join("; ");

async function windowsSnapshot(): Promise<ProcessSnapshot> {
  const { stdout } = await exec(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SNAPSHOT],
    { windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  );
  // Windows PowerShell's ConvertTo-Json leaves control characters in a
  // command line unescaped, which JSON forbids; compressed, its output has
  // none of its own to keep.
  const clean = Array.from(stdout, (c) => (c.charCodeAt(0) < 0x20 ? " " : c));
  const data = JSON.parse(clean.join("")) as Partial<ProcessSnapshot>;
  return {
    processes: data.processes ?? [],
    listening: data.listening ?? [],
  };
}

/** `lsof -Fpn` output: a `p<pid>` line, then an `n<address>` line per socket. */
export function parseLsof(text: string): ProcessSnapshot["listening"] {
  const out: ProcessSnapshot["listening"] = [];
  let pid = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    const port = line.startsWith("n") ? /:(\d+)$/.exec(line)?.[1] : undefined;
    if (port && pid > 0) out.push({ port: Number(port), pid });
  }
  return out;
}

/** `ss -ltnpH` output: the local address's port, and each `pid=` on the line. */
export function parseSs(text: string): ProcessSnapshot["listening"] {
  const out: ProcessSnapshot["listening"] = [];
  for (const line of text.split(/\r?\n/)) {
    const port = /^\S+\s+\d+\s+\d+\s+\S*:(\d+)\s/.exec(line)?.[1];
    if (!port) continue;
    for (const m of line.matchAll(/pid=(\d+)/g))
      out.push({ port: Number(port), pid: Number(m[1]) });
  }
  return out;
}

async function posixListening(): Promise<ProcessSnapshot["listening"]> {
  const lsof = await exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"])
    .then((r) => r.stdout)
    // lsof exits 1 when it finds nothing.
    .catch((err: { code?: unknown; stdout?: string }) =>
      err.code === 1 ? (err.stdout ?? "") : null,
    );
  if (lsof !== null) return parseLsof(lsof);
  const { stdout } = await exec("ss", ["-ltnpH"]);
  return parseSs(stdout);
}

async function posixSnapshot(): Promise<ProcessSnapshot> {
  const { stdout } = await exec(
    "ps",
    ["-A", "-o", "pid=", "-o", "ppid=", "-o", "args="],
    {
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const processes: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s?(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const cwd =
      process.platform === "linux"
        ? await readlink(`/proc/${pid}/cwd`).catch(() => undefined)
        : undefined;
    processes.push({ pid, ppid: Number(m[2]), command: m[3] ?? "", cwd });
  }
  return { processes, listening: await posixListening() };
}

export function snapshot(): Promise<ProcessSnapshot> {
  return process.platform === "win32" ? windowsSnapshot() : posixSnapshot();
}

/** The worktree as a command line may spell it: native, forward slashes, or Git Bash's /c/… form. */
function spellings(worktree: string): string[] {
  const win = process.platform === "win32";
  const forward = (win ? worktree.toLowerCase() : worktree)
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  const msys = /^([a-z]):\//.exec(forward)
    ? `/${forward[0]}${forward.slice(2)}`
    : undefined;
  return [forward, ...(msys ? [msys] : [])];
}

/** Whether `text` names the worktree as a whole path, not a prefix of a longer name. */
export function namesWorktree(text: string, worktree: string): boolean {
  const win = process.platform === "win32";
  const t = (win ? text.toLowerCase() : text).replace(/\\/g, "/");
  return spellings(worktree).some((w) => {
    for (let at = t.indexOf(w); at !== -1; at = t.indexOf(w, at + 1)) {
      const next = t[at + w.length];
      if (next === undefined || /[/"'\s]/.test(next)) return true;
    }
    return false;
  });
}

const inWorktree = (p: ProcessRow, worktree: string) =>
  namesWorktree(p.command, worktree) ||
  (p.cwd !== undefined && namesWorktree(`${p.cwd}/`, worktree));

export interface TaskServer {
  /** The process stopped: the highest one above the server that is the task's. */
  pid: number;
  /** The listening process and its port. */
  listener: number;
  port: number;
  command: string;
}

/**
 * The task's servers in a snapshot: each listening process that is in the
 * worktree or sits under a process that is, rooted at the highest such
 * process so the tree kill takes the whole chain (`npm run dev` → `next dev`
 * → its server). Plus what holds `ports` without being the task's, which
 * is reported and left alone. This process and its parents are never chosen.
 */
export function taskServers(
  snap: ProcessSnapshot,
  worktree: string,
  ports: readonly number[],
): {
  servers: TaskServer[];
  strangers: { port: number; pid: number; command: string }[];
} {
  const byPid = new Map(snap.processes.map((p) => [p.pid, p]));
  const ours = new Set<number>();
  let up: number | undefined = process.pid;
  while (up && !ours.has(up)) {
    ours.add(up);
    up = byPid.get(up)?.ppid;
  }
  const servers = new Map<number, TaskServer>();
  const strangers: { port: number; pid: number; command: string }[] = [];
  for (const { port, pid } of snap.listening) {
    // 0 and 4 are Windows' idle and System processes.
    if (pid <= 4 || ours.has(pid)) continue;
    let root: ProcessRow | undefined;
    const seen = new Set<number>();
    for (
      let p = byPid.get(pid);
      p && !seen.has(p.pid) && !ours.has(p.pid) && p.pid > 4;
      p = byPid.get(p.ppid)
    ) {
      seen.add(p.pid);
      if (inWorktree(p, worktree)) root = p;
    }
    if (root) {
      if (!servers.has(root.pid))
        servers.set(root.pid, {
          pid: root.pid,
          listener: pid,
          port,
          command: root.command,
        });
    } else if (ports.includes(port))
      strangers.push({ port, pid, command: byPid.get(pid)?.command ?? "" });
  }
  return { servers: [...servers.values()], strangers };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it just isn't ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitGone(pids: number[], ms: number): Promise<number[]> {
  const deadline = Date.now() + ms;
  let left = pids.filter(alive);
  while (left.length > 0 && Date.now() < deadline) {
    await sleep(100);
    left = left.filter(alive);
  }
  return left;
}

/** Kill each root with everything under it: taskkill /T on Windows, the snapshot's tree elsewhere. */
async function killTrees(
  roots: number[],
  snap: ProcessSnapshot,
): Promise<void> {
  if (roots.length === 0) return;
  if (process.platform === "win32") {
    await exec(
      "taskkill",
      [...roots.flatMap((pid) => ["/PID", String(pid)]), "/T", "/F"],
      { windowsHide: true },
    ).catch(() => undefined);
    await waitGone(roots, 5000);
    return;
  }
  const children = new Map<number, number[]>();
  for (const p of snap.processes)
    children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);
  const tree: number[] = [];
  const walk = (pid: number) => {
    if (tree.includes(pid)) return;
    tree.push(pid);
    for (const c of children.get(pid) ?? []) walk(c);
  };
  roots.forEach(walk);
  const signal = (sig: NodeJS.Signals) => {
    for (const pid of tree)
      try {
        process.kill(pid, sig);
      } catch {
        // already gone
      }
  };
  signal("SIGTERM");
  if ((await waitGone(tree, 3000)).length > 0) {
    signal("SIGKILL");
    await waitGone(tree, 2000);
  }
}

/** Whether anything accepts a connection on `port` at `host`. */
function answers(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, exclusive: true }, () =>
      server.close(() => resolve(true)),
    );
  });
}

/**
 * Whether `port` is really free: nothing answers on it over IPv4 or IPv6,
 * and this process could bind it.
 */
export async function portFree(port: number): Promise<boolean> {
  if ((await answers("127.0.0.1", port)) || (await answers("::1", port)))
    return false;
  return canListen(port);
}

export interface Teardown {
  stopped: TaskServer[];
  /** Ports still held by a process that isn't the task's. */
  strangers: { port: number; pid: number; command: string }[];
  /** Set when the processes couldn't be listed; nothing was stopped. */
  error?: string | undefined;
}

/**
 * Stop every server the task left running, and wait for its ports to free.
 * Never throws: a teardown that can't list processes says why instead.
 */
export async function stopTaskServers(
  worktree: string,
  ports: readonly number[],
  options: { snapshot?: () => Promise<ProcessSnapshot> } = {},
): Promise<Teardown> {
  try {
    const snap = await (options.snapshot ?? snapshot)();
    const { servers, strangers } = taskServers(snap, worktree, ports);
    await killTrees(
      servers.map((s) => s.pid),
      snap,
    );
    const freed = [...new Set(servers.map((s) => s.port))];
    const deadline = Date.now() + 5000;
    for (const port of freed)
      while (Date.now() < deadline && (await answers("127.0.0.1", port)))
        await sleep(100);
    return { stopped: servers, strangers };
  } catch (err) {
    return {
      stopped: [],
      strangers: [],
      error: (err as Error).message.replace(/\s+/g, " ").slice(0, 300),
    };
  }
}

/** The teardown as one ledger line, or null when there was nothing to say. */
export function teardownLine(t: Teardown): string | null {
  const cut = (s: string) => (s.length > 120 ? `${s.slice(0, 120)}…` : s);
  const parts = [
    ...t.stopped.map(
      (s) =>
        `stopped the task's server on port ${s.port} (pid ${s.pid}: ${cut(s.command)})`,
    ),
    ...t.strangers.map(
      (s) =>
        `port ${s.port} is held by pid ${s.pid} (${cut(s.command)}), which isn't the task's: left running`,
    ),
    ...(t.error ? [`couldn't look for the task's servers: ${t.error}`] : []),
  ];
  return parts.length > 0 ? parts.join(" · ") : null;
}
