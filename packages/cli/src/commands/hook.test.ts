import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newTask } from "@arynbht/rivetari-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { doctorChecks, tempCheck } from "./doctor.js";
import {
  guardReason,
  guardSelfTest,
  parseShell,
  sessionStartText,
} from "./hook.js";
import { SETTINGS_JSON } from "./init-files.js";

const made: string[] = [];
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeEach(async () => {
  process.env.RIVETARI_CONFIG_DIR = await tmp("rivetari-config-");
});
afterEach(async () => {
  if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
  else process.env.RIVETARI_CONFIG_DIR = savedConfig;
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

/** A repo on main with a rivetari profile, and a linked worktree on a task branch. */
async function rivetariRepo(): Promise<{ repo: string; worktree: string }> {
  const repo = await tmp("rivetari-hook-");
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  await mkdir(join(repo, ".rivetari"));
  await writeFile(join(repo, ".rivetari", "profile.yml"), "version: 1\n");
  await writeFile(join(repo, "README.md"), "# demo\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "base", "--no-verify");
  const worktree = join(repo, ".worktrees", "T-0001");
  git(repo, "worktree", "add", "-b", "fix/t-0001", worktree, "main");
  return { repo, worktree };
}

// How a path is written in a shell command (Git Bash takes C:/x too).
const posix = (path: string) => path.split("\\").join("/");

const edit = (cwd: string, file_path: string) =>
  guardReason({ cwd, tool_input: { file_path } });

describe("rivetari hook guard", () => {
  it("refuses edits in the primary checkout on main, new files included", async () => {
    const { repo } = await rivetariRepo();
    expect(await edit(repo, "README.md")).toMatch(
      /primary checkout on main.*\/rivetari/,
    );
    expect(await edit(repo, join(repo, "src", "new", "file.ts"))).toMatch(
      /primary checkout on main/,
    );
  });

  it("allows edits in a task's worktree, but never to .rivetari/**", async () => {
    const { repo, worktree } = await rivetariRepo();
    // The session's cwd is the primary checkout; the file is in the worktree.
    expect(await edit(repo, join(worktree, "README.md"))).toBeNull();
    expect(
      await edit(worktree, join(worktree, ".rivetari", "waivers.yml")),
    ).toMatch(/\.rivetari\/waivers\.yml is Rivetari's state/);
    expect(await edit(repo, ".rivetari/tasks/T-0001/ledger.md")).toMatch(
      /Rivetari's state/,
    );
  });

  it("still guards .rivetari/** when the checkout is reached through a symlink", async () => {
    const { repo } = await rivetariRepo();
    git(repo, "checkout", "-b", "by-hand");
    const link = join(await tmp("rivetari-link-"), "repo");
    // A junction on Windows (no admin rights needed), a symlink elsewhere.
    await symlink(repo, link, "junction");
    expect(await edit(link, join(link, ".rivetari", "waivers.yml"))).toMatch(
      /Rivetari's state/,
    );
    expect(await edit(link, join(link, "README.md"))).toBeNull();
  });

  it("allows edits on another branch, and in repos without a rivetari profile", async () => {
    const { repo } = await rivetariRepo();
    git(repo, "checkout", "-b", "by-hand");
    expect(await edit(repo, "README.md")).toBeNull();

    const plain = await tmp("plain-");
    git(plain, "init", "-b", "main");
    expect(await edit(plain, "README.md")).toBeNull();
    expect(await guardReason({ cwd: plain, tool_input: {} })).toBeNull();
  });
});

describe("parseShell", () => {
  it("finds commands, words and redirect targets the way a shell would", () => {
    expect(
      parseShell(
        `FOO=1 sed -i 's/a > b/c/' "my file.txt" && echo hi>out.txt 2>&1 | tee -a log.txt; cat <in.txt >>"app.log" 2>/dev/null`,
      ),
    ).toEqual([
      {
        words: ["FOO=1", "sed", "-i", "s/a > b/c/", "my file.txt"],
        redirects: [],
        then: "&&",
        depth: 0,
      },
      { words: ["echo", "hi"], redirects: ["out.txt"], then: "|", depth: 0 },
      { words: ["tee", "-a", "log.txt"], redirects: [], then: ";", depth: 0 },
      {
        words: ["cat"],
        redirects: ["app.log", "/dev/null"],
        then: "",
        depth: 0,
      },
    ]);
  });

  it("knows which commands run in a subshell", () => {
    expect(
      parseShell("(cd /tmp && ls); echo $(pwd) `date`").map((c) => [
        c.words[0],
        c.depth,
      ]),
    ).toEqual([
      ["cd", 1],
      ["ls", 1],
      ["echo", 0],
      ["pwd", 1],
      ["date", 1],
    ]);
  });

  it("treats heredoc bodies, comments and here-strings as data", () => {
    expect(
      parseShell(
        "cat > notes.md <<'EOF'\nrm -rf .rivetari\nEOF\n# rm x\ngrep x <<< 'rm y' # rm z\nls",
      ).map(({ words, redirects }) => ({ words, redirects })),
    ).toEqual([
      { words: ["cat"], redirects: ["notes.md"] },
      { words: ["grep", "x"], redirects: [] },
      { words: ["ls"], redirects: [] },
    ]);
  });
});

describe("rivetari hook guard, for Bash", () => {
  const bash = (cwd: string, command: string) =>
    guardReason({ cwd, tool_input: { command } });

  it("refuses writes through Bash to anything the edit guard protects", async () => {
    const { repo, worktree } = await rivetariRepo();
    for (const command of [
      "echo '[]' > .rivetari/waivers.yml",
      "cd .rivetari && sed -i 's/x/y/' waivers.yml",
      `cp /tmp/x ${posix(join(worktree, ".rivetari", "evidence.yml"))}`,
      "rm -rf .rivetari/*",
      "printf x | tee README.md",
      "mv README.md docs.md",
      // `-t` names the destination: the source is only read.
      "cp -t .rivetari /tmp/x",
      "install --target-directory=.rivetari /tmp/x",
      "echo x >& .rivetari/waivers.yml",
      "sudo -u root rm .rivetari/profile.yml",
      "env -i FOO=1 rm .rivetari/profile.yml",
      "echo x \\\n  > .rivetari/waivers.yml",
    ])
      expect(await bash(repo, command), command).toMatch(
        /this command (writes|removes) .*(Rivetari's state|primary checkout on main)/,
      );
  });

  it("refuses wiping the checkout, whichever way it's spelled", async () => {
    const { repo, worktree } = await rivetariRepo();
    for (const command of ["rm -rf *", "rm -rf .", `rm -rf "$PWD"`])
      expect(await bash(repo, command), command).toMatch(
        /this command (writes|removes)/,
      );
    // In a worktree: `.` holds .rivetari/**; `*` doesn't match dotfiles.
    expect(await bash(worktree, "rm -rf .")).toMatch(
      /\.rivetari\/\*\* with it/,
    );
    expect(await bash(worktree, "cd .. && rm -rf T-0001")).toMatch(
      /\.rivetari\/\*\* with it/,
    );
    expect(await bash(worktree, "rm -rf *")).toBeNull();
  });

  it("doesn't let a cd that may not have moved the shell hide a write", async () => {
    const { repo, worktree } = await rivetariRepo();
    const elsewhere = posix(await tmp("elsewhere-"));
    for (const command of [
      `(cd ${elsewhere} && ls); rm -rf .rivetari`,
      `cd /nonexistent; rm -rf .rivetari`,
      `cd ${elsewhere} || true && rm -rf .rivetari`,
      `cd ${elsewhere} | rm -rf .rivetari`,
    ])
      expect(await bash(worktree, command), command).toMatch(
        /\.rivetari\/\*\* with it/,
      );
    // A cd that certainly moved does count: scratch work elsewhere is fine.
    expect(await bash(repo, `cd ${elsewhere} && echo x > out.txt`)).toBeNull();
  });

  it("only sees sed -i and perl -i as in-place", async () => {
    const { repo } = await rivetariRepo();
    expect(await bash(repo, "sed -Ei 's/a/b/' README.md")).toMatch(
      /writes README\.md/,
    );
    expect(await bash(repo, "perl -pi -e 's/a/b/' README.md")).toMatch(
      /writes README\.md/,
    );
    expect(await bash(repo, "perl -Mstrict -e 'print 1' README.md")).toBeNull();
  });

  it("checks command lines run through sh -c and eval", async () => {
    const { repo } = await rivetariRepo();
    for (const command of [
      `bash -lc "echo x > .rivetari/waivers.yml"`,
      `sh -c 'git push --force'`,
      "eval rm .rivetari/profile.yml",
    ])
      expect(await bash(repo, command), command).not.toBeNull();
    expect(await bash(repo, `bash -c "git status"`)).toBeNull();
  });

  it("refuses Bash writes to .rivetari/** from a task's worktree too", async () => {
    const { worktree } = await rivetariRepo();
    for (const command of [
      "rm -rf .rivetari",
      "rm -rf .rivetari/*",
      "echo x > .rivetari/waivers.yml",
      "echo x > ${PWD}/.rivetari/waivers.yml",
    ])
      expect(await bash(worktree, command), command).toMatch(
        /this command (writes|removes) .*Rivetari's state/,
      );
  });

  it("lets reads, scratch writes and a task's worktree through", async () => {
    const { repo, worktree } = await rivetariRepo();
    for (const command of [
      "cat .rivetari/profile.yml && git status 2>&1",
      "npm test > /dev/null",
      `echo x > "${join(tmpdir(), "scratch.txt")}"`,
      "cat > notes.md <<'EOF'\nrm -rf .rivetari\nEOF",
      "sed 's/x/y/' README.md",
    ])
      expect(await bash(worktree, command), command).toBeNull();
    expect(
      await bash(repo, `echo x > ${posix(join(worktree, "README.md"))}`),
    ).toBeNull();
  });

  it("refuses git commands that destroy work, in a rivetari repo only", async () => {
    const { repo, worktree } = await rivetariRepo();
    for (const command of [
      "git push --force origin main",
      "git push -uf origin fix/t-0001",
      "git push origin +main",
      "git push origin --delete fix/t-0001",
      "git -C . reset --hard HEAD~1",
      "git clean -fdx",
      "git branch -D old",
    ])
      expect(await bash(worktree, command), command).toMatch(
        /run it yourself in a terminal/,
      );
    for (const command of [
      "git push -u origin fix/t-0001",
      "git push --force-if-includes-not-a-flag",
      "git clean -n",
      "git reset --soft HEAD~1",
      "git branch -d merged",
    ])
      expect(await bash(worktree, command), command).toBeNull();
    const plain = await tmp("plain-");
    git(plain, "init", "-b", "main");
    expect(await bash(plain, "git push --force")).toBeNull();
    expect(await bash(repo, "git status")).toBeNull();
  });
});

describe("rivetari hook session-start", () => {
  it("says on its first line whether the guard is on", async () => {
    const { repo } = await rivetariRepo();
    expect((await sessionStartText(repo)).split("\n")[0]).toMatch(
      /^rivetari guard: OFF\. no \.claude\/settings\.json/,
    );
    await mkdir(join(repo, ".claude"));
    await writeFile(join(repo, ".claude", "settings.json"), SETTINGS_JSON);
    expect((await sessionStartText(repo)).split("\n")[0]).toBe(
      "rivetari guard: on.",
    );
    // An earlier init's hook: no Bash, and it fails open.
    await writeFile(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Edit|Write|MultiEdit|NotebookEdit",
              hooks: [{ type: "command", command: "rivetari hook guard" }],
            },
          ],
        },
      }),
    );
    expect((await guardSelfTest(repo)).detail).toMatch(/older rivetari/);
  });

  it("states the contract and points at a missing AGENTS.md", async () => {
    const { repo } = await rivetariRepo();
    const text = await sessionStartText(repo);
    expect(text).toContain("Start every task with /rivetari");
    expect(text).toContain(
      "Beats: sync → intake → route → isolate → build → prove → judge → ship → close",
    );
    expect(text).toContain("AGENTS.md is missing");
  });

  it("lists the tasks waiting on a person under Needs you", async () => {
    const { repo } = await rivetariRepo();
    const waiting = await newTask(
      repo,
      {
        title: "Fix the login redirect",
        type: "fix",
        description: "After login the app lands on a blank page.",
        acceptance: [{ id: "A1", text: "lands on /home", verify: "e2e" }],
      },
      { by: "dev@example.com" },
    );
    const text = await sessionStartText(repo);
    expect(text).toContain(
      `Needs you:\n- ${waiting.card.id} Fix the login redirect: intake: review the card and confirm it`,
    );
  });
});

describe("rivetari doctor", () => {
  it("fails without a profile or the claude CLI, and warns without GitHub", async () => {
    const dir = await tmp("rivetari-doctor-");
    git(dir, "init", "-b", "main");
    const checks = await doctorChecks(dir, {
      token: null,
      claude: () => Promise.reject(new Error("not found")),
    });
    const by = Object.fromEntries(checks.map((c) => [c.name, c.status]));
    expect(by).toEqual({
      git: "ok",
      profile: "fail",
      claude: "fail",
      github: "warn",
      skills: "warn",
    });
  });

  it("passes a set-up repo whose hooks are live and skills match the lock", async () => {
    const { repo } = await rivetariRepo();
    await mkdir(join(repo, ".claude"));
    await writeFile(join(repo, ".claude", "settings.json"), SETTINGS_JSON);
    const checks = await doctorChecks(repo, {
      token: "t",
      claude: async () => "2.1.0 (Claude Code)",
      guardInShell: async () => true,
    });
    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(checks.find((c) => c.name === "claude")?.detail).toBe(
      "2.1.0 (Claude Code)",
    );
  });

  it("fails while the guard can't run: not installed, or rivetari off PATH", async () => {
    const { repo } = await rivetariRepo();
    const hooks = async (guardInShell: () => Promise<boolean>) =>
      (
        await doctorChecks(repo, {
          token: "t",
          claude: async () => "2.1.0",
          guardInShell,
        })
      ).find((c) => c.name === "hooks");
    expect(await hooks(async () => true)).toMatchObject({
      status: "fail",
      detail: expect.stringMatching(/no \.claude\/settings\.json/),
    });
    await mkdir(join(repo, ".claude"));
    await writeFile(join(repo, ".claude", "settings.json"), SETTINGS_JSON);
    expect(await hooks(async () => false)).toMatchObject({
      status: "fail",
      detail: expect.stringMatching(/on PATH/),
    });
  });
});

describe("rivetari doctor's temp check", () => {
  it("warns only when the temp folder is crowded, and names it", async () => {
    const dir = await tmp("rivetari-temp-");
    for (const n of ["a", "b", "c"]) await mkdir(join(dir, n));
    expect(await tempCheck(dir, 10)).toBeNull();
    const warn = await tempCheck(dir, 3);
    expect(warn).toMatchObject({ name: "temp", status: "warn" });
    expect(warn?.detail).toContain(`${dir} holds 3+ entries`);
    expect(await tempCheck(join(dir, "missing"), 3)).toBeNull();
  });
});
