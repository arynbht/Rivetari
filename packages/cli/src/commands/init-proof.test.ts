import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { runInit } from "./init.js";

describe(
  "init writes the proof server settings for a web app",
  { timeout: 30_000 },
  () => {
    const made: string[] = [];
    afterEach(async () => {
      for (const d of made) await rm(d, { recursive: true, force: true });
      made.length = 0;
      vi.restoreAllMocks();
    });
    const repo = async (
      pkg: Record<string, unknown>,
      files: Record<string, string> = {},
    ): Promise<string> => {
      const d = await mkdtemp(join(tmpdir(), "rivetari-init-proof-"));
      made.push(d);
      await writeFile(join(d, "package.json"), JSON.stringify(pkg));
      for (const [rel, text] of Object.entries(files))
        await writeFile(join(d, rel), text);
      return d;
    };
    const init = async (dir: string, type: string, force = false) => {
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      expect(
        await runInit(dir, { type, yes: true, force }, { token: null }),
      ).toBe(0);
    };
    const profile = async (dir: string) =>
      parseYaml(
        await readFile(join(dir, ".rivetari", "profile.yml"), "utf8"),
      ) as Record<string, unknown> & { proof?: Record<string, unknown> };

    it("serves a Next.js app with npm run dev and a slow first compile in mind", async () => {
      const dir = await repo(
        {
          name: "web",
          scripts: {
            dev: "next dev",
            build: "next build",
            start: "next start",
          },
          dependencies: { next: "15.0.0", react: "19.0.0" },
        },
        { "package-lock.json": "{}" },
      );
      await init(dir, "web-app");
      expect((await profile(dir)).proof).toEqual({
        start: "npm run dev",
        ready_timeout: 180,
      });
    });

    it("runs the dev script with the repo's package manager", async () => {
      const dir = await repo({
        name: "web",
        packageManager: "pnpm@9.15.0",
        scripts: { dev: "vite" },
      });
      await init(dir, "web-app");
      expect((await profile(dir)).proof?.start).toBe("pnpm run dev");
    });

    it("falls back to the start script when there's no dev script", async () => {
      const dir = await repo(
        { name: "web", scripts: { start: "node server.js" } },
        { "yarn.lock": "" },
      );
      await init(dir, "web-app");
      expect((await profile(dir)).proof).toEqual({
        start: "yarn run start",
        ready_timeout: 180,
      });
    });

    it("writes no proof block for a library, or a web app with nothing to serve it", async () => {
      const lib = await repo({ name: "lib", scripts: { test: "vitest" } });
      await init(lib, "library");
      expect((await profile(lib)).proof).toBeUndefined();

      const libWithDev = await repo({
        name: "lib",
        scripts: { dev: "tsc -w" },
      });
      await init(libWithDev, "library");
      expect((await profile(libWithDev)).proof).toBeUndefined();

      const web = await repo({ name: "web", scripts: { build: "vite build" } });
      await init(web, "web-app");
      expect((await profile(web)).proof).toBeUndefined();
    });

    it("keeps an existing proof block as it is on a --force re-init", async () => {
      const dir = await repo(
        { name: "web", scripts: { dev: "next dev" } },
        { "package-lock.json": "{}" },
      );
      await init(dir, "web-app");
      const path = join(dir, ".rivetari", "profile.yml");
      const proof = {
        start: "npm run serve",
        url: "http://localhost:{port}/app",
        ready_timeout: 60,
        auth: { script: "proof/login.mjs" },
      };
      await writeFile(
        path,
        stringifyYaml({ ...(await profile(dir)), proof }),
        "utf8",
      );
      await init(dir, "web-app", true);
      expect((await profile(dir)).proof).toEqual(proof);
    });
  },
);
