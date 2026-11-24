import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LEDGER_KEY } from "./tasks-fixture";

// A repo for the Now view with one task at each kind of wait and one running,
// written the way the runtime writes them: a card, a ledger chained by HMAC
// under the e2e key, an assembly, a judge round sealed in the ledger, and a
// progress file from this (live) process. It's a git repo with its own user, so
// an action is recorded under that name and pushed to its local tasks branch.
//   T-0001 a card to confirm         T-0005 shipped, its PR waiting to merge
//   T-0002 a route to approve        T-0006 building now
//   T-0003 stopped to ask            T-0007 merged and closed
//   T-0004 the judge wants a person

export const WHO = "e2e@example.com";
const BY = "ann@example.com";
const here = dirname(fileURLToPath(import.meta.url));

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

type Entry = [beat: string, section: string, text: string];

/** Writes one task's ledger entries, each chained to the one before. */
export class Ledger {
  private seq = 0;
  private prev = "genesis";
  private minute = 0;
  constructor(
    private readonly dir: string,
    private readonly day: string,
  ) {}

  /** Appends an entry, a minute after the last unless `at` says when. */
  append([beat, section, text]: Entry, at?: string): void {
    this.seq += 1;
    this.minute += 1;
    const base = {
      seq: this.seq,
      at:
        at ?? `${this.day}T10:${String(this.minute).padStart(2, "0")}:00.000Z`,
      beat,
      section,
      text,
      by: BY,
      prev: this.prev,
    };
    const mac = createHmac("sha256", Buffer.from(LEDGER_KEY, "hex"))
      .update(
        JSON.stringify([
          base.seq,
          base.at,
          base.beat,
          base.section,
          base.text,
          base.by,
          base.prev,
        ]),
      )
      .digest("hex");
    appendFileSync(
      join(this.dir, "ledger.jsonl"),
      `${JSON.stringify({ ...base, mac })}\n`,
    );
    this.prev = mac;
  }
}

const cardFor = (id: string, title: string) =>
  [
    `id: ${id}`,
    `title: ${title}`,
    "type: feature",
    "source: prompt",
    `description: ${title}, so readers can choose.`,
    "acceptance:",
    "  - id: A1",
    "    text: A toggle switches the theme",
    "    verify: e2e",
    "  - id: A2",
    "    text: The choice is kept across launches",
    "    verify: unit",
    "out_of_scope:",
    "  - print styles",
    "touches: []",
    "pages: []",
    "constraints: []",
    "risk: medium",
    `owner: ${BY}`,
    "created: 2026-11-20",
    "",
  ].join("\n");

const assemblyFor = (id: string) =>
  [
    `task: ${id}`,
    "sectors: [ui]",
    "phases: [build]",
    "skills: []",
    "spine: []",
    "budget: { skill_tokens: 0, context_tokens: 4000, steps: 30 }",
    "checks: [quality.lint.clean]",
    "proof: ui-screenshots",
    "review: { rubric: default, design_pass: true, security: false }",
    "stop_and_ask: [new_dependency]",
    "gaps: [no vendored skill covers motion]",
    "",
  ].join("\n");

const DRAFTED: Entry = [
  "intake",
  "timeline",
  "card drafted with 2 acceptance criteria; awaiting confirmation",
];

function task(
  repo: string,
  id: string,
  title: string,
  day: string,
  steps: (card: string, assembly: string) => Entry[],
): Ledger {
  const dir = join(repo, ".rivetari", "tasks", id);
  mkdirSync(dir, { recursive: true });
  const card = cardFor(id, title);
  const assembly = assemblyFor(id);
  writeFileSync(join(dir, "card.yml"), card);
  const entries = steps(card, assembly);
  if (entries.some(([beat]) => beat !== "intake"))
    writeFileSync(join(dir, "assembly.yml"), assembly);
  const ledger = new Ledger(dir, day);
  for (const entry of [DRAFTED, ...entries]) ledger.append(entry);
  return ledger;
}

/** Confirmed and routed, the route approved and the worktree made. */
const started = (card: string, assembly: string): Entry[] => [
  ["intake", "timeline", `intake confirmed; card sha256 ${sha256(card)}`],
  ["route", "timeline", `route approved; assembly sha256 ${sha256(assembly)}`],
  ["isolate", "timeline", "worktree .worktrees/T on rivetari/T"],
  [
    "build",
    "timeline",
    "build started · 3 repo file(s) in context · 1200 tokens · $0.12",
  ],
];

const JUDGE_ROUND = JSON.stringify(
  {
    task: "T-0004",
    round: 1,
    verdict: "needs a human",
    head: "0123456789ab",
    base: "main",
    tier1: {
      verdict: "needs-human",
      checks: [],
      protected: [
        {
          reason: "lint-config",
          path: "eslint.config.js",
          detail: "lint config changed",
        },
      ],
      notes: [],
    },
    review: {
      verdict: "blocking",
      body: "",
      model: "e2e",
      blocking: [
        {
          kind: "contract",
          file: "eslint.config.js",
          line: 12,
          title: "Turns off a lint rule CONSTRAINTS.md requires",
          detail: "no-floating-promises is disabled for src/",
        },
      ],
      suggestions: [],
      acceptance: [{ id: "A1", status: "unverified", note: "no e2e ran" }],
      unreviewed: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    },
  },
  null,
  2,
);

/** A progress file as the runtime writes it, from this (live) process. */
function progress(repo: string, id: string): void {
  const now = Date.now();
  writeFileSync(
    join(repo, ".rivetari", "tasks", `${id}.progress.json`),
    JSON.stringify({
      beat: "build",
      startedAt: new Date(now - 12 * 60_000).toISOString(),
      lastActivityAt: new Date(now - 10_000).toISOString(),
      turns: 18,
      tokens: 52_000,
      lastTool: "Edit",
      pid: process.pid,
    }),
  );
}

/** The repo, and the running task's ledger, so a test can append to it live. */
export function nowRepo(): { repo: string; running: Ledger } {
  const repo = mkdtempSync(join(tmpdir(), "rivetari-e2e-now-"));
  writeFileSync(join(repo, "README.md"), "# now fixture\n");
  mkdirSync(join(repo, ".rivetari"), { recursive: true });
  copyFileSync(
    join(here, "fixtures", "sample-repo", ".rivetari", "profile.yml"),
    join(repo, ".rivetari", "profile.yml"),
  );

  task(repo, "T-0001", "Add a dark mode toggle", "2026-11-21", () => []);
  task(
    repo,
    "T-0002",
    "Move settings to the design system",
    "2026-11-21",
    (card, assembly) => [
      ["intake", "timeline", `intake confirmed; card sha256 ${sha256(card)}`],
      ["route", "decision", "routed to ui: ui (path src/settings/**)"],
      ["route", "decision", "no vendored skill covers motion"],
      [
        "route",
        "timeline",
        `assembly proposed; sha256 ${sha256(assembly)}; skills none; proof ui-screenshots; awaiting approval`,
      ],
    ],
  );
  task(
    repo,
    "T-0003",
    "Add a theme switch component",
    "2026-11-22",
    (card, assembly) => [
      ...started(card, assembly),
      ["build", "stop", "asked: dependency: adds @radix-ui/react-switch"],
      [
        "build",
        "timeline",
        "build paused: 1 thing(s) to ask about · commit abc1234abc12 · 500 tokens · $0.05",
      ],
    ],
  );
  const judged = task(
    repo,
    "T-0004",
    "Tighten the lint setup",
    "2026-11-22",
    (card, assembly) => [
      ...started(card, assembly),
      [
        "build",
        "timeline",
        "build done · commit 0123456789ab · 2 file(s) this round · 800 tokens · $0.08",
      ],
      ["prove", "timeline", "proof passed · 2 screenshot(s), axe clean"],
    ],
  );
  const dir4 = join(repo, ".rivetari", "tasks", "T-0004");
  mkdirSync(join(dir4, "judge"), { recursive: true });
  writeFileSync(join(dir4, "judge", "round-1.json"), JUDGE_ROUND);
  judged.append([
    "judge",
    "timeline",
    `judge needs a human · round 1 · head 0123456789ab · record sha256 ${sha256(JUDGE_ROUND)}`,
  ]);
  judged.append([
    "judge",
    "stop",
    "asked: judge: eslint.config.js changed, a protected path; a person decides",
  ]);
  task(
    repo,
    "T-0005",
    "Fix the update banner contrast",
    "2026-11-23",
    (card, assembly) => [
      ...started(card, assembly),
      [
        "build",
        "timeline",
        "build done · commit 0123456789ab · 2 file(s) this round · 800 tokens · $0.08",
      ],
      ["prove", "timeline", "proof passed · 2 screenshot(s), axe clean"],
      [
        "judge",
        "timeline",
        "judge passed · round 1 · head 0123456789ab · record sha256 00",
      ],
      [
        "ship",
        "timeline",
        "draft PR opened: #42 https://github.com/arynbht/example/pull/42 · rivetari/T-0005 at 0123456789ab → main",
      ],
    ],
  );
  const running = task(
    repo,
    "T-0006",
    "Show running beats live",
    "2026-11-23",
    started,
  );
  progress(repo, "T-0006");
  task(
    repo,
    "T-0007",
    "Rename the update setting",
    "2026-11-20",
    (card, assembly) => [
      ...started(card, assembly),
      [
        "ship",
        "timeline",
        "draft PR opened: #40 https://github.com/arynbht/example/pull/40 · rivetari/T-0007 at 0123456789ab → main",
      ],
      [
        "close",
        "outcome",
        "PR #40 merged by ann@example.com 2026-11-20 11:00 · 1h · 1.2k tokens · $0.12",
      ],
      ["close", "timeline", "ledger sealed"],
    ],
  );

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", WHO);
  git("config", "user.name", "E2E");
  git("commit", "-q", "--allow-empty", "-m", "init");
  return { repo, running };
}

/** A repo with no tasks at all. */
export function emptyRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "rivetari-e2e-empty-"));
  writeFileSync(join(repo, "README.md"), "# no tasks yet\n");
  return repo;
}
