import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { runInit } from "./init.js";
import { inferProjectType } from "./init-type.js";

describe("init infers --type from the repo", { timeout: 30_000 }, () => {
  const made: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const d of made) await rm(d, { recursive: true, force: true });
    made.length = 0;
  });
  const repo = async (files: Record<string, string>) => {
    const d = await mkdtemp(join(tmpdir(), "init-type-"));
    made.push(d);
    for (const [rel, text] of Object.entries(files))
      await writeFile(join(d, rel), text);
    return d;
  };
  const pkg = (p: object) => ({ "package.json": JSON.stringify(p) });

  it.each([
    [
      "a Next.js app",
      pkg({ dependencies: { next: "15", react: "19" } }),
      "web-app",
    ],
    ["a Vite app", pkg({ devDependencies: { vite: "5" } }), "web-app"],
    ["a package with bin", pkg({ bin: { tool: "cli.js" } }), "cli"],
    [
      "an Ink CLI",
      pkg({ bin: "cli.js", dependencies: { react: "18" } }),
      "cli",
    ],
    ["a package with main", pkg({ main: "index.js" }), "library"],
    [
      "a package with exports",
      pkg({ exports: { ".": "./index.js" } }),
      "library",
    ],
    [
      "a component library",
      pkg({ exports: "./index.js", devDependencies: { react: "18" } }),
      "library",
    ],
    ["yarn workspaces", pkg({ workspaces: ["packages/*"] }), "monorepo"],
    [
      "a pnpm workspace",
      {
        ...pkg({ private: true }),
        "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      },
      "monorepo",
    ],
    [
      "FastAPI",
      { "pyproject.toml": '[project]\ndependencies = ["fastapi>=0.110"]\n' },
      "api",
    ],
    ["Flask", { "requirements.txt": "Flask==3.0\n" }, "api"],
    ["Django", { "requirements.txt": "Django>=5\n" }, "web-app"],
  ])("reads %s", async (_, files, type) => {
    expect(await inferProjectType(await repo(files))).toBe(type);
  });

  it.each([
    ["an empty repo", {}],
    ["a bare package.json", pkg({ name: "x" })],
    ["a Go module", { "go.mod": "module x\n" }],
    ["plain Python", { "pyproject.toml": '[project]\nname = "x"\n' }],
    ["a package.json that won't parse", { "package.json": "{" }],
  ])("finds nothing in %s", async (_, files) => {
    expect(await inferProjectType(await repo(files))).toBeNull();
  });

  const profileType = async (dir: string) =>
    (
      parseYaml(
        await readFile(join(dir, ".rivetari", "profile.yml"), "utf8"),
      ) as { type: string }
    ).type;

  it("uses the inferred type under --yes and says so", async () => {
    const dir = await repo(pkg({ name: "tool", bin: "cli.js" }));
    const out = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    expect(await runInit(dir, { yes: true }, { token: null })).toBe(0);
    expect(await profileType(dir)).toBe("cli");
    expect(out.mock.calls.join("")).toContain(
      "No --type given; the repo looks like a cli",
    );
  });

  it("lets --type win over what the repo looks like", async () => {
    const dir = await repo(pkg({ name: "tool", bin: "cli.js" }));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(
      await runInit(dir, { type: "library", yes: true }, { token: null }),
    ).toBe(0);
    expect(await profileType(dir)).toBe("library");
  });

  it("doesn't guess on a re-init, so the profile's type isn't replaced", async () => {
    const dir = await repo(pkg({ name: "tool", bin: "cli.js" }));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(
      await runInit(dir, { type: "library", yes: true }, { token: null }),
    ).toBe(0);
    expect(
      await runInit(dir, { yes: true, force: true }, { token: null }),
    ).toBe(1);
    expect(err.mock.calls.join("")).toContain("--type is required");
    expect(await profileType(dir)).toBe("library");
  });

  it("still asks for --type when nothing fits", async () => {
    const dir = await repo({ "go.mod": "module x\n" });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await runInit(dir, { yes: true }, { token: null })).toBe(1);
    expect(err.mock.calls.join("")).toContain(
      "--type is required in non-interactive mode",
    );
  });
});
