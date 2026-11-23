// A card that touches a path on the repo's sensitive list still stops at the
// route with the evidence. The built-in sensitive paths now make a card high
// risk, and so supervised, so this covers a path a person added to the list.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadManifests } from "@arynbht/rivetari-registry";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import { routeTask } from "../router/task-route.js";
import { advanceTask } from "./autonomy.js";
import { assemblyPath, confirmTask, newTask } from "./tasks.js";

const made: string[] = [];
const saved = process.env.RIVETARI_CONFIG_DIR;
const by = { by: "dev@example.com", now: new Date("2026-11-21T18:00:00Z") };

const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
beforeEach(async () => {
  process.env.RIVETARI_CONFIG_DIR = await tmp("rivetari-config-");
});
afterEach(async () => {
  if (saved === undefined) delete process.env.RIVETARI_CONFIG_DIR;
  else process.env.RIVETARI_CONFIG_DIR = saved;
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

describe("route concerns", { timeout: 60_000 }, () => {
  it("stops at the route, with the evidence, when a low-risk card touches the repo's sensitive list", async () => {
    const repo = await tmp("rivetari-concerns-");
    const git = simpleGit(repo);
    await git.init(["-b", "main"]);
    await git.addConfig("user.email", "t@t");
    await git.addConfig("user.name", "t");
    const files = {
      ".rivetari/profile.yml":
        "version: 1\nname: demo\ntype: library\nautonomy: review-at-pr\n",
      "src/core/run.js": "module.exports = 1;\n",
    };
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(repo, path, ".."), { recursive: true });
      await writeFile(join(repo, path), text);
    }
    await git.add(["-A"]);
    await git.commit("base", ["--no-verify"]);
    const { manifests } = await loadManifests(repo);
    const context = {
      manifests,
      available: new Set<string>(),
      flags: {},
      files: Object.keys(files),
      checks: ["quality.tests.pass"],
    };
    const draft = await newTask(
      repo,
      {
        title: "Tidy run",
        type: "chore",
        description: "Tidy src/core/run.js.",
        acceptance: [{ id: "A1", text: "tidied", verify: "review" }],
        touches: ["src/core/run.js"],
      },
      by,
    );
    expect(draft.card.risk).toBe("low");
    const id = draft.card.id;
    await confirmTask(repo, id, by);
    await routeTask(repo, id, { ...by, context });
    // A person puts src/core on the sensitive list before approving.
    const path = assemblyPath(repo, id);
    const assembly = parse(await readFile(path, "utf8")) as {
      stop_and_ask: unknown[];
    };
    assembly.stop_and_ask.push({ touches: ["src/core/**"] });
    await writeFile(path, stringify(assembly), "utf8");

    const advance = await advanceTask(repo, id, { ...by, context });
    expect(advance.level).toBe("review-at-pr");
    expect(advance.task.approved).toBe(false);
    expect(advance.waiting).toContain(
      "touches sensitive paths: src/core/run.js",
    );
  });
});
