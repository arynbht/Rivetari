// The watcher's fast first list (this machine's copies, before the branch) and
// a running beat's live progress.
import { execFileSync } from "node:child_process";
import {
  appendFile,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Beat, Ledger, type Section } from "./ledger.js";
import { progressPath, type TaskProgress } from "./progress.js";
import { commitTask } from "./store.js";
import { confirmTask, newTask, sha256, TASKS_DIR } from "./tasks.js";
import { readTasks, type TaskEvent, watchTasks } from "./watch.js";

const made: string[] = [];
const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
let repo = "";
const savedConfig = process.env.RIVETARI_CONFIG_DIR;

const BY = "ann@example.com";
const HOLDER = "ann@example.com on box";
const NOW = new Date("2026-11-20T10:00:00Z");
const ASSEMBLY = "sectors: [web]\nskills: []\n";
const STARTED =
  "build started · 3 repo file(s) in context · 1200 tokens · $0.12";
const titles = new Map<string, string>();
const dirOf = (id: string) => join(repo, TASKS_DIR, id);
const ledgerOf = (id: string) =>
  Ledger.open(dirOf(id), `${id} · ${titles.get(id)}`);

async function task(
  id: string,
  title: string,
  steps: [Beat, Section, string][],
): Promise<void> {
  await newTask(
    repo,
    {
      title,
      type: "feature",
      description: "A change worth watching.",
      acceptance: [{ id: "A1", text: "It works", verify: "unit" }],
    },
    { by: BY, now: NOW, id },
  );
  titles.set(id, title);
  await confirmTask(repo, id, { by: BY, now: NOW });
  await writeFile(join(dirOf(id), "assembly.yml"), ASSEMBLY);
  const ledger = await ledgerOf(id);
  await ledger.append({
    beat: "route",
    section: "timeline",
    text: `route approved; assembly sha256 ${sha256(ASSEMBLY)}`,
    by: BY,
    at: NOW,
  });
  for (const [beat, section, text] of steps)
    await ledger.append({ beat, section, text, by: BY, at: NOW });
}

const progress = (body: Partial<TaskProgress> & { at?: Date }) => {
  const at = (body.at ?? new Date()).toISOString();
  return writeFile(
    progressPath(repo, "T-0001"),
    JSON.stringify({
      beat: "build",
      startedAt: at,
      lastActivityAt: at,
      pid: process.pid,
      ...body,
      at: undefined,
    }),
  );
};

/** A process that has exited, so its pid is (almost certainly) no one's. */
const deadPid = () =>
  Number(
    execFileSync(
      process.execPath,
      ["-e", "process.stdout.write(String(process.pid))"],
      {
        encoding: "utf8",
      },
    ),
  );

async function state(): Promise<string> {
  const files: string[] = [];
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(
      () => [],
    )) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else
        files.push(`${relative(repo, full)}\n${await readFile(full, "utf8")}`);
    }
  };
  await walk(join(repo, ".rivetari"));
  return [
    ...files.sort(),
    git(repo, "for-each-ref"),
    git(repo, "status", "--porcelain"),
  ].join("\n---\n");
}

beforeEach(async () => {
  process.env.RIVETARI_CONFIG_DIR = await tmp("rivetari-config-");
  repo = await tmp("rivetari-repo-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "commit", "-q", "--allow-empty", "-m", "base", "--no-verify");
  // T-0001 is building on this machine.
  await task("T-0001", "Running task", [
    ["isolate", "timeline", "worktree .worktrees/T-0001 on rivetari/T-0001"],
    ["build", "timeline", STARTED],
  ]);
  // T-0002 is here and on the branch; T-0003 only on the branch.
  await task("T-0002", "Pushed task", [["build", "timeline", STARTED]]);
  await commitTask(repo, "T-0002", {
    holder: HOLDER,
    message: "T-0002: build",
    now: NOW,
  });
  await task("T-0003", "Elsewhere task", [["build", "timeline", STARTED]]);
  await commitTask(repo, "T-0003", {
    holder: HOLDER,
    message: "T-0003: build",
    now: NOW,
  });
  await rm(dirOf("T-0003"), { recursive: true, force: true });
});
afterEach(async () => {
  if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
  else process.env.RIVETARI_CONFIG_DIR = savedConfig;
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

function recorder() {
  const events: TaskEvent[] = [];
  const until = <K extends TaskEvent["kind"]>(
    kind: K,
    pick: (e: Extract<TaskEvent, { kind: K }>) => boolean,
  ) =>
    vi.waitFor(
      () => {
        const hit = events.find(
          (e): e is Extract<TaskEvent, { kind: K }> =>
            e.kind === kind && pick(e as never),
        );
        if (!hit) throw new Error(`no ${kind} event yet`);
        return hit;
      },
      { timeout: 15_000, interval: 25 },
    );
  return { events, until };
}

// Real git: slow on Windows.
describe("the fast first list", { timeout: 30_000 }, () => {
  it("lists this machine's copies first, then merges the branch's view in", async () => {
    const { events, until } = recorder();
    const watcher = watchTasks(repo, (e) => events.push(e), {
      intervalMs: 50,
      localFirst: true,
    });
    const first = await watcher.ready;
    expect(events[0]).toEqual({ kind: "snapshot", tasks: first });
    // Read in place: T-0002 as this machine has it, T-0003 not yet.
    expect(first.map((t) => [t.id, t.source])).toEqual([
      ["T-0001", "local"],
      ["T-0002", "local"],
    ]);
    expect(first[0]).toMatchObject({
      beat: "build",
      tokens: 1200,
      needsYou: null,
    });

    expect(
      (await until("added", (e) => e.task.id === "T-0003")).task.source,
    ).toBe("branch");
    const merged = await until("changed", (e) => e.task.id === "T-0002");
    expect(merged.task.source).toBe("branch");
    expect(merged.newEntries).toEqual([]);
    await watcher.stop();
  });

  it("writes nothing, not even the ledger view loadTask would render again", async () => {
    await appendFile(join(dirOf("T-0001"), "ledger.md"), "\nstale\n");
    const before = await state();
    const watcher = watchTasks(repo, () => undefined, {
      localFirst: true,
      intervalMs: 60_000,
    });
    const first = await watcher.ready;
    expect(first.find((t) => t.id === "T-0001")?.problems).toEqual([]);
    await watcher.stop();
    expect(await state()).toBe(before);
  });
});

describe("a running beat's progress", { timeout: 30_000 }, () => {
  it("is on the task's view, and a change to it alone streams as a change", async () => {
    await progress({ turns: 3, tokens: 9000, lastTool: "Read" });
    const { events, until } = recorder();
    const watcher = watchTasks(repo, (e) => events.push(e), {
      intervalMs: 50,
      localFirst: true,
    });
    const first = await watcher.ready;
    expect(first[0]?.progress).toMatchObject({
      beat: "build",
      turns: 3,
      lastTool: "Read",
    });
    expect(first[1]?.progress).toBeNull();

    await progress({ turns: 18, tokens: 52000, lastTool: "Edit" });
    const moved = await until("changed", (e) => e.task.progress?.turns === 18);
    expect(moved).toMatchObject({
      newEntries: [],
      previousBeat: "build",
      closed: false,
    });
    expect(moved.task.progress).toMatchObject({
      lastTool: "Edit",
      tokens: 52000,
    });

    await rm(progressPath(repo, "T-0001"));
    await until(
      "changed",
      (e) => e.task.id === "T-0001" && e.task.progress === null,
    );
    await watcher.stop();
  });

  it("counts a ledger entry as activity, and ignores a file a dead process left", async () => {
    const long = new Date(Date.now() - 20 * 60_000);
    await progress({ beat: "judge", at: long });
    // The ledger last written before the beat started: the beat's own time stands.
    const earlier = new Date(long.getTime() - 60_000);
    await utimes(join(dirOf("T-0001"), "ledger.jsonl"), earlier, earlier);
    const quiet = (await readTasks(repo)).find((t) => t.id === "T-0001");
    expect(quiet?.progress?.lastActivityAt).toBe(long.toISOString());

    await (
      await ledgerOf("T-0001")
    ).append({
      beat: "build",
      section: "timeline",
      text: "build done · commit abc1234 · 1 file(s) this round",
      by: BY,
    });
    const after = (await readTasks(repo)).find((t) => t.id === "T-0001");
    expect(
      Date.now() - Date.parse(after?.progress?.lastActivityAt ?? ""),
    ).toBeLessThan(60_000);

    await progress({ pid: deadPid() });
    expect(
      (await readTasks(repo)).find((t) => t.id === "T-0001")?.progress,
    ).toBeNull();
  });
});
