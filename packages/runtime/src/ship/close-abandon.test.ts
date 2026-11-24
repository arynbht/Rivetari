// Abandon refuses while the task's work is still out there (the pilot's R-19:
// T-0015 and T-0016 were sealed with their PRs open, and T-0017 while its
// build ran), and close says what it did with the worktree and the branch
// (R-10: a merge's --delete-branch can't delete a branch a worktree holds).
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadManifests } from "@arynbht/rivetari-registry";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isolateTask, loadIsolation } from "../agent/isolate.js";
import {
  approveRoute,
  type RouteContext,
  routeTask,
} from "../router/task-route.js";
import { progressPath } from "../task/progress.js";
import { confirmTask, loadTask, newTask, nextStep } from "../task/tasks.js";
import { closeTask, type PrState } from "./close.js";

const made: string[] = [];
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
const by = { by: "dev@example.com", now: new Date("2026-11-24T05:21:00Z") };

const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
beforeEach(async () => {
  process.env.RIVETARI_CONFIG_DIR = await tmp("rivetari-config-");
});
afterEach(async () => {
  if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
  else process.env.RIVETARI_CONFIG_DIR = savedConfig;
  for (const d of made) {
    await simpleGit(d)
      .raw(["worktree", "prune"])
      .catch(() => undefined);
    await rm(d, { recursive: true, force: true });
  }
  made.length = 0;
});

/** A task isolated and shipped as PR #24, as T-0015 was when it was abandoned. */
async function shipped(): Promise<{ repo: string; id: string }> {
  const repo = await tmp("rivetari-close-");
  const git = simpleGit(repo);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "package.json"), '{ "name": "demo" }\n');
  await writeFile(join(repo, "src/total.js"), "exports.total = () => 0;\n");
  await git.add(["-A"]);
  await git.commit("base", ["--no-verify"]);
  const { manifests } = await loadManifests(repo);
  const context: RouteContext = {
    manifests,
    available: new Set(),
    flags: {},
    files: ["package.json", "src/total.js"],
    checks: ["quality.tests.pass"],
  };
  const draft = await newTask(
    repo,
    {
      title: "Fix total so it sums",
      type: "fix",
      description: "total() returns 0; it should sum its list.",
      acceptance: [{ id: "A1", text: "total sums a list", verify: "unit" }],
    },
    by,
  );
  const id = draft.card.id;
  await confirmTask(repo, id, by);
  await routeTask(repo, id, { ...by, context });
  await approveRoute(repo, id, { ...by, context });
  await isolateTask(repo, id, { ...by, base: "main" });
  await (
    await loadTask(repo, id)
  ).ledger.append({
    beat: "ship",
    section: "timeline",
    text: "draft PR opened: #24 https://github.com/BreathBand/breathband-console/pull/24 · fix/t-0001 at 0123456789ab → main",
    by: "rivetari runtime",
    at: by.now,
  });
  return { repo, id };
}

const pr = (state: PrState) => async (): Promise<PrState> => state;

describe("abandoning a task", () => {
  it("refuses while its PR is open, and says so", async () => {
    const { repo, id } = await shipped();
    await expect(
      closeTask(repo, id, {
        ...by,
        abandon: "redraft to route with the a11y skills",
        prState: pr({ state: "open", merged: false }),
      }),
    ).rejects.toThrow(
      `task ${id} still has work out there, so it isn't abandoned:\n  - PR #24 is open\n`,
    );
    expect(nextStep(await loadTask(repo, id))).not.toBe("done");
  });

  it("goes by the ledger's ship record when GitHub can't be asked", async () => {
    const { repo, id } = await shipped();
    await expect(
      closeTask(repo, id, {
        ...by,
        abandon: "",
        prState: async () => {
          throw new Error("no token");
        },
      }),
    ).rejects.toThrow(
      "PR #24: the ledger says it was opened, and GitHub couldn't be asked whether it's still open",
    );
  });

  it("refuses while a run is going, as T-0017's build was", async () => {
    const { repo, id } = await shipped();
    // The run's progress file, from a process that's alive: this test's parent.
    await writeFile(
      progressPath(repo, id),
      JSON.stringify({
        beat: "build",
        startedAt: "2026-11-24T05:10:00.000Z",
        lastActivityAt: "2026-11-24T05:20:00.000Z",
        pid: process.ppid,
      }),
    );
    await expect(
      closeTask(repo, id, {
        ...by,
        abandon: "",
        prState: pr({ state: "closed", merged: false }),
      }),
    ).rejects.toThrow(
      `its build beat is running (pid ${process.ppid}, since 2026-11-24 05:10)`,
    );
  });

  it("abandons anyway with force, leaving the PR as it is", async () => {
    const { repo, id } = await shipped();
    const { task, row } = await closeTask(repo, id, {
      ...by,
      abandon: "superseded",
      force: true,
      prState: () => {
        throw new Error("force doesn't ask GitHub");
      },
    });
    expect(row).toMatchObject({ outcome: "abandoned", pr: 24 });
    expect(await readFile(task.ledger.mdPath, "utf8")).toContain(
      "abandoned: superseded (PR #24 is left as it is)",
    );
  });

  it("goes ahead once the PR is closed and nothing runs", async () => {
    const { repo, id } = await shipped();
    const { row } = await closeTask(repo, id, {
      ...by,
      abandon: "not needed",
      prState: pr({ state: "closed", merged: false }),
    });
    expect(row.outcome).toBe("abandoned");
  });
});

describe("closing a merged task", () => {
  it("removes the worktree first, then deletes the merged branch, and says so", async () => {
    const { repo, id } = await shipped();
    const { cleanup } = await closeTask(repo, id, {
      ...by,
      prState: pr({ state: "closed", merged: true, mergedBy: "arynbht" }),
    });
    expect(cleanup).toBe("worktree removed · branch fix/t-0001 deleted");
    expect((await simpleGit(repo).branchLocal()).all).not.toContain(
      "fix/t-0001",
    );
  });

  it("still deletes the merged branch when the worktree was removed by hand", async () => {
    const { repo, id } = await shipped();
    const iso = (await loadIsolation(repo, id))!;
    await simpleGit(repo).raw(["worktree", "remove", "--force", iso.worktree]);
    const { cleanup } = await closeTask(repo, id, {
      ...by,
      prState: pr({ state: "closed", merged: true }),
    });
    expect(cleanup).toBe("worktree already gone · branch fix/t-0001 deleted");
    expect((await simpleGit(repo).branchLocal()).all).not.toContain(
      "fix/t-0001",
    );
  });
});
