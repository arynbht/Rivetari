import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { inferProjectType } from "./index.js";

// The type detector moved here from the CLI so the desktop can ask it too.
// The CLI's own tests still cover init's use of it; these hold the detector to
// the same answers from the engine's side.

describe("inferProjectType", () => {
  const made: string[] = [];
  afterEach(async () => {
    for (const d of made.splice(0))
      await rm(d, { recursive: true, force: true });
  });
  const repo = async (files: Record<string, string>) => {
    const d = await mkdtemp(join(tmpdir(), "engine-project-type-"));
    made.push(d);
    for (const [rel, text] of Object.entries(files))
      await writeFile(join(d, rel), text);
    return d;
  };
  const pkg = (p: object) => ({ "package.json": JSON.stringify(p) });

  it.each([
    ["a React app", pkg({ dependencies: { react: "19" } }), "web-app"],
    ["a package with bin", pkg({ bin: "cli.js" }), "cli"],
    ["a library", pkg({ exports: "./index.js" }), "library"],
    [
      "a pnpm workspace",
      { ...pkg({ private: true }), "pnpm-workspace.yaml": "packages: []\n" },
      "monorepo",
    ],
    ["Flask", { "requirements.txt": "Flask==3.0\n" }, "api"],
  ])("reads %s", async (_, files, type) => {
    expect(await inferProjectType(await repo(files))).toBe(type);
  });

  it("finds nothing in an empty repo or a package.json that won't parse", async () => {
    expect(await inferProjectType(await repo({}))).toBeNull();
    expect(
      await inferProjectType(await repo({ "package.json": "{" })),
    ).toBeNull();
  });
});
