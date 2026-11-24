import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  JudgeRecord,
  JudgeRound,
  LedgerEntry,
  TaskView,
} from "@arynbht/rivetari-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskDetail } from "../../shared/ipc";
import {
  criteriaStatus,
  MAX_SHOT_BYTES,
  pngSize,
  readProof,
  roundView,
  taskDetail,
} from "./task-detail";

// The task detail's reading of the record: each criterion's status from the
// latest judge round or a person's answer, every round as the detail shows it,
// and the proof from this machine's proof directory, never outside it.

let seq = 0;
const entry = (
  beat: LedgerEntry["beat"],
  section: LedgerEntry["section"],
  text: string,
): LedgerEntry => ({
  seq: ++seq,
  at: "2026-11-22T10:00:00.000Z",
  beat,
  section,
  text,
  by: "ann@example.com",
  prev: "x",
  mac: "y",
});

const CARD = {
  id: "T-0001",
  title: "Dark mode",
  type: "feature" as const,
  source: "prompt",
  description: "Readers can switch the theme.",
  acceptance: [
    { id: "A1", text: "A toggle works", verify: "e2e" as const },
    { id: "A2", text: "The choice is kept", verify: "unit" as const },
    { id: "A3", text: "Looks right", verify: "manual" as const },
    { id: "A4", text: "No regressions", verify: "unit" as const },
  ],
  out_of_scope: ["print styles"],
  touches: ["src/theme/**"],
  pages: [],
  constraints: [],
  risk: "medium" as const,
  owner: "ann@example.com",
  created: "2026-11-20",
};

const record = (over: Partial<JudgeRecord> = {}): JudgeRecord => ({
  task: "T-0001",
  round: 2,
  verdict: "needs a human",
  head: "0123456789abcdef",
  base: "main",
  tier1: {
    verdict: "pass",
    checks: [
      {
        id: "quality.lint.clean",
        title: "Lint",
        base: "green",
        head: "green",
        outcome: "pass",
        message: "",
      },
      {
        id: "quality.tests.pass",
        title: "Tests",
        base: "red",
        head: "red",
        outcome: "pre-existing",
        message: "red on base too",
      },
      {
        id: "quality.coverage",
        title: "Coverage",
        base: "n/a",
        head: "n/a",
        outcome: "n/a",
        message: "skipped",
      },
    ],
    protected: [
      {
        reason: "lint-config",
        path: "eslint.config.js",
        detail: "lint config changed",
      } as never,
    ],
    notes: ["a note"],
  },
  review: {
    verdict: "blocking" as never,
    body: "",
    model: "claude-test",
    blocking: [
      {
        kind: "defect",
        file: "src/a.ts",
        line: 3,
        acceptance_id: null,
        title: "Crashes",
        detail: "null",
        repro: "click",
        fix: "guard",
      },
    ],
    suggestions: [
      {
        kind: "suggestion",
        file: "",
        line: null,
        title: "Rename",
        detail: "",
        repro: "",
        fix: "",
        downgraded: "not reproducible",
      },
    ],
    acceptance: [
      { id: "A1", status: "met", note: "e2e ran" },
      { id: "A2", status: "unmet", note: "not saved" },
      { id: "A3", status: "unverified", note: "needs eyes" },
    ],
    unreviewed: [],
    usage: { tokens: 10, costUsd: 0.01 },
  },
  ...over,
});

const round = (over: Partial<JudgeRound> = {}): JudgeRound => ({
  round: 2,
  verdict: "needs a human",
  at: "2026-11-22T11:00:00.000Z",
  record: record(),
  problem: null,
  ...over,
});

describe("each criterion's status", () => {
  it("is not judged before any round", () => {
    const { judgedRound, acceptance } = criteriaStatus(CARD, [], []);
    expect(judgedRound).toBeNull();
    expect(acceptance.map((a) => a.status)).toEqual([
      "not judged",
      "not judged",
      "not judged",
      "not judged",
    ]);
  });

  it("is the latest round's word: met, unmet, unverified, and unverified when the reviewer is silent", () => {
    const { judgedRound, acceptance } = criteriaStatus(CARD, [round()], []);
    expect(judgedRound).toBe(2);
    expect(acceptance.map((a) => [a.id, a.status, a.note])).toEqual([
      ["A1", "met", "e2e ran"],
      ["A2", "unmet", "not saved"],
      ["A3", "unverified", "needs eyes"],
      ["A4", "unverified", "the reviewer didn't report on it"],
    ]);
  });

  it("is hand-checked when a person allowed the judge's question about it", () => {
    const entries = [
      entry(
        "judge",
        "stop",
        "asked: unverified_acceptance: A3 (needs eyes); A4 (silent)",
      ),
      entry("judge", "stop", "answered: allowed — looked at it myself"),
    ];
    const { acceptance } = criteriaStatus(CARD, [round()], entries);
    expect(acceptance.map((a) => [a.id, a.status])).toEqual([
      ["A1", "met"],
      ["A2", "unmet"],
      ["A3", "hand-checked"],
      ["A4", "hand-checked"],
    ]);
    expect(acceptance[2]?.note).toBe(
      "allowed by ann@example.com: looked at it myself",
    );
  });

  it("counts only the answer to the latest question, not an earlier one to the same words", () => {
    const reasked = [
      entry("judge", "stop", "asked: unverified_acceptance: A3 (needs eyes)"),
      entry("judge", "stop", "answered: allowed — fine then"),
      entry("judge", "stop", "asked: unverified_acceptance: A3 (needs eyes)"),
    ];
    expect(criteriaStatus(CARD, [round()], reasked).acceptance[2]?.status).toBe(
      "unverified",
    );
  });

  it("stays unverified while the question is open, denied, or the round went back to build", () => {
    const open = [
      entry("judge", "stop", "asked: unverified_acceptance: A3 (old)"),
      entry("judge", "stop", "answered: allowed"),
      entry("judge", "stop", "asked: unverified_acceptance: A3 (new)"),
    ];
    expect(criteriaStatus(CARD, [round()], open).acceptance[2]?.status).toBe(
      "unverified",
    );
    const denied = [
      entry("judge", "stop", "asked: unverified_acceptance: A3 (x)"),
      entry("judge", "stop", "answered: denied — rebuild"),
    ];
    expect(criteriaStatus(CARD, [round()], denied).acceptance[2]?.status).toBe(
      "unverified",
    );
    const allowed = [
      entry("judge", "stop", "asked: unverified_acceptance: A3 (x)"),
      entry("judge", "stop", "answered: allowed"),
    ];
    expect(
      criteriaStatus(CARD, [round({ verdict: "failed" })], allowed)
        .acceptance[2]?.status,
    ).toBe("unverified");
  });

  it("says why, when the round's record can't be read or the review didn't run", () => {
    const unread = criteriaStatus(
      CARD,
      [round({ record: null, problem: "round-2.json doesn't match" })],
      [],
    );
    expect(unread.acceptance[0]).toMatchObject({
      status: "unverified",
      note: "round 2's record can't be read: round-2.json doesn't match",
    });
    const tier1 = criteriaStatus(
      CARD,
      [round({ record: record({ review: undefined }) })],
      [],
    );
    expect(tier1.acceptance[1]?.note).toBe(
      "the review didn't run in round 2 (tier 1: pass)",
    );
  });
});

describe("a judge round as the detail shows it", () => {
  it("has tier 1's checks that ran, protected paths and notes, then the review's findings", () => {
    const view = roundView(round());
    expect(view.tier1).toEqual({
      verdict: "pass",
      checks: [
        {
          id: "quality.lint.clean",
          title: "Lint",
          outcome: "pass",
          message: "",
        },
        {
          id: "quality.tests.pass",
          title: "Tests",
          outcome: "pre-existing",
          message: "red on base too",
        },
      ],
      protectedPaths: ["eslint.config.js: lint config changed"],
      notes: ["a note"],
    });
    expect(view.review?.blocking[0]).toEqual({
      kind: "defect",
      title: "Crashes",
      file: "src/a.ts",
      line: 3,
      acceptanceId: null,
      detail: "null",
      repro: "click",
      fix: "guard",
      downgraded: null,
    });
    expect(view.review?.suggestions[0]).toMatchObject({
      file: null,
      downgraded: "not reproducible",
    });
    expect(view.head).toBe("0123456789abcdef");
  });

  it("keeps a round whose record failed its seal, or isn't one it can read, with why", () => {
    expect(
      roundView(round({ record: null, problem: "bad seal" })),
    ).toMatchObject({
      problem: "bad seal",
      tier1: null,
      review: null,
    });
    const odd = roundView(
      round({ record: { round: 2 } as unknown as JudgeRecord }),
    );
    expect(odd.problem).toMatch(
      /^round 2's record isn't one this version can read/,
    );
  });
});

/** A 1×2 PNG header, enough for its size. */
const png = (width: number, height: number, pad = 0) => {
  const b = Buffer.alloc(33 + pad);
  Buffer.from("89504e470d0a1a0a", "hex").copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
};

describe("a PNG's size", () => {
  it("comes from its header, and anything else isn't a PNG", () => {
    expect(pngSize(png(1280, 800))).toEqual({ width: 1280, height: 800 });
    expect(pngSize(Buffer.from("not a png at all, really not"))).toBeNull();
  });
});

describe("the proof on this machine", () => {
  let repo = "";
  let dir = "";
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "rivetari-detail-"));
    dir = join(repo, ".rivetari", "tasks", "T-0001", "proof");
    await mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("is none before the prove beat", async () => {
    await rm(dir, { recursive: true });
    expect(await readProof(repo, "T-0001")).toEqual({
      record: null,
      error: null,
    });
  });

  it("reads proof.json, test-run.txt and each screenshot by its name in the proof directory alone", async () => {
    await writeFile(join(dir, "after-home-lg.png"), png(1280, 800));
    await writeFile(join(repo, "outside.png"), png(10, 10));
    await writeFile(join(dir, "test-run.txt"), "pnpm run test · exit 0\nok\n");
    await writeFile(
      join(dir, "proof.json"),
      JSON.stringify({
        task: "T-0001",
        kind: "ui-screenshots",
        passed: true,
        lines: ["2 screenshot(s)"],
        shots: [
          {
            side: "after",
            page: "/",
            breakpoint: "lg",
            status: 200,
            file: "C:\\elsewhere\\proof\\after-home-lg.png",
          },
          {
            side: "before",
            page: "/",
            breakpoint: "lg",
            status: 200,
            file: "/x/before-home-lg.png",
          },
          {
            side: "after",
            page: "/",
            breakpoint: "sm",
            status: 200,
            file: "../../outside.txt",
          },
        ],
        violations: [
          { id: "color-contrast", impact: "serious", page: "/", nodes: 2 },
        ],
      }),
    );
    const { record, error } = await readProof(repo, "T-0001");
    expect(error).toBeNull();
    expect(record).toMatchObject({
      kind: "ui-screenshots",
      passed: true,
      ui: true,
      testRun: "pnpm run test · exit 0\nok\n",
      violations: [
        { id: "color-contrast", impact: "serious", page: "/", nodes: 2 },
      ],
      tests: null,
    });
    expect(record?.shots[0]).toMatchObject({
      file: "after-home-lg.png",
      width: 1280,
      height: 800,
      bytes: 33,
      problem: null,
    });
    expect(record?.shots[0]?.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(record?.shots[1]).toMatchObject({
      file: "before-home-lg.png",
      dataUrl: null,
      problem: "not on this machine",
    });
    expect(record?.shots[2]).toMatchObject({
      dataUrl: null,
      problem: "outside.txt isn't a PNG file name",
    });
  });

  it("lists a screenshot too large to show, and keeps a long test run's end", async () => {
    const readFile = vi.fn(async (path: string) => {
      if (path.endsWith("proof.json"))
        return Buffer.from(
          JSON.stringify({
            task: "T-0001",
            kind: "test-run",
            passed: false,
            lines: [],
            shots: [
              {
                side: "after",
                page: "/",
                breakpoint: "lg",
                status: 200,
                file: "big.png",
              },
            ],
            tests: {
              exitCode: 1,
              added: ["a.test.ts: works"],
              output: "",
              outcome: "fail",
            },
          }),
        );
      if (path.endsWith("test-run.txt"))
        return Buffer.from(`${"x".repeat(70_000)}THE END`);
      return png(10, 10, MAX_SHOT_BYTES);
    });
    const { record } = await readProof(repo, "T-0001", {
      readFile,
      loadJudgeRounds: vi.fn(),
    });
    expect(record?.shots[0]).toMatchObject({ dataUrl: null, width: 10 });
    expect(record?.shots[0]?.problem).toMatch(/^too large to show here/);
    expect(record?.testRun?.startsWith("…")).toBe(true);
    expect(record?.testRun?.endsWith("THE END")).toBe(true);
    expect(record?.tests).toEqual({
      exitCode: 1,
      added: ["a.test.ts: works"],
      outcome: "fail",
    });
    expect(record?.ui).toBe(true);
  });

  it("says why when proof.json can't be read", async () => {
    await writeFile(join(dir, "proof.json"), "{not json");
    const proof = await readProof(repo, "T-0001");
    expect(proof.record).toBeNull();
    expect(proof.error).toMatch(
      /^can't read \.rivetari\/tasks\/T-0001\/proof\/proof\.json: /,
    );
  });
});

describe("a task's detail", () => {
  const ASSEMBLY = [
    "task: T-0001",
    "sectors: [ui]",
    "phases: [build]",
    "skills: [design-system]",
    "spine: [house-rules]",
    "budget: { skill_tokens: 1000, context_tokens: 4000, steps: 30 }",
    "checks: [quality.lint.clean]",
    "proof: ui-screenshots",
    "review: { rubric: default, design_pass: true, security: false }",
    "stop_and_ask: [new_dependency]",
    "gaps: [no vendored skill covers motion]",
    "",
  ].join("\n");

  const base: TaskView = {
    id: "T-0001",
    title: "Dark mode",
    type: "feature",
    risk: "medium",
    owner: "ann@example.com",
    beat: "judge",
    next: "ship",
    done: false,
    source: "local",
    lease: null,
    buildRounds: 1,
    judgeRounds: 1,
    tokens: 0,
    costUsd: 0,
    pr: null,
    needsYou: null,
    problems: [],
    card: CARD,
    assemblyText: ASSEMBLY,
    entries: [
      entry("route", "decision", "routed to ui: ui (path src/theme/**)"),
      entry(
        "route",
        "timeline",
        "assembly proposed; sha256 x; awaiting approval",
      ),
      entry("build", "timeline", "build started · skills design-system"),
      entry("build", "plan", "1. Add the toggle"),
      entry("build", "plan", "2. Keep the choice"),
    ],
  };

  it("has the card with statuses, the route with the router's reasons, the plan, the rounds and the proof", async () => {
    const loadJudgeRounds = vi.fn(async () => [round()]);
    const readFile = vi.fn(async () => {
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    });
    const detail = TaskDetail.parse(
      await taskDetail("/repo", base, { loadJudgeRounds, readFile }),
    );
    expect(loadJudgeRounds).toHaveBeenCalledWith("/repo", {
      card: { id: "T-0001" },
      entries: base.entries,
    });
    expect(detail.card?.acceptance.map((a) => a.status)).toEqual([
      "met",
      "unmet",
      "unverified",
      "unverified",
    ]);
    expect(detail.card?.outOfScope).toEqual(["print styles"]);
    expect(detail.judgedRound).toBe(2);
    expect(detail.route).toMatchObject({
      approved: false,
      reasons: ["routed to ui: ui (path src/theme/**)"],
      assembly: {
        skills: ["design-system"],
        spine: ["house-rules"],
        gaps: ["no vendored skill covers motion"],
      },
    });
    expect(detail.plan).toEqual(["Add the toggle", "Keep the choice"]);
    expect(detail.judge.rounds).toHaveLength(1);
    expect(detail.proof).toEqual({ record: null, error: null });
  });

  it("reads each part on its own: no route before routing, and a judge read that fails says so", async () => {
    const detail = await taskDetail(
      "/repo",
      { ...base, assemblyText: undefined, card: undefined, entries: [] },
      {
        loadJudgeRounds: vi.fn(async () => {
          throw new Error("disk on fire");
        }),
        readFile: vi.fn(async () => {
          throw Object.assign(new Error("gone"), { code: "ENOENT" });
        }),
      },
    );
    expect(detail).toMatchObject({
      card: null,
      route: null,
      plan: [],
      judgedRound: null,
      judge: {
        rounds: [],
        error: "the judge's rounds can't be read: disk on fire",
      },
    });
  });
});
