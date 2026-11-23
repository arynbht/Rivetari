import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadManifests } from "@arynbht/rivetari-registry";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { approveRoute, routeTask } from "../router/task-route.js";
import { parseCard } from "../task/card.js";
import { confirmTask, newTask } from "../task/tasks.js";
import { type AgentCall, agentArgs, buildTask, PLAN_TURNS } from "./build.js";
import { isolateTask } from "./isolate.js";
import { capSlice, relativeImports } from "./slice.js";

const made: string[] = [];
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
const by = { by: "dev@example.com", now: new Date("2026-11-23T10:00:00Z") };
let repo: string;

const DIFF_RULES = "packages/runtime/src/judge/diff-rules.ts";
const TOUCHES = [DIFF_RULES, "packages/**/*.test.ts"];
const SLICE = [
  "packages/runtime/src/judge/diff-helpers.ts",
  "packages/runtime/src/judge/diff-rules.test.ts",
  DIFF_RULES,
  "packages/runtime/src/task/card.ts",
];

const FILES: Record<string, string> = {
  "AGENTS.md": "# Contract\n",
  "README.md": "# Demo\n",
  "package.json": `${JSON.stringify({ name: "demo", dependencies: { zod: "^4.0.0" } })}\n`,
  [DIFF_RULES]: [
    'import { z } from "zod";',
    'import { helper } from "./diff-helpers.js";',
    'import type { Card } from "../task/card.js";',
    'import { gone } from "./missing.js";',
    "export const rules = (c: Card) => helper(z.string().parse(c));",
    "",
  ].join("\n"),
  "packages/runtime/src/judge/diff-helpers.ts":
    'import { deep } from "./deeper.js";\nexport const helper = deep;\n',
  "packages/runtime/src/judge/deeper.ts":
    "export const deep = (s: string) => s;\n",
  "packages/runtime/src/task/card.ts": "export type Card = string;\n",
  "packages/runtime/src/judge/diff-rules.test.ts": "export {};\n",
  "packages/runtime/src/judge/diff-helpers.test.ts": "export {};\n",
  "packages/runtime/src/judge/other.test.ts": "export {};\n",
  "packages/runtime/src/task/card.test.ts": "export {};\n",
  "packages/engine/src/x.test.ts": "export {};\n",
  "node_modules/zod/index.ts": "export const z = {};\n",
};

beforeEach(async () => {
  process.env.RIVETARI_CONFIG_DIR = await mkdtemp(
    join(tmpdir(), "rivetari-config-"),
  );
  made.push(process.env.RIVETARI_CONFIG_DIR);
  repo = await mkdtemp(join(tmpdir(), "rivetari-slice-"));
  made.push(repo);
  for (const [path, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  await writeFile(join(repo, ".gitignore"), "node_modules/\n");
  const git = simpleGit(repo);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  await git.add(["-A"]);
  await git.commit("base", ["--no-verify"]);
});
afterEach(async () => {
  if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
  else process.env.RIVETARI_CONFIG_DIR = savedConfig;
  for (const d of made) {
    await simpleGit(d)
      .raw(["worktree", "prune"])
      .catch(() => undefined);
    await rm(d, { recursive: true, force: true });
  }
  made.length = 0;
});

const card = (touches: string[]) =>
  parseCard({
    id: "T-0001",
    title: "Cap the slice",
    type: "fix",
    description: "x",
    acceptance: [{ id: "A1", text: "x", verify: "unit" }],
    touches,
    owner: "dev@example.com",
    created: "2026-11-23",
  });

describe("the capped slice", () => {
  it("is the touched source, its relative imports and its own tests, never a test glob's matches", async () => {
    expect(await capSlice(repo, card(TOUCHES))).toEqual(SLICE);
  });

  it("follows relative imports one level and never a bare package", async () => {
    const slice = await capSlice(repo, card([DIFF_RULES]));
    expect(slice).toContain("packages/runtime/src/judge/diff-helpers.ts");
    expect(slice).toContain("packages/runtime/src/task/card.ts");
    expect(slice).not.toContain("packages/runtime/src/judge/deeper.ts");
    expect(slice.some((p) => p.includes("zod"))).toBe(false);
    expect(slice).not.toContain(
      "packages/runtime/src/judge/diff-helpers.test.ts",
    );
    expect(slice).not.toContain("packages/runtime/src/task/card.test.ts");
  });

  it("reads import, export, dynamic import and require specifiers, relative only", () => {
    expect(
      relativeImports(
        [
          'import a from "./a.js";',
          'export * from "../b";',
          'const c = await import("./c.js");',
          'const d = require("./d");',
          'import "./e.css";',
          'import z from "zod";',
          'import y from "@scope/y";',
          'import n from "node:fs";',
        ].join("\n"),
      ),
    ).toEqual(["./a.js", "../b", "./c.js", "./d", "./e.css"]);
  });

  it("resolves an extension-less import and a directory index", async () => {
    await mkdir(join(repo, "src/lib"), { recursive: true });
    await writeFile(
      join(repo, "src/main.ts"),
      'import { a } from "./util";\nimport { b } from "./lib";\n',
    );
    await writeFile(join(repo, "src/util.ts"), "export const a = 1;\n");
    await writeFile(join(repo, "src/lib/index.ts"), "export const b = 1;\n");
    await writeFile(join(repo, "src/main.test.ts"), "export {};\n");
    expect(await capSlice(repo, card(["src/main.ts"]))).toEqual([
      "src/lib/index.ts",
      "src/main.test.ts",
      "src/main.ts",
      "src/util.ts",
    ]);
  });
});

describe("the plan and build calls", () => {
  async function routedTask(): Promise<string> {
    const { manifests } = await loadManifests(repo);
    const context = {
      manifests,
      available: new Set<string>(),
      flags: {},
      files: [DIFF_RULES],
      checks: ["quality.tests.pass"],
    };
    const draft = await newTask(
      repo,
      {
        title: "Tighten the diff rules",
        type: "fix",
        description: "x",
        acceptance: [{ id: "A1", text: "x", verify: "unit" }],
        touches: TOUCHES,
        risk: "medium",
      },
      by,
    );
    const id = draft.card.id;
    await confirmTask(repo, id, by);
    await routeTask(repo, id, { ...by, context });
    await approveRoute(repo, id, { ...by, context });
    await isolateTask(repo, id, { ...by, base: "main" });
    return id;
  }

  const headers = (prompt: string) =>
    prompt
      .split("\n")
      .filter((l) => l.startsWith("### "))
      .map((l) => l.slice(4));

  it("plans on the same capped slice as the build, within the turn limit, and logs the prompt's size", async () => {
    const id = await routedTask();
    const calls: AgentCall[] = [];
    const outcome = await buildTask(repo, id, {
      ...by,
      agent: async (call) => {
        calls.push(call);
        if (call.mode === "plan")
          return JSON.stringify({ steps: ["Tighten the rules"] });
        await writeFile(
          join(call.cwd, DIFF_RULES),
          "export const rules = 1;\n",
        );
        return "Tightened the rules.";
      },
    });
    expect(outcome.stops).toEqual([]);
    const [plan, build] = calls;
    expect(plan?.mode).toBe("plan");
    expect(plan?.maxTurns).toBe(PLAN_TURNS);
    expect(PLAN_TURNS).toBe(4);
    expect(build?.maxTurns).toBeUndefined();
    expect(headers(plan?.prompt ?? "")).toEqual(SLICE);
    expect(headers(build?.prompt ?? "")).toEqual(SLICE);

    const started = outcome.task.entries.find((e) =>
      e.text.startsWith("build started"),
    );
    const size =
      /· ~(\d+) prompt tokens · (\d+) repo file\(s\) in context$/.exec(
        started?.text ?? "",
      );
    expect(size?.[2]).toBe(String(SLICE.length));
    expect(Number(size?.[1])).toBe(Math.ceil((plan?.prompt.length ?? 0) / 4));
    expect(await readFile(outcome.task.ledger.mdPath, "utf8")).toContain(
      `prompt tokens · ${SLICE.length} repo file(s) in context`,
    );
  });

  it("runs the plan call in plan mode with --max-turns, and the build without a turn limit", () => {
    const base = { system: "s", prompt: "p", cwd: ".", env: {} };
    const plan = agentArgs({ ...base, mode: "plan", maxTurns: PLAN_TURNS });
    expect(plan.join(" ")).toContain("--permission-mode plan");
    expect(plan.join(" ")).toContain("--max-turns 4");
    const build = agentArgs({ ...base, mode: "build" });
    expect(build.join(" ")).toContain("--permission-mode acceptEdits");
    expect(build).not.toContain("--max-turns");
  });
});
