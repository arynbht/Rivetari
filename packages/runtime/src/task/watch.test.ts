import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
  appendFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Beat, Ledger, type Section } from "./ledger.js";
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
const CARD = {
  type: "feature" as const,
  description: "A change worth watching.",
  acceptance: [{ id: "A1", text: "It works", verify: "unit" as const }],
};
const ASSEMBLY = "sectors: [web]\nskills: []\n";
const STARTED =
  "build started · 3 repo file(s) in context · 1200 tokens · $0.12";

const dirOf = (id: string) => join(repo, TASKS_DIR, id);
const titles = new Map<string, string>();
const ledgerOf = (id: string) =>
  Ledger.open(dirOf(id), `${id} · ${titles.get(id)}`);

/**
 * A confirmed, routed task, then whatever entries the case needs. The id is
 * given, as the branch would reserve it: T-0003 is only on the branch.
 */
async function task(
  id: string,
  title: string,
  steps: [Beat, Section, string][],
): Promise<string> {
  await newTask(repo, { ...CARD, title }, { by: BY, now: NOW, id });
  titles.set(id, title);
  await confirmTask(repo, id, { by: BY, now: NOW });
  await writeFile(join(dirOf(id), "assembly.yml"), ASSEMBLY);
  const ledger = await ledgerOf(id);
  const append = (beat: Beat, section: Section, text: string) =>
    ledger.append({ beat, section, text, by: BY, at: NOW });
  await append(
    "route",
    "timeline",
    `route approved; assembly sha256 ${sha256(ASSEMBLY)}`,
  );
  for (const [beat, section, text] of steps) await append(beat, section, text);
  return id;
}

/** Everything a read could have written: the task files, the refs, the work tree. */
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

const scratches = async () =>
  (await readdir(tmpdir()))
    .filter((n) => n.startsWith("rivetari-watch-"))
    .sort();

beforeEach(async () => {
  // A private ledger key per test run, never the developer's real one.
  process.env.RIVETARI_CONFIG_DIR = await tmp("rivetari-config-");
  repo = await tmp("rivetari-repo-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  await writeFile(join(repo, "README.md"), "# demo\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base", "--no-verify");

  // T-0001 is running on this machine and holds its lease.
  await task("T-0001", "Running task", [
    ["isolate", "timeline", "worktree .worktrees/T-0001 on rivetari/T-0001"],
    ["build", "timeline", STARTED],
  ]);
  await writeFile(
    join(dirOf("T-0001"), "lease.json"),
    JSON.stringify({ holder: HOLDER, expires: "2099-01-01T00:00:00.000Z" }),
  );
  // T-0002 stopped to ask, and is on the branch as well as here.
  await task("T-0002", "Stopped task", [
    ["isolate", "timeline", "worktree .worktrees/T-0002 on rivetari/T-0002"],
    ["build", "timeline", STARTED],
    ["build", "stop", "asked: dependency: adds left-pad"],
    [
      "build",
      "timeline",
      "build paused: 1 thing(s) to ask about · commit abc1234 · 500 tokens · $0.05",
    ],
  ]);
  await commitTask(repo, "T-0002", {
    holder: HOLDER,
    message: "T-0002: build",
    now: NOW,
  });
  // T-0003 shipped from another machine: it's only on the branch.
  await task("T-0003", "Shipped task", [
    ["isolate", "timeline", "worktree .worktrees/T-0003 on rivetari/T-0003"],
    ["build", "timeline", STARTED],
    [
      "build",
      "timeline",
      "build done · commit abc1234 · 2 file(s) this round · 800 tokens · $0.08",
    ],
    ["prove", "timeline", "proof passed · tests"],
    [
      "judge",
      "timeline",
      "judge passed · round 1 · head 0123456789ab · record sha256 00",
    ],
    [
      "ship",
      "timeline",
      "draft PR opened: #42 https://github.com/o/r/pull/42 · rivetari/T-0003 at 0123456789ab → main",
    ],
  ]);
  await commitTask(repo, "T-0003", {
    holder: HOLDER,
    message: "T-0003: ship",
    now: NOW,
    release: true,
  });
  await rm(dirOf("T-0003"), { recursive: true, force: true });
});
afterEach(async () => {
  if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
  else process.env.RIVETARI_CONFIG_DIR = savedConfig;
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

// Real git: slow on Windows.
describe("watching tasks", { timeout: 30_000 }, () => {
  it("reads every task from the branch and this machine, with what a person needs to see", async () => {
    const [running, stopped, shipped] = await readTasks(repo);

    expect(running).toMatchObject({
      id: "T-0001",
      title: "Running task",
      beat: "build",
      source: "local",
      lease: { holder: HOLDER, expires: "2099-01-01T00:00:00.000Z" },
      buildRounds: 0,
      judgeRounds: 0,
      tokens: 1200,
      pr: null,
      needsYou: null,
      done: false,
      problems: [],
    });
    expect(running?.next).toMatch(/^build: /);
    expect(running?.costUsd).toBeCloseTo(0.12);

    expect(stopped).toMatchObject({
      id: "T-0002",
      source: "branch",
      beat: "build",
      lease: { holder: HOLDER },
      buildRounds: 1,
      tokens: 1700,
      needsYou: { kind: "stop", why: "dependency: adds left-pad" },
    });
    expect(stopped?.next).toMatch(/^stop-and-ask: /);

    expect(shipped).toMatchObject({
      id: "T-0003",
      source: "branch",
      beat: "ship",
      buildRounds: 1,
      judgeRounds: 1,
      tokens: 2000,
      pr: { number: 42, url: "https://github.com/o/r/pull/42" },
      needsYou: null,
    });
    expect(shipped?.costUsd).toBeCloseTo(0.2);
    expect(shipped?.entries.at(-1)?.text).toMatch(/^draft PR opened: #42/);
  });

  it("says why a task waits on a person: the judge, the route, the card", async () => {
    await task("T-0004", "Escalated task", [
      [
        "judge",
        "stop",
        "asked: judge: 2 blocking after 2 rounds; look at the change",
      ],
      [
        "judge",
        "timeline",
        "judge needs a human · round 3 · head 0123456789ab · 2 blocking after 2 rounds",
      ],
    ]);
    await newTask(
      repo,
      { ...CARD, title: "Unconfirmed" },
      { by: BY, now: NOW, id: "T-0005" },
    );
    await newTask(
      repo,
      { ...CARD, title: "Proposed" },
      { by: BY, now: NOW, id: "T-0006" },
    );
    await confirmTask(repo, "T-0006", { by: BY, now: NOW });
    await writeFile(join(dirOf("T-0006"), "assembly.yml"), ASSEMBLY);
    const views = await readTasks(repo);
    expect(views.find((v) => v.id === "T-0004")?.needsYou).toEqual({
      kind: "judge",
      why: "2 blocking after 2 rounds; look at the change",
    });
    expect(views.find((v) => v.id === "T-0005")?.needsYou?.kind).toBe("intake");
    expect(views.find((v) => v.id === "T-0006")?.needsYou?.kind).toBe("route");
  });

  it("writes nothing: not the ledger, its view, the lease or a ref", async () => {
    // A view the renderer would redo; loadTask rewrites it, but never here.
    await appendFile(join(dirOf("T-0001"), "ledger.md"), "\nstale\n");
    const before = await state();
    const views = await readTasks(repo);
    expect(views.find((v) => v.id === "T-0001")?.problems).toEqual([]);
    expect(await state()).toBe(before);
  });

  it("streams a snapshot, then new entries, new tasks and closes, and stops cleanly", async () => {
    const idle = await scratches();
    const events: TaskEvent[] = [];
    const watcher = watchTasks(repo, (e) => events.push(e), { intervalMs: 50 });
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

    const first = await watcher.ready;
    expect(first.map((t) => t.id)).toEqual(["T-0001", "T-0002", "T-0003"]);
    expect(events[0]).toEqual({ kind: "snapshot", tasks: first });
    expect((await scratches()).length).toBe(idle.length + 1);

    // A person answers T-0002 here; the branch hasn't had it yet, so this copy wins.
    const ledger = await ledgerOf("T-0002");
    await ledger.append({
      beat: "build",
      section: "stop",
      text: "answered: allowed",
      by: BY,
      at: NOW,
    });
    const answered = await until("changed", (e) => e.task.id === "T-0002");
    expect(answered.newEntries.map((e) => e.text)).toEqual([
      "answered: allowed",
    ]);
    expect(answered.task).toMatchObject({ source: "local", needsYou: null });
    expect(answered).toMatchObject({ previousBeat: "build", closed: false });

    const added = await task("T-0004", "Later task", []);
    expect((await until("added", (e) => e.task.id === added)).task.beat).toBe(
      "route",
    );

    const t1 = await ledgerOf("T-0001");
    await t1.append({
      beat: "close",
      section: "outcome",
      text: "abandoned: not needed",
      by: BY,
      at: NOW,
    });
    await t1.append({
      beat: "close",
      section: "timeline",
      text: "ledger sealed · abandoned",
      by: BY,
      at: NOW,
    });
    const closed = await until(
      "changed",
      (e) => e.task.id === "T-0001" && e.closed,
    );
    expect(closed).toMatchObject({
      previousBeat: "build",
      task: { beat: "close", done: true, next: "done" },
    });

    await rm(dirOf(added), { recursive: true, force: true });
    await until("removed", (e) => e.id === added);

    await watcher.stop();
    expect(await scratches()).toEqual(idle);
    const seen = events.length;
    await (
      await ledgerOf("T-0002")
    ).append({
      beat: "build",
      section: "timeline",
      text: "build started",
      by: BY,
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(events.length).toBe(seen);
  });

  it("tells whoever awaits the first snapshot when it was stopped first", async () => {
    const watcher = watchTasks(repo, () => undefined);
    await watcher.stop();
    await expect(watcher.ready).rejects.toThrow(
      /stopped before its first read/,
    );
  });

  it("keeps going, and stops cleanly, when the listener throws", async () => {
    const idle = await scratches();
    const heard: unknown[] = [];
    const watcher = watchTasks(
      repo,
      () => {
        throw new Error("listener broke");
      },
      { intervalMs: 50, onListenerError: (err) => heard.push(err) },
    );
    expect((await watcher.ready).length).toBe(3);
    await watcher.stop();
    expect(heard).toEqual([new Error("listener broke")]);
    expect(await scratches()).toEqual(idle);
  });

  it("reads this machine's copies in a folder that isn't a repo", async () => {
    await rm(join(repo, ".git"), { recursive: true, force: true });
    expect((await readTasks(repo)).map((t) => [t.id, t.source])).toEqual([
      ["T-0001", "local"],
      ["T-0002", "local"],
    ]);
  });
});
