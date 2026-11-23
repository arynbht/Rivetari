import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { runInit } from "./init.js";

// A fresh Next.js repo: package.json names pnpm, but nothing has been installed.
const NEXT_PKG = {
  name: "web",
  private: true,
  packageManager: "pnpm@9.15.0",
  scripts: { dev: "next dev", build: "next build", lint: "next lint" },
  dependencies: { next: "15.0.0", react: "19.0.0" },
  devDependencies: { typescript: "5.6.0" },
};

describe(
  "init reads the repo's stack and package manager",
  { timeout: 30_000 },
  () => {
    const made: string[] = [];
    afterEach(async () => {
      for (const d of made) await rm(d, { recursive: true, force: true });
      made.length = 0;
      vi.restoreAllMocks();
    });
    const nextRepo = async (): Promise<string> => {
      const d = await mkdtemp(join(tmpdir(), "rivetari-init-stack-"));
      made.push(d);
      await writeFile(join(d, "package.json"), JSON.stringify(NEXT_PKG));
      await writeFile(join(d, "tsconfig.json"), "{}");
      return d;
    };
    const profileStack = async (dir: string) =>
      (
        parseYaml(
          await readFile(join(dir, ".rivetari", "profile.yml"), "utf8"),
        ) as { stack: string[] }
      ).stack;
    const bannedIds = async (dir: string) =>
      (
        JSON.parse(
          await readFile(join(dir, ".rivetari", "banned.json"), "utf8"),
        ) as { patterns: { id: string }[] }
      ).patterns.map((p) => p.id);

    it("puts the detected stacks in the profile and seeds banned.json from them, without --stack", async () => {
      const dir = await nextRepo();
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      expect(
        await runInit(dir, { type: "web-app", yes: true }, { token: null }),
      ).toBe(0);
      expect(await profileStack(dir)).toEqual(["node", "typescript"]);
      expect(await bannedIds(dir)).toContain("no-eval");
      // No lockfile, so packageManager decides: pnpm, not a default.
      expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toContain(
        "Commands: install `pnpm install` · lint `pnpm run lint`",
      );
    });

    it("adds --stack values mapped onto stacks, deduped, and keeps names that map to none", async () => {
      const dir = await nextRepo();
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await runInit(
        dir,
        {
          type: "web-app",
          stack: "nextjs, TypeScript, python, Postgres, postgres",
          yes: true,
        },
        { token: null },
      );
      expect(await profileStack(dir)).toEqual([
        "node",
        "typescript",
        "python",
        "postgres",
      ]);
      expect(await bannedIds(dir)).toEqual(
        expect.arrayContaining(["no-new-function", "no-pickle-load"]),
      );
    });

    it("uses npm, not pnpm, for a repo that names no manager", async () => {
      const dir = await mkdtemp(join(tmpdir(), "rivetari-init-stack-"));
      made.push(dir);
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "x", scripts: { test: "node --test" } }),
      );
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await runInit(dir, { type: "library", yes: true }, { token: null });
      expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toContain(
        "Commands: install `npm install` · test `npm run test`",
      );
    });
  },
);
