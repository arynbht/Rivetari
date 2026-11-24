import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Ledger } from "./now-fixture";

const PROFILE = [
  "version: 1",
  "name: history-repo",
  "type: web-app",
  "stack: [node, typescript]",
  "flags: {}",
  "phase: build",
  "autonomy: supervised",
  "",
].join("\n");

function cardYaml(id: string, title: string, risk: "low" | "medium"): string {
  return [
    `id: ${id}`,
    `title: ${title}`,
    "type: fix",
    "source: prompt",
    `description: ${title}.`,
    "acceptance:",
    "  - id: A1",
    "    text: passes",
    "    verify: unit",
    "out_of_scope: []",
    "touches: []",
    "pages: []",
    "constraints: []",
    `risk: ${risk}`,
    "owner: ann@example.com",
    "created: 2026-11-22",
    "",
  ].join("\n");
}

function writeSealedTask(
  repo: string,
  opts: {
    id: string;
    title: string;
    day: string;
    risk: "low" | "medium";
    pr?: number;
    outcome: "merged" | "abandoned";
    buildCost: number;
    judgeCost: number;
  },
): void {
  const dir = join(repo, ".rivetari", "tasks", opts.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "card.yml"),
    cardYaml(opts.id, opts.title, opts.risk),
  );
  const ledger = new Ledger(dir, opts.day);
  ledger.append(
    ["intake", "card", `${opts.id}: "${opts.title}" (${opts.risk})`],
    `${opts.day}T09:00:00.000Z`,
  );
  ledger.append(["confirm", "card", "confirmed"], `${opts.day}T09:02:00.000Z`);
  ledger.append(
    ["route", "assembly", "sectors: [desktop]"],
    `${opts.day}T09:04:00.000Z`,
  );
  ledger.append(
    ["approve", "assembly", "approved"],
    `${opts.day}T09:05:00.000Z`,
  );
  ledger.append(
    [
      "build",
      "timeline",
      `build done · commit abcdef123456 · 2 file(s) this round · 2000 tokens · $${opts.buildCost.toFixed(2)}`,
    ],
    `${opts.day}T09:15:00.000Z`,
  );
  ledger.append(
    [
      "judge",
      "verdict",
      `review round 1: passed; 0 blocking (0 suggestions) · 600 tokens · $${opts.judgeCost.toFixed(2)}`,
    ],
    `${opts.day}T09:20:00.000Z`,
  );
  if (opts.pr !== undefined) {
    ledger.append(
      [
        "ship",
        "timeline",
        `draft PR opened: #${opts.pr} https://github.com/o/r/pull/${opts.pr} · rivetari/${opts.id} at abcdef123456 → main`,
      ],
      `${opts.day}T09:30:00.000Z`,
    );
  }
  ledger.append(
    [
      "close",
      "outcome",
      opts.outcome === "merged"
        ? `PR #${opts.pr} merged · 45 min · 2.6k tokens · $${(opts.buildCost + opts.judgeCost).toFixed(2)}`
        : `abandoned: superseded · 45 min · 2.6k tokens · $${(opts.buildCost + opts.judgeCost).toFixed(2)}`,
    ],
    `${opts.day}T09:45:00.000Z`,
  );
  ledger.append(
    ["close", "timeline", `ledger sealed · ${opts.outcome}`],
    `${opts.day}T09:45:00.000Z`,
  );
}

export function historyRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "rivetari-e2e-history-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "E2E");

  mkdirSync(join(repo, ".rivetari"), { recursive: true });
  writeFileSync(join(repo, ".rivetari", "profile.yml"), PROFILE);
  writeFileSync(
    join(repo, "README.md"),
    "# History Fixture\n\nOverview of the repository.\n",
  );

  writeSealedTask(repo, {
    id: "T-0001",
    title: "Tighten CSP header",
    day: "2026-11-22",
    risk: "low",
    pr: 11,
    outcome: "merged",
    buildCost: 0.9,
    judgeCost: 0.3,
  });
  writeSealedTask(repo, {
    id: "T-0002",
    title: "Experiment abandoned",
    day: "2026-11-23",
    risk: "medium",
    outcome: "abandoned",
    buildCost: 1.5,
    judgeCost: 0.5,
  });

  const historyLines = [
    JSON.stringify({
      date: "2026-11-22",
      score: 0.8,
      byLane: { hygiene: { pass: 4, total: 5 } },
    }),
    JSON.stringify({
      kind: "task",
      date: "2026-11-22",
      task: "T-0001",
      outcome: "merged",
      pr: 11,
      cost_usd: 1.2,
      tokens: 2600,
      build_rounds: 1,
      judge_rounds: 1,
      minutes: 45,
      risk: "low",
      skills: ["diff"],
      rounds: [{ n: 1 }],
      findings: [
        {
          pattern: "missing-csp",
          kind: "blocking",
          title: "Missing CSP directive",
        },
      ],
    }),
    JSON.stringify({
      kind: "task",
      date: "2026-11-23",
      task: "T-0002",
      outcome: "abandoned",
      pr: null,
      cost_usd: 2.0,
      tokens: 2600,
      build_rounds: 2,
      judge_rounds: 1,
      minutes: 45,
      risk: "medium",
      skills: [],
      rounds: [{ n: 1 }, { n: 2, retry: true }],
      findings: [
        {
          pattern: "missing-csp",
          kind: "blocking",
          title: "Missing CSP directive",
        },
      ],
    }),
  ];
  writeFileSync(
    join(repo, ".rivetari", "history.jsonl"),
    `${historyLines.join("\n")}\n`,
  );

  git("add", "-A");
  git("commit", "-m", "fixture", "--no-verify");
  return repo;
}
