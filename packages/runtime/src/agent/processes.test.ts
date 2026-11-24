// The servers a task leaves running are found by its worktree and stopped
// with their whole tree; anything else is left alone. These spawn real
// processes on real ports.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  namesWorktree,
  parseLsof,
  parseSs,
  portFree,
  type ProcessSnapshot,
  stopTaskServers,
  taskServers,
} from "./processes.js";

const made: string[] = [];
const children: ChildProcess[] = [];
const pids: number[] = [];
const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterEach(async () => {
  for (const pid of pids)
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  for (const c of children) c.kill("SIGKILL");
  pids.length = 0;
  children.length = 0;
  for (const d of made)
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  made.length = 0;
});

/** A server that listens on `port` (0: any) and writes its pid and port to `info`. */
const LISTEN = `const fs = require("fs");
const server = require("http").createServer((q, s) => s.end("ok"));
server.listen(Number(process.argv[3] || 0), () => {
  fs.writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, port: server.address().port }));
});
`;
/** What `npm run dev` does: a parent that starts the server and stays up. */
const PARENT = `const { spawn } = require("child_process");
spawn(process.execPath, process.argv.slice(2), { stdio: "ignore" });
setInterval(() => {}, 1000);
`;

async function waitFor(path: string): Promise<{ pid: number; port: number }> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const text = await readFile(path, "utf8").catch(() => "");
    if (text) return JSON.parse(text) as { pid: number; port: number };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no server info at ${path}`);
}

/** A server under a parent that lives in `worktree`, as a dev server the agent started would. */
async function devServer(
  worktree: string,
): Promise<{ parent: number; pid: number; port: number }> {
  // The listener itself lives elsewhere: only its parent names the worktree.
  const elsewhere = await tmp("rivetari-listen-");
  const listen = join(elsewhere, "listen.cjs");
  await writeFile(listen, LISTEN);
  await writeFile(join(worktree, "dev.cjs"), PARENT);
  const info = join(elsewhere, "info.json");
  const child = spawn(
    process.execPath,
    [join(worktree, "dev.cjs"), listen, info],
    { stdio: "ignore", windowsHide: true },
  );
  children.push(child);
  const server = await waitFor(info);
  pids.push(server.pid);
  return { parent: child.pid ?? 0, ...server };
}

const answers = (port: number) =>
  fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) }).then(
    () => true,
    () => false,
  );

describe("stopTaskServers", { timeout: 60_000 }, () => {
  it("stops a server the task started, with the parent above it, and frees its port", async () => {
    const worktree = await tmp("rivetari-wt-");
    const server = await devServer(worktree);
    expect(await answers(server.port)).toBe(true);

    const teardown = await stopTaskServers(worktree, [server.port]);
    expect(teardown.error).toBeUndefined();
    expect(teardown.stopped.map((s) => [s.pid, s.listener, s.port])).toEqual([
      [server.parent, server.pid, server.port],
    ]);
    expect(alive(server.pid)).toBe(false);
    expect(alive(server.parent)).toBe(false);
    expect(await answers(server.port)).toBe(false);
    expect(await portFree(server.port)).toBe(true);
  });

  it("leaves a server that isn't the task's running, and says it holds the task's port", async () => {
    const worktree = await tmp("rivetari-wt-");
    const elsewhere = await tmp("rivetari-other-");
    await writeFile(join(elsewhere, "listen.cjs"), LISTEN);
    const info = join(elsewhere, "info.json");
    const child = spawn(
      process.execPath,
      [join(elsewhere, "listen.cjs"), info],
      { stdio: "ignore", windowsHide: true },
    );
    children.push(child);
    const server = await waitFor(info);

    const teardown = await stopTaskServers(worktree, [server.port]);
    expect(teardown.stopped).toEqual([]);
    expect(teardown.strangers).toEqual([
      expect.objectContaining({ port: server.port, pid: server.pid }),
    ]);
    expect(alive(server.pid)).toBe(true);
    expect(await answers(server.port)).toBe(true);
  });

  it("doesn't take a worktree whose name only starts the same", async () => {
    const worktree = await tmp("rivetari-wt-");
    const sibling = `${worktree}1`;
    await mkdir(sibling);
    made.push(sibling);
    const server = await devServer(sibling);
    const teardown = await stopTaskServers(worktree, []);
    expect(teardown.stopped).toEqual([]);
    expect(alive(server.pid)).toBe(true);
  });

  it("says why when it can't list processes, and stops nothing", async () => {
    const teardown = await stopTaskServers("/nowhere", [1], {
      snapshot: () => Promise.reject(new Error("ps: not found")),
    });
    expect(teardown).toEqual({
      stopped: [],
      strangers: [],
      error: "ps: not found",
    });
  });
});

describe("portFree", () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("is false while anything listens on the port, and true once it's let go", async () => {
    server = createServer();
    const port = await new Promise<number>((resolve) =>
      server?.listen(0, () => {
        const a = server?.address();
        resolve(typeof a === "object" && a ? a.port : 0);
      }),
    );
    expect(await portFree(port)).toBe(false);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    expect(await portFree(port)).toBe(true);
  });
});

describe("taskServers", () => {
  const wt =
    process.platform === "win32"
      ? "C:\\r\\.worktrees\\T-0021"
      : "/r/.worktrees/T-0021";
  const snap = (
    rows: [number, number, string][],
    listening: [number, number][],
  ): ProcessSnapshot => ({
    processes: rows.map(([pid, ppid, command]) => ({ pid, ppid, command })),
    listening: listening.map(([port, pid]) => ({ port, pid })),
  });

  it("roots each server at the highest process above it that names the worktree", () => {
    const next = `node ${wt}${process.platform === "win32" ? "\\" : "/"}node_modules/next/dist/bin/next dev`;
    const { servers } = taskServers(
      snap(
        [
          [100, 1, "npm run dev"],
          [101, 100, next],
          [102, 101, "node start-server.js"],
        ],
        [[5181, 102]],
      ),
      wt,
      [5181],
    );
    expect(servers).toEqual([
      { pid: 101, listener: 102, port: 5181, command: next },
    ]);
  });

  it("never picks this process or a parent of it, nor Windows' system processes", () => {
    const { servers, strangers } = taskServers(
      snap(
        [[process.pid, 1, `node ${wt}/x.js`]],
        [
          [5181, process.pid],
          [5181, 4],
        ],
      ),
      wt,
      [5181],
    );
    expect(servers).toEqual([]);
    expect(strangers).toEqual([]);
  });

  it("knows the worktree in Git Bash's /c/… spelling on Windows", () => {
    if (process.platform !== "win32") return;
    expect(
      namesWorktree(
        "bash -c \"cd '/c/r/.worktrees/T-0021' && npm run dev\"",
        "C:\\r\\.worktrees\\T-0021",
      ),
    ).toBe(true);
    expect(
      namesWorktree(
        "node C:/r/.worktrees/T-00210/x",
        "C:\\r\\.worktrees\\T-0021",
      ),
    ).toBe(false);
  });
});

describe("listening sockets", () => {
  it("are read from lsof's -F output", () => {
    expect(
      parseLsof("p123\nf20\nn*:5181\nn[::1]:5182\np456\nn127.0.0.1:3000\n"),
    ).toEqual([
      { port: 5181, pid: 123 },
      { port: 5182, pid: 123 },
      { port: 3000, pid: 456 },
    ]);
  });

  it("are read from ss -ltnpH", () => {
    expect(
      parseSs(
        'LISTEN 0      511          *:5181       *:*    users:(("next-server",pid=25460,fd=20))\nLISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*\n',
      ),
    ).toEqual([{ port: 5181, pid: 25460 }]);
  });
});
