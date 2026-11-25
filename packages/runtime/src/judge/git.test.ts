import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { contained, openScratch } from "./eval.js";
import { judgeGit, scratchEnvFor } from "./git.js";

const dirs: string[] = [];
const saved = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
};
afterEach(async () => {
  for (const [k, v] of Object.entries(saved))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "rivetari-judge-git-"));
  dirs.push(d);
  return d;
}

const posix = (p: string) => p.split("\\").join("/");

/** A HOME whose .gitconfig runs a hook that leaves `marker` behind. */
async function homeWithHook(marker: string): Promise<void> {
  const home = await tmp();
  const hooks = join(home, "hooks");
  await mkdir(hooks);
  await writeFile(
    join(hooks, "post-commit"),
    `#!/bin/sh\nenv > "${posix(marker)}"\n`,
  );
  await chmod(join(hooks, "post-commit"), 0o755);
  await writeFile(
    join(home, ".gitconfig"),
    `[core]\n\thooksPath = ${posix(hooks)}\n[user]\n\tname = t\n\temail = t@example.com\n`,
  );
  process.env.HOME = home;
  process.env.USERPROFILE = home;
}

async function commitIn(repo: string): Promise<void> {
  await mkdir(repo, { recursive: true });
  const git = judgeGit(repo);
  await git.init(["--quiet"]);
  await git.addConfig("user.name", "t");
  await git.addConfig("user.email", "t@example.com");
  await writeFile(join(repo, "a.txt"), "a\n");
  await git.raw(["add", "-A"]);
  await git.raw(["commit", "--quiet", "-m", "a"]);
}

describe("judge git in a scratch folder", () => {
  it("runs no hook from the caller's config inside a scratch folder, and does outside one", async () => {
    const marker = join(await tmp(), "hook-ran");
    await homeWithHook(marker);

    const work = await tmp();
    const release = await openScratch(work);
    try {
      expect(scratchEnvFor([join(work, "repo")])).not.toBeNull();
      await commitIn(join(work, "repo"));
    } finally {
      release();
    }
    expect(await stat(marker).catch(() => null)).toBeNull();

    // The same commit in a folder nobody registered runs the hook, so the
    // check above can fail.
    expect(scratchEnvFor([join(work, "repo")])).toBeNull();
    await commitIn(join(await tmp(), "plain"));
    expect(await stat(marker).catch(() => null)).not.toBeNull();
  });

  it("gives a clone into a scratch folder the scratch environment", async () => {
    const work = await tmp();
    const release = await openScratch(work);
    try {
      const env = scratchEnvFor([join(work, "clone")]);
      expect(env?.GIT_CONFIG_KEY_0).toBe("core.hooksPath");
      expect(env?.GIT_CONFIG_NOSYSTEM).toBe("1");
    } finally {
      release();
    }
  });
});

describe("contained", () => {
  it("refuses a write or delete that a link carries out of the work folder", async () => {
    const work = await tmp();
    const away = await tmp();
    await writeFile(join(away, "keep.txt"), "keep\n");
    // A junction needs no privilege on Windows; elsewhere it's a symlink.
    await symlink(away, join(work, "out"), "junction");
    await expect(contained(work, join("out", "keep.txt"))).rejects.toThrow(
      /resolves outside/,
    );
    await expect(contained(work, "out")).rejects.toThrow(/resolves outside/);
    await expect(contained(work, "..")).rejects.toThrow(/resolves outside/);
    await expect(contained(work, join("repo", "a.txt"))).resolves.toMatch(
      /a\.txt$/,
    );
    expect(await stat(join(away, "keep.txt"))).toBeTruthy();
  });
});
