// The judge eval replays a labelled change as a two-commit repo and judges it
// as the task judge would: tier 1, the review, the same decision, then scores
// the verdict against the label.
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import {
  type EvalCaseMeta,
  judgeCase,
  loadEvalCases,
  materializeCase,
  runJudgeEval,
  scoreCase,
  scratchGitEnv,
  scratchPath,
} from "./eval.js";
import type { ReviewOutcome } from "./review.js";
import type { Tier2Result } from "./tier2.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "rivetari-eval-test-"));
  dirs.push(d);
  return d;
}

const CARD = `id: T-0001
title: Add the greeting
type: feature
description: Adds greet() to src/a.ts.
acceptance:
  - id: A1
    text: greet() returns "hi"
    verify: unit
touches:
  - src/a.ts
risk: low
owner: someone@example.com
created: 2026-11-24
`;

const ASSEMBLY = `task: T-0001
sectors: []
phases: [build]
skills: []
budget: { skill_tokens: 0, context_tokens: 15000, steps: 8 }
checks: [quality.lint.clean, quality.typecheck.clean]
proof: test-run
review: { rubric: default, design_pass: false, security: false }
stop_and_ask: [new_dependency]
`;

const meta = (over: Partial<EvalCaseMeta> = {}): EvalCaseMeta => ({
  id: "case-a",
  task: "T-0001",
  round: 1,
  label: "defect",
  expected: "block",
  defect: "greet() returns the wrong word",
  caught_by: "judge",
  caught_detail: "",
  signals: ["wrong word"],
  source: { repo: "x/y", pr: null, base: "b", head: "h" },
  pilot: {
    verdict: "passed",
    blocking: 0,
    acceptance: {},
    model: null,
    cost_usd: 0,
  },
  profile: { no_new_comments: false, generated: [], autonomy: "review-at-pr" },
  stops: [],
  recorded_tier1: [
    {
      id: "quality.lint.clean",
      title: "Lint passes",
      base: "green",
      head: "green",
      outcome: "pass",
      message: "`npm run lint` exited 0",
    },
  ],
  offline_tests: false,
  test_packages: [],
  ...over,
});

/** A case directory: base files, the diff to `head` files, card and assembly. */
async function makeCase(
  root: string,
  m: EvalCaseMeta,
  base: Record<string, string>,
  head: Record<string, string | null>,
): Promise<string> {
  const scratch = join(await tmp(), "src-repo");
  await mkdir(scratch, { recursive: true });
  const git = simpleGit(scratch);
  await git.init(["--quiet"]);
  await git.addConfig("core.autocrlf", "false");
  await git.addConfig("commit.gpgsign", "false");
  await git.addConfig("user.name", "t");
  await git.addConfig("user.email", "t@example.com");
  const write = async (files: Record<string, string | null>) => {
    for (const [p, text] of Object.entries(files)) {
      const at = join(scratch, p);
      if (text === null) await rm(at, { force: true });
      else {
        await mkdir(join(at, ".."), { recursive: true });
        await writeFile(at, text, "utf8");
      }
    }
  };
  await write(base);
  await git.raw(["add", "-A"]);
  await git.raw(["commit", "--quiet", "-m", "base"]);
  await write(head);
  await git.raw(["add", "-A"]);
  const diff = await git.raw(["diff", "--cached", "--binary"]);
  const dir = join(root, m.id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "base.json"),
    JSON.stringify({
      files: Object.fromEntries(
        Object.entries(base).map(([p, utf8]) => [p, { utf8 }]),
      ),
    }),
    "utf8",
  );
  await writeFile(join(dir, "change.diff"), diff, "utf8");
  await writeFile(join(dir, "card.yml"), CARD, "utf8");
  await writeFile(join(dir, "assembly.yml"), ASSEMBLY, "utf8");
  await writeFile(join(dir, "case.json"), JSON.stringify(m), "utf8");
  return dir;
}

const BASE = {
  "package.json": JSON.stringify({ name: "x", scripts: {} }),
  "src/a.ts": "export const one = 1;\n",
};
const HEAD = {
  "src/a.ts": 'export const one = 1;\nexport const greet = () => "ho";\n',
};

function review(
  result: Partial<Tier2Result>,
  verdict: ReviewOutcome["verdict"],
): () => Promise<ReviewOutcome> {
  return async () => ({
    verdict,
    round: 1,
    body: "",
    result: {
      verdict: verdict === "request-changes" ? "request-changes" : "approve",
      blocking: [],
      suggestions: [],
      acceptance: [],
      unreviewed: [],
      model: "fake-model",
      calls: 1,
      usage: { tokens: 100, costUsd: 0.25 },
      packed: {
        files: [],
        omitted: [],
        lines: new Map(),
        agents: null,
        constraints: null,
      },
      ...result,
    },
  });
}

describe("scoreCase", () => {
  it("counts a block on a defect as caught only when its reasons name the defect", () => {
    const m = { expected: "block" as const, signals: ["band.?edge"] };
    expect(
      scoreCase(m, { verdict: "failed" }, ["the band edge floors to 10"]),
    ).toEqual({ outcome: "caught", matched: ["band.?edge"] });
    expect(scoreCase(m, { verdict: "needs a human" }, ["style"])).toEqual({
      outcome: "blocked-other",
      matched: [],
    });
    expect(scoreCase(m, { verdict: "passed" }, []).outcome).toBe("missed");
  });

  it("scores a clean case: pass, a false block, or held for a person", () => {
    const m = { expected: "pass" as const, signals: [] };
    expect(scoreCase(m, { verdict: "passed" }, []).outcome).toBe("pass");
    expect(scoreCase(m, { verdict: "failed" }, []).outcome).toBe("false-block");
    expect(scoreCase(m, { verdict: "needs a human" }, []).outcome).toBe("held");
  });
});

describe("materializeCase", () => {
  it("rebuilds base and head as two commits whose diff is the case's", async () => {
    const root = await tmp();
    const dir = await makeCase(root, meta(), BASE, HEAD);
    const repo = join(await tmp(), "repo");
    const { base, head } = await materializeCase({ dir }, repo);
    const git = simpleGit(repo);
    expect(await git.raw(["diff", "--name-only", base, head])).toBe(
      "src/a.ts\n",
    );
    expect(await git.show([`${head}:src/a.ts`])).toContain('"ho"');
  });

  it("writes binary base files and refuses a path outside the repo", async () => {
    const dir = await tmp();
    await writeFile(
      join(dir, "base.json"),
      JSON.stringify({
        files: {
          "img/a.bin": { base64: Buffer.from([0, 1, 2]).toString("base64") },
        },
      }),
    );
    const repo = join(await tmp(), "repo");
    await materializeCase({ dir }, repo);
    expect([...(await readFile(join(repo, "img/a.bin")))]).toEqual([0, 1, 2]);
    await writeFile(
      join(dir, "base.json"),
      JSON.stringify({ files: { "../out.txt": { utf8: "x" } } }),
    );
    await expect(materializeCase({ dir }, repo)).rejects.toThrow(
      /outside the repo/,
    );
  });

  it("refuses a base file inside .git, however it's spelled", async () => {
    const dir = await tmp();
    const repo = join(await tmp(), "repo");
    for (const path of [
      ".git/config",
      ".GIT/hooks/pre-commit",
      ".git./config",
      "GIT~1/config",
    ]) {
      await writeFile(
        join(dir, "base.json"),
        JSON.stringify({
          files: { [path]: { utf8: "[core]\n\tfsmonitor = leak\n" } },
        }),
      );
      await expect(materializeCase({ dir }, repo), path).rejects.toThrow(
        /inside \.git/,
      );
    }
    const config = await readFile(join(repo, ".git", "config"), "utf8");
    expect(config).not.toContain("fsmonitor");
  });

  it("refuses a path that reaches .git or leaves the repo through a link", async () => {
    const repo = join(await tmp(), "repo");
    const away = await tmp();
    await mkdir(repo, { recursive: true });
    await simpleGit(repo).init(["--quiet"]);
    // A junction needs no privilege on Windows; elsewhere it's a symlink.
    await symlink(join(repo, ".git"), join(repo, "into-git"), "junction");
    await symlink(away, join(repo, "away"), "junction");
    await expect(scratchPath(repo, "into-git/config")).rejects.toThrow(
      /inside \.git/,
    );
    await expect(
      scratchPath(repo, "into-git/hooks/new/pre-commit"),
    ).rejects.toThrow(/inside \.git/);
    await expect(scratchPath(repo, "away/x.txt")).rejects.toThrow(
      /outside the repo/,
    );
    expect(
      await stat(join(repo, ".git", "hooks", "new")).catch(() => null),
    ).toBeNull();
    await expect(scratchPath(repo, "src/new/a.ts")).resolves.toMatch(/a\.ts$/);
  });

  it("runs git in the scratch repo with no tokens, no global config and no hooks", async () => {
    const env = scratchGitEnv("NOHOOKS", "EMPTY");
    expect(env.GIT_CONFIG_GLOBAL).toBe("EMPTY");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect([env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_VALUE_0]).toEqual([
      "core.hooksPath",
      "NOHOOKS",
    ]);

    // A global config whose hooks would leave a mark if git ran them, and a
    // token in our environment.
    const root = await tmp();
    const hooks = join(root, "hooks");
    const marker = join(root, "hook-ran");
    const posix = (p: string) => p.split("\\").join("/");
    await mkdir(hooks);
    for (const name of ["pre-commit", "post-commit"]) {
      await writeFile(
        join(hooks, name),
        `#!/bin/sh\nenv > "${posix(marker)}"\n`,
      );
      await chmod(join(hooks, name), 0o755);
    }
    // HOME passes the allowlist, so git would read this .gitconfig unless
    // the scratch environment points the global config elsewhere.
    await writeFile(
      join(root, ".gitconfig"),
      `[core]\n\thooksPath = ${posix(hooks)}\n`,
    );
    const saved = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      GH_TOKEN: process.env.GH_TOKEN,
    };
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    process.env.GH_TOKEN = "a-token-from-the-caller";
    try {
      const dir = await tmp();
      await writeFile(
        join(dir, "base.json"),
        JSON.stringify({ files: { "a.txt": { utf8: "a\n" } } }),
      );
      await materializeCase({ dir }, join(await tmp(), "repo"));
    } finally {
      for (const [k, v] of Object.entries(saved))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    expect(await stat(marker).catch(() => null)).toBeNull();
  });

  it("makes an empty change from an empty diff", async () => {
    const root = await tmp();
    const dir = await makeCase(root, meta(), BASE, {});
    const repo = join(await tmp(), "repo");
    const { base, head } = await materializeCase({ dir }, repo);
    expect(base).not.toBe(head);
    expect(await simpleGit(repo).raw(["diff", "--name-only", base, head])).toBe(
      "",
    );
  });
});

describe("loadEvalCases", () => {
  it("skips a directory with no case.json, and fails on one it can't read", async () => {
    const root = await tmp();
    await makeCase(root, meta(), BASE, HEAD);
    await mkdir(join(root, "notes"));
    expect(await loadEvalCases(root)).toHaveLength(1);
    await mkdir(join(root, "broken", "case.json"), { recursive: true });
    await expect(loadEvalCases(root)).rejects.toThrow(
      /can't read .*case\.json/,
    );
  });

  it("refuses a case id that isn't a plain name, so no delete leaves the work root", async () => {
    const root = await tmp();
    const dir = await makeCase(root, meta(), BASE, HEAD);
    const sentinel = join(root, "keep.txt");
    await writeFile(sentinel, "still here\n");
    for (const id of ["..", ".", "", "../x", "a/b", "C:\\x", "/abs"]) {
      await writeFile(
        join(dir, "case.json"),
        JSON.stringify({ ...meta(), id }),
      );
      await expect(loadEvalCases(root), JSON.stringify(id)).rejects.toThrow(
        /id must be/,
      );
    }
    expect(await readFile(sentinel, "utf8")).toBe("still here\n");
  });

  it("fails on a proof.json it can't read rather than judging with no proof", async () => {
    const root = await tmp();
    const dir = await makeCase(root, meta(), BASE, HEAD);
    await mkdir(join(dir, "proof.json"));
    await expect(loadEvalCases(root)).rejects.toThrow(
      /can't read .*proof\.json/,
    );
  });
});

describe("judgeCase", () => {
  it("catches a defect the review blocks on, replaying recorded checks", async () => {
    const root = await tmp();
    await makeCase(root, meta(), BASE, HEAD);
    const [c] = await loadEvalCases(root);
    const run = await judgeCase(c!, {
      workRoot: join(await tmp(), "work"),
      review: review(
        {
          verdict: "request-changes",
          blocking: [
            {
              kind: "defect",
              file: "src/a.ts",
              line: 2,
              title: "greet() returns the wrong word",
              detail: "it says ho",
              repro: "call greet()",
              fix: "",
              acceptance_id: "A1",
            },
          ],
          acceptance: [{ id: "A1", status: "unmet", note: "says ho" }],
        },
        "request-changes",
      ),
    });
    expect(run.error).toBeUndefined();
    expect(run.outcome).toBe("caught");
    expect(run.verdict).toBe("failed");
    expect(run.matched).toEqual(["wrong word"]);
    expect(run.review?.costUsd).toBe(0.25);
    const lint = run.tier1?.checks.find((ch) => ch.id === "quality.lint.clean");
    expect(lint).toMatchObject({ source: "recorded", outcome: "pass" });
    expect(lint?.message).toMatch(/^recorded in the pilot's judge run/);
    // Named by the assembly, never recorded, never run: not a pass.
    expect(
      run.tier1?.checks.find((ch) => ch.id === "quality.typecheck.clean"),
    ).toMatchObject({ source: "not run", outcome: "n/a" });
  });

  it("misses a defect the review approves", async () => {
    const root = await tmp();
    await makeCase(root, meta(), BASE, HEAD);
    const [c] = await loadEvalCases(root);
    const run = await judgeCase(c!, {
      workRoot: join(await tmp(), "work"),
      review: review(
        { acceptance: [{ id: "A1", status: "met", note: "" }] },
        "approve",
      ),
    });
    expect(run.outcome).toBe("missed");
    expect(run.verdict).toBe("passed");
  });

  it("holds a clean case whose criterion the review couldn't verify", async () => {
    const root = await tmp();
    await makeCase(
      root,
      meta({ label: "clean", expected: "pass", signals: [] }),
      BASE,
      HEAD,
    );
    const [c] = await loadEvalCases(root);
    const run = await judgeCase(c!, {
      workRoot: join(await tmp(), "work"),
      review: review(
        { acceptance: [{ id: "A1", status: "unverified", note: "no test" }] },
        "needs-human",
      ),
    });
    expect(run.outcome).toBe("held");
    expect(run.asks).toEqual(["unverified_acceptance: A1 (no test)"]);
  });

  it("fails an empty change before any review, and says why", async () => {
    const root = await tmp();
    await makeCase(root, meta({ signals: ["empty"] }), BASE, {});
    const [c] = await loadEvalCases(root);
    const run = await judgeCase(c!, {
      workRoot: join(await tmp(), "work"),
      review: () => {
        throw new Error("no review for an empty change");
      },
    });
    expect(run.outcome).toBe("caught");
    expect(run.review).toBeNull();
    expect(run.why).toMatch(/the change is empty/);
  });

  it("reports a case it couldn't judge as an error, never a pass", async () => {
    const root = await tmp();
    await makeCase(
      root,
      meta({ label: "clean", expected: "pass", signals: [] }),
      BASE,
      HEAD,
    );
    const [c] = await loadEvalCases(root);
    const run = await judgeCase(c!, {
      workRoot: join(await tmp(), "work"),
      review: () => Promise.reject(new Error("the model is down")),
    });
    expect(run.outcome).toBe("error");
    expect(run.error).toBe("the model is down");
  });
});

describe("runJudgeEval", () => {
  it("judges tier 1 alone for free and writes the result", async () => {
    const root = await tmp();
    const cases = join(root, "cases");
    await makeCase(
      cases,
      meta({ id: "a-empty", signals: ["empty"] }),
      BASE,
      {},
    );
    await makeCase(
      cases,
      meta({ id: "b-clean", label: "clean", expected: "pass", signals: [] }),
      BASE,
      HEAD,
    );
    const out = join(root, "results");
    const { result, file } = await runJudgeEval({
      casesDir: cases,
      outDir: out,
      label: "smoke test",
      commit: "abc",
      tier2: false,
      now: new Date("2026-11-24T10:00:00Z"),
    });
    expect(result.cases.map((c) => [c.id, c.outcome])).toEqual([
      ["a-empty", "caught"],
      ["b-clean", "not-reviewed"],
    ]);
    expect(result.summary).toMatchObject({
      defects: 1,
      caught: 1,
      clean: 1,
      notReviewed: 1,
      errors: 0,
      costUsd: 0,
    });
    expect(file).toBe(join(out, "2026-11-24-smoke-test.json"));
    const written = JSON.parse(await readFile(file!, "utf8")) as {
      commit: string;
    };
    expect(written.commit).toBe("abc");
  });

  it("refuses a case id the corpus doesn't have", async () => {
    const root = await tmp();
    await makeCase(root, meta(), BASE, HEAD);
    await expect(
      runJudgeEval({ casesDir: root, only: ["nope"], tier2: false }),
    ).rejects.toThrow(/no such case/);
  });
});
