// The floorplan skill's driver, against a stand-in skill whose scripts log
// every call: only the offline scripts run, always unattended and without
// tokens, never the map's server; the model's answers become the map's files,
// and each call's usage is logged.
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentCall, AgentRunner } from "../agent/build.js";
import {
  drawFloorplan,
  FLOORPLAN_SCRIPTS,
  floorplanOnMerge,
  runFloorplanScript,
} from "./floorplan-skill.js";

const FIXTURE = fileURLToPath(
  new URL("../../test/fixtures/floorplan-skill", import.meta.url),
);

const made: string[] = [];
const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
const savedToken = process.env.GITHUB_TOKEN;
afterEach(async () => {
  if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = savedToken;
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

const ARCH = {
  project: { name: "demo", summary: "A small Node app." },
  nodes: [
    { id: "app", label: "The app", summary: "Starts it.", paths: ["src/**"] },
  ],
};

/** A copy of the stand-in skill, so its calls.log is this test's own. */
async function skill(): Promise<string> {
  const dir = join(await tmp("rivetari-floorplan-skill-"), "floorplan");
  await cp(FIXTURE, dir, { recursive: true });
  return dir;
}

async function nodeRepo(): Promise<string> {
  const repo = await tmp("rivetari-floorplan-repo-");
  await writeFile(join(repo, "package.json"), '{ "name": "demo" }\n');
  await mkdir(join(repo, "src"));
  await writeFile(join(repo, "src", "index.js"), "console.log('hi');\n");
  return repo;
}

/** Answers each job by its name in the instructions, and records the calls. */
function stubAgent(calls: AgentCall[]): AgentRunner {
  return async (call) => {
    calls.push(call);
    const job = /JOB (\w+)/.exec(call.system)?.[1];
    const answer =
      job === "descriptions"
        ? {
            files: {
              "src/index.js": { name: "Entry", description: "Starts the app." },
            },
          }
        : job === "recent_work"
          ? {
              tasks: [{ title: "Say hi", request: "", summary: "", items: [] }],
            }
          : ARCH;
    return { text: JSON.stringify(answer), tokens: 1000, costUsd: 0.01 };
  };
}

const calls = async (skillDir: string) =>
  (await readFile(join(skillDir, "calls.log"), "utf8")).trim().split("\n");

describe("the floorplan skill's driver", { timeout: 60_000 }, () => {
  it("runs only the offline scripts, unattended and without tokens, never serve.mjs or open.mjs", async () => {
    process.env.GITHUB_TOKEN = "ghp_not_for_scripts";
    const [repo, skillDir] = [await nodeRepo(), await skill()];
    const agentCalls: AgentCall[] = [];
    const options = { skillDir, agent: stubAgent(agentCalls) };
    await drawFloorplan(repo, options);
    // A second run refreshes the map that's now there.
    await drawFloorplan(repo, options);

    const log = await calls(skillDir);
    expect(log.map((l) => l.split(" ")[0])).toEqual([
      "status.mjs",
      "scan.mjs",
      "build.mjs",
      "describe.mjs",
      "build.mjs",
      "recent.mjs",
      "build.mjs",
      "status.mjs",
      "refresh.mjs",
      "recent.mjs",
      "build.mjs",
    ]);
    for (const line of log) {
      expect(line).not.toContain("VIOLATION");
      expect(line).toContain("--json --unattended unattended=1 token=none");
    }
    // The model only reads: plan mode is the transport's read-only tools.
    expect(agentCalls.every((c) => c.mode === "plan" && c.cwd === repo)).toBe(
      true,
    );
  });

  it("won't run the map's server, whatever it's asked", async () => {
    expect([...FLOORPLAN_SCRIPTS]).toEqual([
      "status.mjs",
      "scan.mjs",
      "build.mjs",
      "describe.mjs",
      "refresh.mjs",
      "recent.mjs",
    ]);
    const [repo, skillDir] = [await nodeRepo(), await skill()];
    for (const script of ["open.mjs", "serve.mjs", "../assets/serve.mjs"])
      await expect(
        runFloorplanScript(skillDir, repo, script as never),
      ).rejects.toThrow("Rivetari never runs it");
    await expect(
      readFile(join(skillDir, "calls.log"), "utf8"),
    ).rejects.toThrow();
  });

  it("no runtime or CLI code names serve.mjs or open.mjs outside a comment", async () => {
    const offenders: string[] = [];
    for (const pkg of ["runtime", "cli"]) {
      const src = fileURLToPath(
        new URL(`../../../${pkg}/src`, import.meta.url),
      );
      const files = (await readdir(src, { recursive: true })).filter(
        (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
      );
      for (const f of files) {
        const lines = (await readFile(join(src, f), "utf8")).split("\n");
        lines.forEach((line, i) => {
          const code = line.trim();
          if (code.startsWith("//") || code.startsWith("*")) return;
          if (/\b(serve|open)\.mjs\b/.test(code))
            offenders.push(`${pkg}/src/${f}:${i + 1}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("writes the model's answers as the map's files and logs each call's usage", async () => {
    const [repo, skillDir] = [await nodeRepo(), await skill()];
    const agentCalls: AgentCall[] = [];
    const logged: string[] = [];
    const result = await drawFloorplan(repo, {
      skillDir,
      agent: stubAgent(agentCalls),
      log: (l) => logged.push(l),
      now: new Date("2026-11-23T12:00:00Z"),
    });
    expect(result).toMatchObject({ made: "first", calls: 2, tokens: 2000 });
    expect(
      JSON.parse(
        await readFile(join(repo, "floorplan", "architecture.json"), "utf8"),
      ),
    ).toEqual(ARCH);
    expect(
      JSON.parse(
        await readFile(
          join(repo, "floorplan", "descriptions", "app.json"),
          "utf8",
        ),
      ).files["src/index.js"].description,
    ).toBe("Starts the app.");
    // A first map has no recent work: it's cleared, not asked about.
    expect(
      JSON.parse(
        await readFile(join(repo, "floorplan", "recent-work.json"), "utf8"),
      ).tasks,
    ).toEqual([]);
    // The architecture job got the scan summary and the skill's reference.
    expect(agentCalls[0]!.prompt).toContain("REPOS 1 · CODE src/index.js");
    expect(agentCalls[0]!.prompt).toContain("# references/schema.md");
    expect(logged).toEqual([
      "floorplan architecture · 1000 tokens · $0.01",
      "floorplan descriptions · 1000 tokens · $0.01",
    ]);
    const usage = (
      await readFile(join(repo, ".rivetari", "ai-usage.log"), "utf8")
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { task: string; costUsd: number });
    expect(usage.map((u) => u.task)).toEqual([
      "floorplan:architecture",
      "floorplan:descriptions",
    ]);
  });

  it("an update marks recent work from the model's answer", async () => {
    const [repo, skillDir] = [await nodeRepo(), await skill()];
    const options = { skillDir, agent: stubAgent([]) };
    await drawFloorplan(repo, options);
    const result = await drawFloorplan(repo, options);
    expect(result.made).toBe("refresh");
    const recent = JSON.parse(
      await readFile(join(repo, "floorplan", "recent-work.json"), "utf8"),
    ) as { tasks: { title: string }[]; updatedAt: string };
    expect(recent.tasks[0]!.title).toBe("Say hi");
    expect(recent.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("leaves a floorplan/ that belongs to the project alone", async () => {
    const [repo, skillDir] = [await nodeRepo(), await skill()];
    await mkdir(join(repo, "floorplan"));
    await writeFile(join(repo, "floorplan", "kitchen.svg"), "<svg/>\n");
    await expect(
      drawFloorplan(repo, { skillDir, agent: stubAgent([]) }),
    ).rejects.toThrow("part of the project");
    expect(await readdir(join(repo, "floorplan"))).toEqual(["kitchen.svg"]);
  });
});

describe("floorplanOnMerge", { timeout: 60_000 }, () => {
  const profile = (extra: string) =>
    `version: 1\nname: demo\ntype: cli\n${extra}`;

  it("does nothing when the profile doesn't turn it on", async () => {
    const [repo, skillDir] = [await nodeRepo(), await skill()];
    await mkdir(join(repo, ".rivetari"));
    await writeFile(join(repo, ".rivetari", "profile.yml"), profile(""));
    const agentCalls: AgentCall[] = [];
    expect(
      await floorplanOnMerge(repo, { skillDir, agent: stubAgent(agentCalls) }),
    ).toBeNull();
    expect(agentCalls).toEqual([]);
    await expect(
      readFile(join(skillDir, "calls.log"), "utf8"),
    ).rejects.toThrow();
  });

  it("reports a failure as a line instead of throwing", async () => {
    const [repo, skillDir] = [await nodeRepo(), await skill()];
    await mkdir(join(repo, ".rivetari"));
    await writeFile(
      join(repo, ".rivetari", "profile.yml"),
      profile("floorplan: true\n"),
    );
    const line = await floorplanOnMerge(repo, {
      skillDir,
      agent: async () => {
        throw new Error("claude exited with code 1");
      },
    });
    expect(line).toBe(
      "floorplan update failed (close goes on): claude exited with code 1",
    );
  });
});
