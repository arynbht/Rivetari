// The review is told which of the change's new tests pass on the base too,
// and a criterion such a test backs is unverified whatever the reviewer said.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AiClient, CompleteParams } from "@arynbht/rivetari-engine";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import type { Card } from "../task/card.js";
import { runTier2 } from "./tier2.js";

const made: string[] = [];
afterEach(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

describe("tests that prove nothing, in the review", { timeout: 30_000 }, () => {
  it("shows the reviewer the base run and leaves the backed criterion unverified", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rivetari-t2base-"));
    made.push(dir);
    const git = simpleGit(dir);
    await git.init(["-b", "main"]);
    await git.addConfig("user.email", "t@t");
    await git.addConfig("user.name", "t");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/a.ts"), "export const a = () => 1;\n");
    await git.add(["-A"]);
    await git.commit("base", ["--no-verify"]);
    const base = (await git.revparse(["HEAD"])).trim();
    await writeFile(join(dir, "src/a.ts"), "export const a = () => 2;\n");
    await writeFile(
      join(dir, "src/a.test.ts"),
      'import { a } from "./a";\nif (typeof a !== "function") throw new Error();\n',
    );
    await git.add(["-A"]);
    await git.commit("change", ["--no-verify"]);
    const head = (await git.revparse(["HEAD"])).trim();

    const calls: CompleteParams[] = [];
    const ai: AiClient = {
      async complete(params) {
        calls.push(params);
        return {
          text: JSON.stringify({
            findings: [],
            acceptance: [
              { id: "A1", status: "met", note: "a.test.ts covers it" },
            ],
          }),
          usage: { inputTokens: 1, outputTokens: 1 },
          model: "m",
        };
      },
    };
    const card: Card = {
      id: "T-0001",
      title: "a returns 2",
      type: "fix",
      source: "prompt",
      description: "a returns 1",
      acceptance: [
        {
          id: "A1",
          text: "a() returns 2; new test src/a.test.ts checks it",
          verify: "unit",
        },
      ],
      out_of_scope: [],
      touches: [],
      pages: [],
      constraints: [],
      risk: "low",
      owner: "t",
      created: "2026-11-24",
    };
    const result = await runTier2({
      repoPath: dir,
      base,
      head,
      ai,
      card,
      baseTests: {
        status: "ran",
        note: "",
        files: [{ file: "src/a.test.ts", onBase: "pass", command: "x" }],
      },
    });
    expect(calls[0]?.prompt).toContain("## The change's tests on the base");
    expect(calls[0]?.prompt).toContain(
      "- src/a.test.ts: passes on the base too: it proves nothing about this change",
    );
    expect(result.acceptance).toEqual([
      {
        id: "A1",
        status: "unverified",
        note: "src/a.test.ts passes on the base too, so it proves nothing about this change",
      },
    ]);
    expect(result.unverified).toEqual([
      {
        id: "A1",
        note: "src/a.test.ts passes on the base too, so it proves nothing about this change",
      },
    ]);
  });
});
