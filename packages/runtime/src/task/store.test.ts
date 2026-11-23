import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  commitTask,
  LeaseError,
  pullTasks,
  reserveTaskId,
  StoreError,
  taskLease,
  TASKS_BRANCH,
} from "./store.js";

const made: string[] = [];
afterEach(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});
const lasting: string[] = [];
afterAll(async () => {
  for (const d of lasting) await rm(d, { recursive: true, force: true });
  lasting.length = 0;
});
const tmp = async (prefix: string, into = made) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  into.push(dir);
  return dir;
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** An origin and two clones of it: two machines working on one repo. */
async function twoMachines(into = made): Promise<{
  origin: string;
  a: string;
  b: string;
}> {
  const origin = await tmp("rivetari-origin-", into);
  await cp(seeded, origin, { recursive: true });
  const clone = async () => {
    const dir = await tmp("rivetari-clone-", into);
    git(dir, "clone", "-q", origin, ".");
    return dir;
  };
  return { origin, a: await clone(), b: await clone() };
}

let seeded = "";
beforeAll(async () => {
  seeded = await tmp("rivetari-origin-", lasting);
  git(seeded, "init", "--bare", "-b", "main");
  const seed = await tmp("rivetari-seed-", lasting);
  git(seed, "init", "-b", "main");
  git(seed, "config", "user.email", "t@t");
  git(seed, "config", "user.name", "t");
  await writeFile(join(seed, "README.md"), "# demo\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "base", "--no-verify");
  git(seed, "push", "-q", seeded, "main");
});

const writeTask = async (repo: string, id: string, ledger: string) => {
  const dir = join(repo, ".rivetari", "tasks", id);
  await mkdir(join(dir, "judge"), { recursive: true });
  await writeFile(join(dir, "card.yml"), `id: ${id}\n`);
  await writeFile(join(dir, "ledger.jsonl"), ledger);
  await writeFile(join(dir, "judge", "round-1.json"), "{}\n");
};
const read = (repo: string, ...p: string[]) =>
  readFile(join(repo, ".rivetari", "tasks", ...p), "utf8");

const NOW = new Date("2026-11-12T10:00:00Z");
const LATER = new Date("2026-11-12T13:00:00Z"); // past a 2h lease

// Real git against a local origin: slow on Windows.
describe("the task store", { timeout: 30_000 }, () => {
  it("puts a task on the branch, where another machine picks it up", async () => {
    const { origin, a, b } = await twoMachines();
    await writeTask(a, "T-0001", '{"seq":1}\n');
    await commitTask(a, "T-0001", {
      holder: "ann on a",
      message: "T-0001: drafted",
      now: NOW,
    });
    // Only the task's files, on an orphan branch; the product branch is untouched.
    expect(
      git(origin, "ls-tree", "-r", "--name-only", TASKS_BRANCH).split("\n"),
    ).toEqual([
      "T-0001/card.yml",
      "T-0001/judge/round-1.json",
      "T-0001/lease.json",
      "T-0001/ledger.jsonl",
    ]);
    expect(git(origin, "rev-list", "--count", TASKS_BRANCH)).toBe("1");

    await pullTasks(b);
    expect(await read(b, "T-0001", "ledger.jsonl")).toBe('{"seq":1}\n');
    expect(await read(b, "T-0001", "judge", "round-1.json")).toBe("{}\n");
  });

  describe("keeps a second machine off a task until the lease expires or is released", () => {
    let a = "";
    let b = "";
    beforeAll(async () => {
      ({ a, b } = await twoMachines(lasting));
      await writeTask(a, "T-0001", '{"seq":1}\n');
      await commitTask(a, "T-0001", {
        holder: "ann on a",
        message: "m",
        now: NOW,
      });
    });

    it("refuses the second machine, pulled as the CLI does, while the lease holds", async () => {
      await pullTasks(b);
      await expect(
        commitTask(b, "T-0001", { holder: "bob on b", message: "m", now: NOW }),
      ).rejects.toThrow(LeaseError);
    });

    it("lets the second machine take the task over past the lease", async () => {
      await expect(
        commitTask(b, "T-0001", {
          holder: "bob on b",
          message: "m",
          now: LATER,
        }),
      ).resolves.toBeUndefined();
    });

    it("and carry on with it, holding the lease", async () => {
      await writeTask(b, "T-0001", '{"seq":1}\n{"seq":2}\n');
      await commitTask(b, "T-0001", {
        holder: "bob on b",
        message: "m",
        now: LATER,
      });
      expect((await taskLease(a, "T-0001"))?.holder).toBe("bob on b");
    });

    it("then refuses the first machine, which pulls the new entries over its stale copy", async () => {
      await expect(
        commitTask(a, "T-0001", {
          holder: "ann on a",
          message: "m",
          now: LATER,
        }),
      ).rejects.toThrow(/held by bob on b/);
      await pullTasks(a);
      expect(await read(a, "T-0001", "ledger.jsonl")).toBe(
        '{"seq":1}\n{"seq":2}\n',
      );
    });

    it("lets the holder release the task", async () => {
      await expect(
        commitTask(b, "T-0001", {
          holder: "bob on b",
          message: "m",
          now: LATER,
          release: true,
        }),
      ).resolves.toBeUndefined();
    });

    it("lets a released task be taken at once", async () => {
      await expect(
        commitTask(a, "T-0001", {
          holder: "ann on a",
          message: "m",
          now: LATER,
        }),
      ).resolves.toBeUndefined();
    });
  });

  it("keeps this machine's copy of a task it holds when pulling", async () => {
    const { a } = await twoMachines();
    await writeTask(a, "T-0001", '{"seq":1}\n');
    await commitTask(a, "T-0001", {
      holder: "ann on a",
      message: "m",
      now: NOW,
    });
    await writeTask(a, "T-0001", '{"seq":1}\n{"seq":2}\n'); // not pushed yet
    await pullTasks(a);
    expect(await read(a, "T-0001", "ledger.jsonl")).toBe(
      '{"seq":1}\n{"seq":2}\n',
    );
  });

  describe("never deletes a record no push has carried, even after its lease expired", () => {
    let origin = "";
    let a = "";
    beforeAll(async () => {
      ({ origin, a } = await twoMachines(lasting));
      await writeTask(a, "T-0001", '{"seq":1}\n');
      await commitTask(a, "T-0001", {
        holder: "ann on a",
        message: "m",
        now: NOW,
      });
    });

    it("fails a beat's push while origin is unreachable", async () => {
      await writeTask(a, "T-0001", '{"seq":1}\n{"seq":2}\n');
      git(a, "remote", "set-url", "origin", join(origin, "gone"));
      await expect(
        commitTask(a, "T-0001", { holder: "ann on a", message: "m", now: NOW }),
      ).rejects.toThrow(StoreError);
      git(a, "remote", "set-url", "origin", origin);
    });

    it("keeps the unpushed copy past the lease on a pull, and says so", async () => {
      expect(await pullTasks(a)).toEqual({ kept: ["T-0001"] });
      expect(await read(a, "T-0001", "ledger.jsonl")).toBe(
        '{"seq":1}\n{"seq":2}\n',
      );
    });

    it("carries the kept copy on the next write", async () => {
      await commitTask(a, "T-0001", {
        holder: "ann on a",
        message: "m",
        now: LATER,
      });
      expect(git(origin, "show", `${TASKS_BRANCH}:T-0001/ledger.jsonl`)).toBe(
        '{"seq":1}\n{"seq":2}',
      );
      expect(await pullTasks(a)).toEqual({ kept: [] });
    });
  });

  describe("won't let a kept copy overwrite what someone else pushed since", () => {
    let origin = "";
    let a = "";
    beforeAll(async () => {
      let b = "";
      ({ origin, a, b } = await twoMachines(lasting));
      await writeTask(a, "T-0001", '{"seq":1}\n');
      await commitTask(a, "T-0001", {
        holder: "ann on a",
        message: "m",
        now: NOW,
      });
      await writeTask(a, "T-0001", '{"seq":1}\n{"ann":2}\n');
      await pullTasks(b);
      await commitTask(b, "T-0001", {
        holder: "bob on b",
        message: "m",
        now: LATER,
      });
      await writeTask(b, "T-0001", '{"seq":1}\n{"bob":2}\n');
      await commitTask(b, "T-0001", {
        holder: "bob on b",
        message: "m",
        now: LATER,
        release: true,
      });
    });

    it("keeps an offline copy that was never pushed, but can't push it over the taker's", async () => {
      expect(await pullTasks(a)).toEqual({ kept: ["T-0001"] });
      await expect(
        commitTask(a, "T-0001", {
          holder: "ann on a",
          message: "m",
          now: new Date(LATER.getTime() + 60_000),
        }),
      ).rejects.toThrow(/isn't the branch's: bob on b has written it since/);
      expect(git(origin, "show", `${TASKS_BRANCH}:T-0001/ledger.jsonl`)).toBe(
        '{"seq":1}\n{"bob":2}',
      );
    });
  });

  it("renews only the lease on a heartbeat", async () => {
    const { origin, a } = await twoMachines();
    await writeTask(a, "T-0001", '{"seq":1}\n');
    await commitTask(a, "T-0001", {
      holder: "ann on a",
      message: "m",
      now: NOW,
    });
    await writeTask(a, "T-0001", '{"seq":1}\n{"half-written'); // mid-beat
    await commitTask(a, "T-0001", {
      holder: "ann on a",
      message: "m",
      now: LATER,
      leaseOnly: true,
    });
    expect(git(origin, "show", `${TASKS_BRANCH}:T-0001/ledger.jsonl`)).toBe(
      '{"seq":1}',
    );
    expect(
      JSON.parse(git(origin, "show", `${TASKS_BRANCH}:T-0001/lease.json`))
        .expires,
    ).toBe("2026-11-12T15:00:00.000Z");
  });

  it("only puts tasks that exist on the branch", async () => {
    const { a } = await twoMachines();
    await expect(
      commitTask(a, "T-0099", { holder: "ann on a", message: "m" }),
    ).rejects.toThrow(/no task T-0099/);
    expect(git(a, "branch", "--list", TASKS_BRANCH)).toBe("");
  });

  it("gives an id back when the push that would reserve it fails", async () => {
    const { origin, a } = await twoMachines();
    git(a, "config", "remote.origin.pushurl", join(origin, "gone"));
    await expect(
      reserveTaskId(a, { holder: "ann on a", now: NOW }),
    ).rejects.toThrow(/couldn't push/);
    await expect(read(a, "T-0001", "lease.json")).rejects.toThrow();
    expect(git(a, "branch", "--list", TASKS_BRANCH)).toBe("");
    git(a, "config", "--unset", "remote.origin.pushurl");
    expect(await reserveTaskId(a, { holder: "ann on a", now: NOW })).toBe(
      "T-0001",
    );
  });

  describe("gives two machines different ids, and refuses to reuse one", () => {
    let a = "";
    let b = "";
    let first = "";
    beforeAll(async () => {
      ({ a, b } = await twoMachines(lasting));
    });

    it("gives the first machine an id", async () => {
      first = await reserveTaskId(a, { holder: "ann on a", now: NOW });
      expect(first).toBe("T-0001");
    });

    it("gives the second machine a different one", async () => {
      const second = await reserveTaskId(b, { holder: "bob on b", now: NOW });
      expect([first, second]).toEqual(["T-0001", "T-0002"]);
    });

    it("refuses to reuse one", async () => {
      await expect(
        commitTask(b, "T-0001", {
          holder: "bob on b",
          message: "m",
          now: LATER,
          create: true,
        }),
      ).rejects.toThrow(StoreError);
    });
  });

  describe("appends history rows once each, beside the tasks", () => {
    const row = (id: string, minutes = 1) =>
      JSON.stringify({ kind: "task", task: id, minutes });
    let origin = "";
    let a = "";
    beforeAll(async () => {
      let b = "";
      ({ origin, a, b } = await twoMachines(lasting));
      await writeTask(a, "T-0001", "{}\n");
      await writeTask(b, "T-0002", "{}\n");
      await commitTask(a, "T-0001", {
        holder: "ann on a",
        message: "m",
        history: [row("T-0001")],
      });
      await commitTask(b, "T-0002", {
        holder: "bob on b",
        message: "m",
        history: [row("T-0002")],
      });
    });

    it("doesn't add a row twice when a close is resumed after a failure", async () => {
      await commitTask(a, "T-0001", {
        holder: "ann on a",
        message: "m",
        history: [row("T-0001", 2)],
      });
      expect(git(origin, "show", `${TASKS_BRANCH}:history.jsonl`)).toBe(
        `${row("T-0001")}\n${row("T-0002")}`,
      );
    });
  });

  it("keeps the branch local in a repo with no origin", async () => {
    const repo = await tmp("rivetari-local-");
    git(repo, "init", "-b", "main");
    await writeTask(repo, "T-0001", "{}\n");
    await commitTask(repo, "T-0001", { holder: "ann on a", message: "m" });
    expect(git(repo, "ls-tree", "--name-only", TASKS_BRANCH)).toBe("T-0001");
    expect(await reserveTaskId(repo, { holder: "ann on a" })).toBe("T-0002");
  });
});
