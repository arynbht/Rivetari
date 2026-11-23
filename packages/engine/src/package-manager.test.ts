import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { inferPackageManager, packageManagerAt } from "./package-manager.js";

const repo =
  (files: Record<string, string>) =>
  (rel: string): Promise<string | null> =>
    Promise.resolve(files[rel] ?? null);
const pkg = (body: object) => JSON.stringify(body);

describe("inferPackageManager", () => {
  it("reads package.json's packageManager before any lockfile", async () => {
    expect(
      await inferPackageManager(
        repo({
          "package.json": pkg({ packageManager: "pnpm@9.15.0+sha512.abc" }),
          "package-lock.json": "{}",
        }),
      ),
    ).toBe("pnpm");
    expect(
      await inferPackageManager(
        repo({ "package.json": pkg({ packageManager: "yarn@4.5.0" }) }),
      ),
    ).toBe("yarn");
  });

  it("ignores a packageManager it doesn't know and falls through", async () => {
    expect(
      await inferPackageManager(
        repo({
          "package.json": pkg({ packageManager: "bun@1.1.0" }),
          "yarn.lock": "",
        }),
      ),
    ).toBe("yarn");
  });

  it("uses the lockfile, then a workspace or config file", async () => {
    const empty = pkg({ name: "x" });
    const cases: [string, string][] = [
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["package-lock.json", "npm"],
      ["npm-shrinkwrap.json", "npm"],
      ["pnpm-workspace.yaml", "pnpm"],
      [".yarnrc.yml", "yarn"],
    ];
    for (const [file, pm] of cases)
      expect(
        await inferPackageManager(repo({ "package.json": empty, [file]: "" })),
      ).toBe(pm);
  });

  it("takes a hint from scripts that call one manager by name", async () => {
    expect(
      await inferPackageManager(
        repo({
          "package.json": pkg({
            scripts: { ci: "pnpm -r build && pnpm test" },
          }),
        }),
      ),
    ).toBe("pnpm");
    expect(
      await inferPackageManager(
        repo({
          "package.json": pkg({
            scripts: { build: "yarn workspaces run build" },
          }),
        }),
      ),
    ).toBe("yarn");
    // Both named isn't a hint, and neither is a word that merely contains one.
    expect(
      await inferPackageManager(
        repo({
          "package.json": pkg({ scripts: { a: "pnpm x", b: "yarn y" } }),
        }),
      ),
    ).toBe("npm");
    expect(
      await inferPackageManager(
        repo({ "package.json": pkg({ scripts: { a: "rm pnpm-lock.yaml" } }) }),
      ),
    ).toBe("npm");
  });

  it("defaults to npm, never pnpm, and survives an unparseable package.json", async () => {
    expect(await inferPackageManager(repo({}))).toBe("npm");
    expect(
      await inferPackageManager(repo({ "package.json": pkg({ name: "x" }) })),
    ).toBe("npm");
    expect(
      await inferPackageManager(
        repo({ "package.json": "{ nope", "yarn.lock": "" }),
      ),
    ).toBe("yarn");
  });
});

describe("packageManagerAt", () => {
  it("gives the caller's fallback only when nothing names a manager", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rivetari-pm-"));
    try {
      await writeFile(join(dir, "package.json"), pkg({ name: "x" }));
      expect(await packageManagerAt(dir)).toBe("npm");
      expect(await packageManagerAt(dir, "pnpm")).toBe("pnpm");
      await writeFile(join(dir, "yarn.lock"), "");
      expect(await packageManagerAt(dir, "pnpm")).toBe("yarn");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads a Next.js checkout with packageManager and no lockfile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rivetari-pm-"));
    try {
      await writeFile(
        join(dir, "package.json"),
        pkg({
          name: "web",
          packageManager: "pnpm@9.15.0",
          scripts: { dev: "next dev", build: "next build", lint: "next lint" },
          dependencies: { next: "15.0.0", react: "19.0.0" },
        }),
      );
      expect(await packageManagerAt(dir)).toBe("pnpm");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
