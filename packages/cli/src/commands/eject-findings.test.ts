import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { pullTasks } from "@arynbht/rivetari-runtime";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runEject } from "./eject.js";

// pullTasks passes through to the real one unless a test makes it fail.
vi.mock("@arynbht/rivetari-runtime", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@arynbht/rivetari-runtime")>();
  return { ...real, pullTasks: vi.fn(real.pullTasks) };
});

const run = promisify(execFile);

const there = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe("eject against its review findings", () => {
  const made: string[] = [];
  const savedConfig = process.env.RIVETARI_CONFIG_DIR;
  const savedPrompt = process.env.GIT_TERMINAL_PROMPT;
  let out: string[];
  let err: string[];
  beforeEach(async () => {
    const config = await mkdtemp(join(tmpdir(), "eject-findings-config-"));
    made.push(config);
    process.env.RIVETARI_CONFIG_DIR = config;
    process.env.GIT_TERMINAL_PROMPT = "0";
    out = [];
    err = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      out.push(String(s));
      return true;
    });
    vi.spyOn(console, "error").mockImplementation((s) => {
      err.push(String(s));
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
    else process.env.RIVETARI_CONFIG_DIR = savedConfig;
    if (savedPrompt === undefined) delete process.env.GIT_TERMINAL_PROMPT;
    else process.env.GIT_TERMINAL_PROMPT = savedPrompt;
    for (const d of made) await rm(d, { recursive: true, force: true });
    made.length = 0;
  });
  const repo = async () => {
    const d = await mkdtemp(join(tmpdir(), "eject-findings-"));
    made.push(d);
    await mkdir(join(d, ".rivetari"));
    await writeFile(join(d, ".rivetari", "profile.yml"), "version: 1\n");
    return d;
  };
  const none = { openTasks: () => Promise.resolve([]) };

  describe("F1: only no remote or no tasks branch count as no tasks", () => {
    it("F1 an auth failure from pullTasks refuses and leaves .rivetari/", async () => {
      const dir = await repo();
      vi.mocked(pullTasks).mockRejectedValueOnce(
        new Error(
          "couldn't fetch rivetari/tasks from origin: fatal: Authentication failed for 'https://github.com/acme/app.git/'",
        ),
      );
      expect(await runEject(dir, { yes: true })).toBe(1);
      expect(vi.mocked(pullTasks)).toHaveBeenCalled();
      expect(err.join("")).toContain("couldn't read the task records");
      expect(err.join("")).toContain("Authentication failed");
      expect(await there(join(dir, ".rivetari", "profile.yml"))).toBe(true);
    });

    it("F1 a network failure from pullTasks refuses and leaves .rivetari/", async () => {
      const dir = await repo();
      vi.mocked(pullTasks).mockRejectedValueOnce(
        new Error("Could not resolve host: github.com"),
      );
      expect(await runEject(dir, { apply: true })).toBe(1);
      expect(await there(join(dir, ".rivetari", "profile.yml"))).toBe(true);
    });

    it.each([
      [
        "a StoreError-style fetch failure",
        new Error(
          "couldn't fetch rivetari/tasks from origin: fatal: unable to access 'https://github.com/acme/app.git/': The requested URL returned error: 403",
        ),
      ],
      [
        "a TypeError",
        new TypeError("Cannot read properties of undefined (reading 'trim')"),
      ],
      [
        "a spawn failure",
        Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }),
      ],
      ["a thrown string", "boom"],
    ])(
      "F1 %s from pullTasks refuses and leaves .rivetari/",
      async (_, failure) => {
        const dir = await repo();
        vi.mocked(pullTasks).mockRejectedValueOnce(failure);
        expect(await runEject(dir, { yes: true })).not.toBe(0);
        expect(err.join("")).toContain("nothing was changed");
        expect(await there(join(dir, ".rivetari", "profile.yml"))).toBe(true);
      },
    );

    it("F1 an unreachable origin (real fetch) refuses and leaves .rivetari/", async () => {
      const dir = await repo();
      await run("git", ["init", "-q"], { cwd: dir });
      await run(
        "git",
        ["remote", "add", "origin", "https://127.0.0.1:1/x.git"],
        { cwd: dir },
      );
      expect(await runEject(dir, { yes: true })).toBe(1);
      expect(err.join("")).toContain("couldn't read the task records");
      expect(out.join("")).not.toContain("Removed");
      expect(await there(join(dir, ".rivetari", "profile.yml"))).toBe(true);
    }, 30_000);

    it("F1 a git that can't read its config isn't taken for no origin", async () => {
      const dir = await repo();
      await run("git", ["init", "-q"], { cwd: dir });
      await run(
        "git",
        ["remote", "add", "origin", "https://127.0.0.1:1/x.git"],
        { cwd: dir },
      );
      // A broken config makes every git command fail, `remote get-url` too.
      const config = join(dir, ".git", "config");
      await writeFile(config, `${await readFile(config, "utf8")}\n[broken\n`);
      expect(await runEject(dir, { yes: true })).not.toBe(0);
      expect(await there(join(dir, ".rivetari", "profile.yml"))).toBe(true);
    }, 30_000);

    it("F1 no origin at all still ejects", async () => {
      const dir = await repo();
      await run("git", ["init", "-q"], { cwd: dir });
      expect(await runEject(dir, { yes: true })).toBe(0);
      expect(await there(join(dir, ".rivetari"))).toBe(false);
    });

    it("F1 an origin without the tasks branch still ejects", async () => {
      const dir = await repo();
      const bare = await mkdtemp(join(tmpdir(), "eject-findings-origin-"));
      made.push(bare);
      await run("git", ["init", "-q", "--bare"], { cwd: bare });
      await run("git", ["init", "-q"], { cwd: dir });
      await run("git", ["remote", "add", "origin", bare], { cwd: dir });
      expect(await runEject(dir, { yes: true })).toBe(0);
      expect(await there(join(dir, ".rivetari"))).toBe(false);
    }, 30_000);
  });

  describe("F4: a ci.yml init has no record of", () => {
    it("F4 leaves an unrecorded ci.yml byte for byte, so it still parses", async () => {
      const dir = await repo();
      await mkdir(join(dir, ".github", "workflows"), { recursive: true });
      const ci = join(dir, ".github", "workflows", "ci.yml");
      await writeFile(
        ci,
        "# Written by `rivetari init` for node.\n\non:\n  pull_request:\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n",
      );
      expect(await runEject(dir, { yes: true }, none)).toBe(0);
      const text = await readFile(ci, "utf8");
      expect(text).toMatch(/^on:$/m);
      const doc = parse(text) as Record<string, unknown>;
      expect(doc).toHaveProperty("on");
      expect(doc).toHaveProperty("jobs");
      expect(doc.on).toEqual({ pull_request: null });
    });
  });

  describe("F5: a kept doc whose H1 mentions Rivetari", () => {
    const design =
      "# Design for the Rivetari dashboard\n\n## Colours\n\nUse blue.\n";

    it("F5 eject keeps DESIGN.md and its sections", async () => {
      const dir = await repo();
      await writeFile(join(dir, "DESIGN.md"), design);
      expect(await runEject(dir, { yes: true }, none)).toBe(0);
      expect(await there(join(dir, "DESIGN.md"))).toBe(true);
      const text = await readFile(join(dir, "DESIGN.md"), "utf8");
      expect(text).toContain("## Colours");
      expect(text).toContain("Use blue.");
    });
  });
});
