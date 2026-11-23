// `rivetari init` and the floorplan: a new init turns it on and draws one on a
// Node repo, through a stubbed transport and a stand-in skill; offline, with
// nothing injected, it draws nothing.
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentRunner } from "@arynbht/rivetari-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runInit } from "./init.js";

const FIXTURE = fileURLToPath(
  new URL("../../../runtime/test/fixtures/floorplan-skill", import.meta.url),
);
const ARCH = {
  project: { name: "demo", summary: "A small Node app." },
  nodes: [{ id: "app", label: "The app", summary: "Starts it." }],
};

const answering: AgentRunner = async (call) => ({
  text: JSON.stringify(
    /JOB descriptions/.test(call.system)
      ? {
          files: {
            "src/index.js": { name: "Entry", description: "Starts the app." },
          },
        }
      : ARCH,
  ),
  tokens: 800,
  costUsd: 0.02,
});

describe("runInit and the floorplan", { timeout: 60_000 }, () => {
  const made: string[] = [];
  afterEach(async () => {
    for (const d of made) await rm(d, { recursive: true, force: true });
    made.length = 0;
    vi.restoreAllMocks();
  });
  const tmp = async (prefix: string): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), prefix));
    made.push(d);
    return d;
  };
  const nodeRepo = async () => {
    const dir = await tmp("rivetari-init-floorplan-");
    await writeFile(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "demo", scripts: { test: "node --test" } }, null, 2)}\n`,
    );
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "index.js"), "console.log('hi');\n");
    return dir;
  };

  it("draws a floorplan on a Node repo and keeps it out of git", async () => {
    const dir = await nodeRepo();
    const skillDir = join(await tmp("rivetari-floorplan-skill-"), "floorplan");
    await cp(FIXTURE, skillDir, { recursive: true });
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      out.push(String(s));
      return true;
    });

    expect(
      await runInit(
        dir,
        { type: "cli", stack: "node", yes: true },
        { token: null, floorplan: { skillDir, agent: answering } },
      ),
    ).toBe(0);

    expect(
      JSON.parse(
        await readFile(join(dir, "floorplan", "architecture.json"), "utf8"),
      ),
    ).toEqual(ARCH);
    await access(join(dir, "floorplan", "index.html"));
    expect(
      await readFile(join(dir, ".rivetari", "profile.yml"), "utf8"),
    ).toContain("floorplan: true");
    expect(
      (await readFile(join(dir, ".gitignore"), "utf8")).split("\n"),
    ).toContain("/floorplan/");
    expect(out.join("")).toContain(
      "drew the floorplan: floorplan/index.html · 2 call(s) · 1600 tokens · $0.04",
    );
    const calls = await readFile(join(skillDir, "calls.log"), "utf8");
    expect(calls).not.toContain("VIOLATION");
  });

  it("offline, with no transport given, turns it on but draws nothing", async () => {
    const dir = await nodeRepo();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(
      await runInit(dir, { type: "cli", yes: true }, { token: null }),
    ).toBe(0);
    expect(
      await readFile(join(dir, ".rivetari", "profile.yml"), "utf8"),
    ).toContain("floorplan: true");
    await expect(access(join(dir, "floorplan"))).rejects.toThrow();
    await expect(access(join(dir, ".gitignore"))).rejects.toThrow();
  });

  it("a failed floorplan is a note, and init still succeeds", async () => {
    const dir = await nodeRepo();
    const skillDir = join(await tmp("rivetari-floorplan-skill-"), "floorplan");
    await cp(FIXTURE, skillDir, { recursive: true });
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      out.push(String(s));
      return true;
    });
    expect(
      await runInit(
        dir,
        { type: "cli", yes: true },
        {
          token: null,
          floorplan: {
            skillDir,
            agent: async () => {
              throw new Error("claude is not installed");
            },
          },
        },
      ),
    ).toBe(0);
    expect(out.join("")).toContain(
      "couldn't draw the floorplan: claude is not installed",
    );
  });

  it("a re-init keeps an existing repo's floorplan off", async () => {
    const dir = await nodeRepo();
    await mkdir(join(dir, ".rivetari"));
    // A profile from before the flag: no floorplan key, so it's off.
    await writeFile(
      join(dir, ".rivetari", "profile.yml"),
      "version: 1\nname: demo\ntype: cli\n",
    );
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let asked = 0;
    expect(
      await runInit(
        dir,
        { type: "cli", yes: true, force: true },
        {
          token: null,
          floorplan: {
            agent: async () => {
              asked++;
              return "{}";
            },
          },
        },
      ),
    ).toBe(0);
    expect(
      await readFile(join(dir, ".rivetari", "profile.yml"), "utf8"),
    ).not.toMatch(/^floorplan:/m);
    expect(asked).toBe(0);
  });
});
