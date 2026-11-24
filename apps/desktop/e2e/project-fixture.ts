import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Ledger } from "./now-fixture";
import { RECORDED } from "./posture-fixture";

// A repo for the Project tab whose profile has fallen behind it: profile.yml
// declares no stack while package.json shows node and typescript, the phase
// is scaffold while the recorded audit puts the repo at build, and uses-ai
// isn't set though package.json depends on openai. The skills lock pins two
// always-on skills and a per-task one, and the last sync installed only one
// of the two (the gap); a task's route found no skill for motion. There's an
// autonomy ledger with one override, banned patterns, and a proof block with
// a sign-in script. It's a git repo so a draft can reserve an id on the
// tasks branch.

export const WHO = "e2e@example.com";

const sha256 = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");

export const PROFILE = [
  "version: 1",
  "name: project-repo",
  "type: web-app",
  "stack: []",
  "flags:",
  "  has-users: true",
  "phase: scaffold",
  "severity-floor: low",
  "autonomy: review-at-pr",
  "proof:",
  "  start: npm run dev",
  "  ready_timeout: 120",
  "  auth:",
  "    script: e2e/sign-in.mjs",
  "",
].join("\n");

export const BANNED = {
  version: 1,
  patterns: [
    {
      id: "no-moment",
      pattern: "from ['\"]moment['\"]",
      files: "src/**/*.ts",
      allow: [],
      why: "moment is retired here; use date-fns",
      source: "judge finding T-0004",
    },
    {
      id: "no-eval",
      pattern: "(?<![\\w.$])eval\\s*\\(",
      files: "**/*.{js,ts}",
      allow: [],
      why: "eval runs a string as code",
      source: "stack default: node",
    },
  ],
};

const PIN = "a".repeat(40);
const SKILL_MD = "# ui-kit\n\nBuild UI from the kit.\n";
// The registry's skill hash: each file's path, a NUL, then its bytes.
const UI_KIT_HASH = `sha256:${sha256(Buffer.from(`SKILL.md\0${SKILL_MD}`))}`;

const LOCK = [
  "# Pinned skills for this repo. Edit with `rivetari skills add|update`.",
  "version: 1",
  "skills:",
  `  - name: api-docs`,
  `    source: acme/skills/api-docs`,
  `    pin: "${PIN}"`,
  `    hash: "sha256:${"b".repeat(64)}"`,
  `    scope: always`,
  `  - name: motion-kit`,
  `    source: acme/skills/motion-kit`,
  `    pin: "${PIN}"`,
  `    hash: "sha256:${"c".repeat(64)}"`,
  `    scope: task`,
  `  - name: ui-kit`,
  `    source: acme/skills/ui-kit`,
  `    pin: "${PIN}"`,
  `    hash: "${UI_KIT_HASH}"`,
  `    scope: always`,
  "",
].join("\n");

const ASSEMBLY = [
  "task: T-0001",
  "sectors: [ui, motion]",
  "phases: [build]",
  "skills: [ui-kit]",
  "spine: []",
  "budget: { skill_tokens: 900, context_tokens: 4000, steps: 30 }",
  "checks: [quality.lint.clean]",
  "proof: ui-screenshots",
  "review: { rubric: default, design_pass: true, security: false }",
  "stop_and_ask: [new_dependency]",
  'gaps: ["motion: no vendored skill covers it; the agent works from the spine"]',
  "",
].join("\n");

const CARD = [
  "id: T-0001",
  "title: Animate the cart drawer",
  "type: feature",
  "source: prompt",
  "description: Animate the cart drawer so it slides in.",
  "acceptance:",
  "  - id: A1",
  "    text: The drawer slides in",
  "    verify: e2e",
  "out_of_scope: []",
  "touches: []",
  "pages: []",
  "constraints: []",
  "risk: medium",
  "owner: ann@example.com",
  "created: 2026-11-21",
  "",
].join("\n");

export function projectRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "rivetari-e2e-project-"));
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), text);
  };
  write("README.md", "# project fixture\n");
  write(
    "package.json",
    JSON.stringify(
      {
        name: "project-repo",
        private: true,
        scripts: { dev: "vite" },
        dependencies: { react: "19.0.0", openai: "4.0.0" },
        devDependencies: { typescript: "5.6.0", vite: "6.0.0" },
      },
      null,
      2,
    ),
  );
  write("package-lock.json", "{}\n");
  write(".rivetari/profile.yml", PROFILE);
  write(
    ".rivetari/state.json",
    JSON.stringify({
      version: 1,
      generatedAt: "2026-11-23T09:00:00.000Z",
      summary: {
        pass: 2,
        fail: 3,
        needsEvidence: 1,
        waived: 1,
        skip: 0,
        na: 1,
        total: 8,
      },
      controls: RECORDED,
    }),
  );
  write(".rivetari/banned.json", `${JSON.stringify(BANNED, null, 2)}\n`);
  write(".rivetari/skills.lock", LOCK);
  write(".agents/skills/ui-kit/SKILL.md", SKILL_MD);
  write(
    ".rivetari/skills.state.json",
    JSON.stringify({
      syncedAt: "2026-11-22T10:00:00.000Z",
      lock: sha256(LOCK),
      skills: [
        {
          name: "ui-kit",
          pin: PIN,
          hash: UI_KIT_HASH,
          scope: "always",
          installed: true,
          from: "cache",
        },
        {
          name: "motion-kit",
          pin: PIN,
          hash: `sha256:${"c".repeat(64)}`,
          scope: "task",
          installed: false,
          from: "cache",
        },
      ],
      blocked: [],
    }),
  );

  // A task routed with a gap, waiting for its route to be approved.
  const taskDir = join(repo, ".rivetari", "tasks", "T-0001");
  write(".rivetari/tasks/T-0001/card.yml", CARD);
  write(".rivetari/tasks/T-0001/assembly.yml", ASSEMBLY);
  const task = new Ledger(taskDir, "2026-11-21");
  for (const entry of [
    [
      "intake",
      "timeline",
      "card drafted with 1 acceptance criteria; awaiting confirmation",
    ],
    ["intake", "timeline", `intake confirmed; card sha256 ${sha256(CARD)}`],
    ["route", "decision", "routed to ui, motion: ui (path src/cart/**)"],
    [
      "route",
      "decision",
      "motion: no vendored skill covers it; the agent works from the spine",
    ],
    [
      "route",
      "timeline",
      `assembly proposed; sha256 ${sha256(ASSEMBLY)}; skills ui-kit; proof ui-screenshots; awaiting approval`,
    ],
  ] as [string, string, string][])
    task.append(entry);

  // The autonomy ledger, as `rivetari autonomy review-at-pr --override` writes it.
  const autonomyDir = join(repo, ".rivetari", "autonomy");
  mkdirSync(autonomyDir, { recursive: true });
  new Ledger(autonomyDir, "2026-11-10").append([
    "route",
    "decision",
    "autonomy review-at-pr · override · rules 14 · reason: trial on the docs site",
  ]);

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", WHO);
  git("config", "user.name", "E2E");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return repo;
}
