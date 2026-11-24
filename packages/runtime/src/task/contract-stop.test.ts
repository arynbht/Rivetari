// The profile's contract files reach the build's schema stop: under
// review-at-pr, a change that rewrites a field in one is asked, not flagged
// (the pilot's R-24, on T-0019's src/lib/domain/types.ts).
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadManifests } from "@arynbht/rivetari-registry";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentCall } from "../agent/build.js";
import { runTask } from "./run.js";
import { loadTask, newTask } from "./tasks.js";

const made: string[] = [];
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
const by = { by: "dev@example.com", now: new Date("2026-11-24T05:24:00Z") };

const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
beforeEach(async () => {
  process.env.RIVETARI_CONFIG_DIR = await tmp("rivetari-config-");
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

const TYPES =
  "export interface Waveform {\n  markers: number[];\n  calibration: { min: number; max: number };\n}\n";

describe("a contract the profile names", () => {
  it("is asked about at review-at-pr when a build rewrites one of its fields", async () => {
    const repo = await tmp("rivetari-contract-");
    const git = simpleGit(repo);
    await git.init(["-b", "main"]);
    await git.addConfig("user.email", "t@t");
    await git.addConfig("user.name", "t");
    const files: Record<string, string> = {
      ".rivetari/profile.yml":
        "version: 1\nname: demo\ntype: library\nautonomy: review-at-pr\ncontracts:\n  - src/lib/domain/types.ts\n",
      "package.json": '{ "name": "demo" }\n',
      "src/lib/domain/types.ts": TYPES,
      "src/total.js": "exports.total = () => 0;\n",
    };
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(repo, path, ".."), { recursive: true });
      await writeFile(join(repo, path), text);
    }
    await git.add(["-A"]);
    await git.commit("base", ["--no-verify"]);
    const { manifests } = await loadManifests(repo);
    const draft = await newTask(
      repo,
      {
        title: "Fix total so it sums",
        type: "fix",
        description: "total() returns 0; it should sum its list.",
        acceptance: [{ id: "A1", text: "total sums a list", verify: "unit" }],
        touches: ["src/total.js"],
      },
      by,
    );
    const outcome = await runTask(repo, draft.card.id, {
      ...by,
      base: "main",
      context: {
        manifests,
        available: new Set(),
        flags: {},
        files: Object.keys(files),
        checks: ["quality.tests.pass"],
      },
      agent: async (call: AgentCall) => {
        if (call.mode === "plan")
          return JSON.stringify({ steps: ["widen calibration"] });
        const path = join(call.cwd, "src/lib/domain/types.ts");
        await writeFile(
          path,
          (await readFile(path, "utf8")).replace(
            "max: number }",
            "max: number; peaks?: number[] }",
          ),
        );
        return "widened";
      },
    });
    expect(outcome.next).toMatch(/^stop-and-ask/);
    const texts = (await loadTask(repo, draft.card.id)).entries.map(
      (e) => e.text,
    );
    expect(texts).toContainEqual(
      expect.stringMatching(
        /^asked: schema_change: touches src\/lib\/domain\/types\.ts — src\/lib\/domain\/types\.ts removes or changes `calibration: \{ min: number; max: number \};`/,
      ),
    );
    expect(texts.filter((t) => t.startsWith("flagged: "))).toEqual([]);
  });
});
