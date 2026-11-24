import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadTask, TASKS_BRANCH } from "@arynbht/rivetari-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectField } from "../../shared/ipc";
import type { ProjectCheck } from "./project";
import {
  type ProfileDraftDeps,
  draftProfileTask,
  profileCard,
} from "./project-task";

// The Project view never writes profile.yml: "Update the profile" drafts a
// card through the runtime that lists each field's change, from → to, with
// one criterion per field, and leaves it at intake.

const BY = "dev@example.com";

const field = (
  key: string,
  change: ProjectField["change"],
  evidence: string | null = null,
): ProjectField => ({
  key,
  label: key,
  declared: change?.from ?? "x",
  detected: change?.to ?? "x",
  evidence,
  differs: change !== null,
  change,
});

const FIELDS: ProjectField[] = [
  field("name", null),
  field(
    "stack",
    { path: "stack", from: "none", to: "node" },
    "The manifests show node, which profile.yml doesn't name.",
  ),
  field("phase", { path: "phase", from: "scaffold", to: "build" }),
  field("flags.uses-ai", {
    path: "flags.uses-ai",
    from: "not set",
    to: "true",
  }),
];

const ctx = { checkedAt: "2026-11-24T10:00:00.000Z", by: BY };

describe("profileCard", () => {
  it("lists each change from → to, with one criterion per field", () => {
    const card = profileCard(FIELDS, ["stack", "phase", "flags.uses-ai"], ctx);
    expect(card.title).toBe(
      "Bring profile.yml up to date: stack, phase, flags.uses-ai",
    );
    expect(card.type).toBe("chore");
    expect(card.description).toContain(
      "- stack: none → node (The manifests show node, which profile.yml doesn't name.)",
    );
    expect(card.description).toContain("- phase: scaffold → build");
    expect(card.description).toContain("- flags.uses-ai: not set → true");
    expect(card.description).toContain("checked it at 2026-11-24 10:00 UTC");
    expect(card.acceptance).toEqual([
      {
        id: "A1",
        text: ".rivetari/profile.yml sets stack to node (it was none)",
        verify: "review",
      },
      {
        id: "A2",
        text: ".rivetari/profile.yml sets phase to build (it was scaffold)",
        verify: "review",
      },
      {
        id: "A3",
        text: ".rivetari/profile.yml sets flags.uses-ai to true (it was not set)",
        verify: "review",
      },
    ]);
    expect(card.touches).toEqual([".rivetari/profile.yml"]);
    expect(card.constraints).toEqual([
      ".rivetari/profile.yml is a protected path, so the judge hands this change to a person before it can merge",
    ]);
  });

  it("names a single field in the title", () => {
    expect(profileCard(FIELDS, ["phase"], ctx).title).toBe(
      "Update profile.yml: phase",
    );
  });

  it("refuses a field that matches the repo, or one it doesn't check", () => {
    expect(() => profileCard(FIELDS, ["name"], ctx)).toThrow(
      /name matches the repo now/,
    );
    expect(() => profileCard(FIELDS, ["license"], ctx)).toThrow(
      /license isn't a profile field Rivetari checks/,
    );
  });
});

describe("draftProfileTask", () => {
  const check = (over: Partial<ProjectCheck> = {}): ProjectCheck => ({
    repoPath: "/repo",
    checkedAt: ctx.checkedAt,
    profileFound: true,
    fields: FIELDS,
    otherFlags: [],
    problems: [],
    ...over,
  });

  function fakes(overrides: Partial<ProfileDraftDeps> = {}): ProfileDraftDeps {
    return {
      whoami: vi.fn(async () => BY),
      checkProject: vi.fn(async () => check()),
      reserveTaskId: vi.fn(async () => "T-0004"),
      newTask: vi.fn(
        async (_repo, input) =>
          ({ card: { title: input.title } }) as Awaited<
            ReturnType<ProfileDraftDeps["newTask"]>
          >,
      ),
      commitTask: vi.fn(async () => undefined),
      ...overrides,
    };
  }

  it("checks the repo again, reserves an id, drafts and pushes", async () => {
    const deps = fakes();
    expect(await draftProfileTask("/repo", ["stack"], deps)).toEqual({
      id: "T-0004",
      title: "Update profile.yml: stack",
      by: BY,
      warning: null,
    });
    expect(deps.checkProject).toHaveBeenCalledWith("/repo");
    expect(vi.mocked(deps.commitTask).mock.calls[0]?.[2].message).toBe(
      "T-0004: drafted",
    );
  });

  it("refuses before reserving an id when there's no profile or nothing differs", async () => {
    const none = fakes({
      checkProject: vi.fn(async () =>
        check({
          profileFound: false,
          problems: ["There's no .rivetari/profile.yml"],
        }),
      ),
    });
    await expect(draftProfileTask("/repo", ["stack"], none)).rejects.toThrow(
      /no readable \.rivetari\/profile\.yml/,
    );
    expect(none.reserveTaskId).not.toHaveBeenCalled();

    const matched = fakes();
    await expect(draftProfileTask("/repo", ["name"], matched)).rejects.toThrow(
      /matches the repo now/,
    );
    expect(matched.reserveTaskId).not.toHaveBeenCalled();
  });

  it("keeps a drafted card when only the push fails, and says so", async () => {
    const deps = fakes({
      commitTask: vi.fn(async () => {
        throw new Error("origin is unreachable");
      }),
    });
    const result = await draftProfileTask("/repo", ["phase"], deps);
    expect(result.warning).toMatch(/pushing it failed: origin is unreachable/);
  });

  describe("against a real repo", () => {
    let repo = "";
    const savedKey = process.env.RIVETARI_LEDGER_KEY;
    const PROFILE =
      "version: 1\nname: shop\ntype: web-app\nstack: []\nflags: {}\nphase: scaffold\n";
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

    beforeEach(async () => {
      repo = await mkdtemp(join(tmpdir(), "rivetari-desktop-profile-task-"));
      process.env.RIVETARI_LEDGER_KEY = "cd".repeat(32);
      await mkdir(join(repo, ".rivetari"), { recursive: true });
      await writeFile(join(repo, ".rivetari", "profile.yml"), PROFILE);
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({ name: "shop", dependencies: { react: "19" } }),
      );
      git("init", "-q", "-b", "main");
      git("config", "user.email", BY);
      git("config", "user.name", "Dev");
      git("add", "-A");
      git("commit", "-q", "-m", "init");
    });

    afterEach(async () => {
      if (savedKey === undefined) delete process.env.RIVETARI_LEDGER_KEY;
      else process.env.RIVETARI_LEDGER_KEY = savedKey;
      await rm(repo, { recursive: true, force: true });
    });

    it("records the card at intake and leaves profile.yml as it was", async () => {
      const result = await draftProfileTask(repo, ["stack"]);
      expect(result).toMatchObject({ id: "T-0001", by: BY, warning: null });

      const task = await loadTask(repo, "T-0001", { readOnly: true });
      expect(task.beat).toBe("intake");
      expect(task.confirmed).toBe(false);
      expect(task.problems).toEqual([]);
      expect(task.card.touches).toEqual([".rivetari/profile.yml"]);
      expect(task.card.acceptance.map((a) => a.text)).toEqual([
        ".rivetari/profile.yml sets stack to node (it was none)",
      ]);
      expect(git("show", `${TASKS_BRANCH}:T-0001/card.yml`)).toContain(
        "sets stack to node",
      );
      expect(
        await readFile(join(repo, ".rivetari", "profile.yml"), "utf8"),
      ).toBe(PROFILE);
      expect(git("log", "--format=%s", "main")).toBe("init");
    });
  });
});
