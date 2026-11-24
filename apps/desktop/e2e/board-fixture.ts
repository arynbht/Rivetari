import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

import { Ledger } from "./now-fixture";

// A repo for the task board and the task detail, with a task at every beat,
// written the way the runtime writes them (cards, HMAC-chained ledgers,
// assemblies, sealed judge rounds, proof files and a progress file):
//   T-0001 intake: a card to confirm     T-0005 ship: PR #42 waiting to merge,
//   T-0002 route: a route to approve            A2 hand-checked by a person
//   T-0003 build: running now            T-0006 close: merged and sealed
//   T-0004 judge: two rounds, the last   T-0007 prove: proving now
//          leaving A2 unverified; UI proof with screenshots and axe

const BY = "ann@example.com";
export const WHO = "e2e@example.com";

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

type Entry = [beat: string, section: string, text: string];

/** A small PNG: a light page with a dark header bar, so the image reads as a screenshot. */
export function screenshotPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // truecolour
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const shade = y < height / 6 ? 30 : 245;
    for (let x = 0; x < width; x++)
      rows.fill(
        shade,
        y * (width * 3 + 1) + 1 + x * 3,
        y * (width * 3 + 1) + 4 + x * 3,
      );
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
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
    "sectors: [ui, motion]",
    "phases: [build]",
    "skills: [design-system, react-patterns]",
    "spine: [rivetari-core]",
    "budget: { skill_tokens: 6000, context_tokens: 40000, steps: 12 }",
    "checks: [quality.lint.clean, quality.tests.pass]",
    "proof: ui-screenshots",
    "review: { rubric: default, design_pass: true, security: false }",
    "stop_and_ask: [new_dependency]",
    "gaps: [no vendored skill covers motion]",
    "",
  ].join("\n");

const ROUTE_DECISIONS: Entry[] = [
  ["route", "decision", "routed to ui: ui (path src/theme/**)"],
  ["route", "decision", "skill design-system matches sector ui"],
  ["route", "decision", "no vendored skill covers motion"],
];

function writeTask(
  repo: string,
  id: string,
  title: string,
  day: string,
  steps: (card: string, assembly: string) => Entry[],
): { ledger: Ledger; dir: string } {
  const dir = join(repo, ".rivetari", "tasks", id);
  mkdirSync(dir, { recursive: true });
  const card = cardFor(id, title);
  const assembly = assemblyFor(id);
  writeFileSync(join(dir, "card.yml"), card);
  const entries = steps(card, assembly);
  if (entries.some(([beat]) => beat !== "intake"))
    writeFileSync(join(dir, "assembly.yml"), assembly);
  const ledger = new Ledger(dir, day);
  ledger.append([
    "intake",
    "timeline",
    "card drafted with 2 acceptance criteria; awaiting confirmation",
  ]);
  for (const entry of entries) ledger.append(entry);
  return { ledger, dir };
}

/** Confirmed, routed with the router's reasons, approved, isolated, planned. */
const started = (card: string, assembly: string): Entry[] => [
  ["intake", "timeline", `intake confirmed; card sha256 ${sha256(card)}`],
  ...ROUTE_DECISIONS,
  [
    "route",
    "timeline",
    `assembly proposed; sha256 ${sha256(assembly)}; skills design-system, react-patterns; proof ui-screenshots; awaiting approval`,
  ],
  ["route", "timeline", `route approved; assembly sha256 ${sha256(assembly)}`],
  ["isolate", "timeline", "worktree .worktrees/T on rivetari/T"],
  [
    "build",
    "timeline",
    "build started · skills design-system, react-patterns · budget 12 steps / 40k ctx · 1200 tokens · $0.12",
  ],
  ["build", "plan", "1. Add a theme toggle to the header"],
  ["build", "plan", "2. Keep the choice in settings"],
  ["build", "plan", "3. Test both themes"],
];

const built: Entry[] = [
  [
    "build",
    "timeline",
    "build done · commit 0123456789ab · 3 file(s) this round · 800 tokens · $0.08",
  ],
  ["prove", "timeline", "proof passed · 4 screenshot(s), axe 1 moderate"],
];

const finding = (kind: string, title: string, over = {}) => ({
  kind,
  file: "src/theme/toggle.tsx",
  line: 14,
  acceptance_id: null,
  title,
  detail: `${title}: the detail`,
  repro: "open settings and switch twice",
  fix: "store the value before re-rendering",
  ...over,
});

const roundRecord = (
  id: string,
  round: number,
  verdict: string,
  review: Record<string, unknown>,
) =>
  `${JSON.stringify(
    {
      task: id,
      round,
      verdict,
      head: "0123456789abcdef0123",
      base: "fedcba9876543210",
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
            message: "1 failing test fails on the base too",
          },
        ],
        protected: [],
        notes: [],
      },
      review: {
        body: "",
        model: "claude-e2e",
        unreviewed: [],
        usage: { tokens: 1000, costUsd: 0.1 },
        ...review,
      },
      risk: { card: "medium", effective: "medium", reasons: [] },
    },
    null,
    2,
  )}\n`;

/** Writes round `n`'s record and seals it in the ledger, as the judge beat does. */
function judgeRound(
  dir: string,
  ledger: Ledger,
  n: number,
  verdict: string,
  text: string,
  asks: string[],
): void {
  mkdirSync(join(dir, "judge"), { recursive: true });
  writeFileSync(join(dir, "judge", `round-${n}.json`), text);
  for (const ask of asks) ledger.append(["judge", "stop", `asked: ${ask}`]);
  ledger.append([
    "judge",
    "timeline",
    `judge ${verdict} · round ${n} · head 0123456789ab · record sha256 ${sha256(text)}`,
  ]);
}

export function boardRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "rivetari-e2e-board-"));
  writeFileSync(join(repo, "README.md"), "# board fixture\n");

  writeTask(repo, "T-0001", "Add a dark mode toggle", "2026-11-21", () => []);
  writeTask(
    repo,
    "T-0002",
    "Move settings to the design system",
    "2026-11-21",
    (card, assembly) => [
      ["intake", "timeline", `intake confirmed; card sha256 ${sha256(card)}`],
      ...ROUTE_DECISIONS,
      [
        "route",
        "timeline",
        `assembly proposed; sha256 ${sha256(assembly)}; skills design-system, react-patterns; proof ui-screenshots; awaiting approval`,
      ],
    ],
  );
  writeTask(repo, "T-0003", "Show running beats live", "2026-11-22", started);
  const now = Date.now();
  writeFileSync(
    join(repo, ".rivetari", "tasks", "T-0003.progress.json"),
    JSON.stringify({
      beat: "build",
      startedAt: new Date(now - 8 * 60_000).toISOString(),
      lastActivityAt: new Date(now - 5_000).toISOString(),
      turns: 11,
      tokens: 31_000,
      lastTool: "Edit",
      pid: process.pid,
    }),
  );

  // Judged twice: round 1 sent it back, round 2 left A2 unverified.
  const judged = writeTask(
    repo,
    "T-0004",
    "Tighten the theme toggle",
    "2026-11-22",
    (card, assembly) => [...started(card, assembly), ...built],
  );
  judgeRound(
    judged.dir,
    judged.ledger,
    1,
    "failed",
    roundRecord("T-0004", 1, "failed", {
      verdict: "request-changes",
      blocking: [finding("defect", "The toggle forgets the choice on reload")],
      suggestions: [],
      acceptance: [
        { id: "A1", status: "met", note: "the e2e switches the theme" },
        { id: "A2", status: "unmet", note: "the choice is lost on reload" },
      ],
    }),
    [],
  );
  judged.ledger.append([
    "build",
    "timeline",
    "build done · commit 0123456789ab · 1 file(s) this round · 300 tokens · $0.03",
  ]);
  judgeRound(
    judged.dir,
    judged.ledger,
    2,
    "needs a human",
    roundRecord("T-0004", 2, "needs a human", {
      verdict: "approve",
      blocking: [],
      suggestions: [
        finding("suggestion", "Name the storage key once", { file: "" }),
      ],
      acceptance: [
        { id: "A1", status: "met", note: "the e2e switches the theme" },
        {
          id: "A2",
          status: "unverified",
          note: "no test reloads the app",
        },
      ],
    }),
    ["unverified_acceptance: A2 (no test reloads the app)"],
  );
  const proof = join(judged.dir, "proof");
  mkdirSync(proof, { recursive: true });
  for (const side of ["before", "after"])
    writeFileSync(join(proof, `${side}-home-lg.png`), screenshotPng(640, 400));
  writeFileSync(
    join(proof, "test-run.txt"),
    "pnpm run test · exit 0\nnew tests:\n  src/theme/toggle.test.ts: keeps the choice\n\n 12 passed\n",
  );
  writeFileSync(
    join(proof, "proof.json"),
    JSON.stringify(
      {
        task: "T-0004",
        kind: "ui-screenshots",
        passed: true,
        lines: [
          "2 screenshot(s) of / at lg, before and after",
          "axe on the change: 1 moderate",
        ],
        shots: [
          {
            page: "/",
            breakpoint: "lg",
            file: join(proof, "before-home-lg.png"),
            status: 200,
            side: "before",
          },
          {
            page: "/",
            breakpoint: "lg",
            file: join(proof, "after-home-lg.png"),
            status: 200,
            side: "after",
          },
        ],
        violations: [{ id: "region", impact: "moderate", page: "/", nodes: 1 }],
        tests: {
          exitCode: 0,
          added: ["src/theme/toggle.test.ts: keeps the choice"],
          output: "12 passed",
          outcome: "pass",
        },
      },
      null,
      2,
    ),
  );

  // Shipped: the judge left A2 unverified, and a person allowed it.
  const shipped = writeTask(
    repo,
    "T-0005",
    "Fix the update banner contrast",
    "2026-11-23",
    (card, assembly) => [...started(card, assembly), ...built],
  );
  judgeRound(
    shipped.dir,
    shipped.ledger,
    1,
    "needs a human",
    roundRecord("T-0005", 1, "needs a human", {
      verdict: "approve",
      blocking: [],
      suggestions: [],
      acceptance: [
        { id: "A1", status: "met", note: "contrast is 7:1" },
        { id: "A2", status: "unverified", note: "a person has to look" },
      ],
    }),
    ["unverified_acceptance: A2 (a person has to look)"],
  );
  shipped.ledger.append([
    "judge",
    "stop",
    "answered: allowed — checked it on my machine",
  ]);
  shipped.ledger.append([
    "ship",
    "timeline",
    "draft PR opened: #42 https://github.com/arynbht/example/pull/42 · rivetari/T-0005 at 0123456789ab → main",
  ]);

  writeTask(
    repo,
    "T-0006",
    "Rename the update setting",
    "2026-11-20",
    (card, assembly) => [
      ...started(card, assembly),
      [
        "ship",
        "timeline",
        "draft PR opened: #40 https://github.com/arynbht/example/pull/40 · rivetari/T-0006 at 0123456789ab → main",
      ],
      [
        "close",
        "outcome",
        "PR #40 merged by ann@example.com 2026-11-20 11:00 · 1h · 1.2k tokens · $0.12",
      ],
      ["close", "timeline", "ledger sealed"],
    ],
  );
  writeTask(
    repo,
    "T-0007",
    "Shoot the settings page",
    "2026-11-23",
    (card, assembly) => [
      ...started(card, assembly),
      [
        "build",
        "timeline",
        "build done · commit 0123456789ab · 2 file(s) this round · 500 tokens · $0.05",
      ],
      ["prove", "timeline", "prove started · ui-screenshots"],
    ],
  );

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", WHO);
  git("config", "user.name", "E2E");
  git("commit", "-q", "--allow-empty", "-m", "init");
  return repo;
}
