// `node bench/run.mjs --self-check`: the bench's own checks, with no fixture,
// no network and no AI calls. The dry run (`--dry`) checks the fixture side.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  baseFromLedger,
  classifyCall,
  cliEnv,
  decideStop,
  dependencyNames,
  FIXTURE_ENV_EXTRA,
  ledgerUsage,
  npmCi,
  resultOf,
  sumCalls,
  tableRow,
  totalOf,
  usageOf,
  verdictOf,
} from "./lib.mjs";

const BENCH = dirname(fileURLToPath(import.meta.url));

const { allowlistedEnv } = await import(
  pathToFileURL(
    join(BENCH, "..", "packages", "engine", "dist", "detectors", "exec.js"),
  ).href
);

/** The fixture environment run.mjs builds, with these tokens set in ours. */
function fixtureEnvWithTokensSet() {
  const saved = {
    GH_TOKEN: process.env.GH_TOKEN,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  process.env.GH_TOKEN = "ghp_bench_selfcheck";
  process.env.ANTHROPIC_API_KEY = "sk-ant-bench-selfcheck";
  try {
    return allowlistedEnv(FIXTURE_ENV_EXTRA);
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
}

const t0028 = {
  title: "Set up Playwright e2e with coach and athlete sign-in",
  description: "Pin @playwright/test at exactly 1.65.1 (a new dev dependency).",
  constraints: [
    "the only new dependency is @playwright/test at exactly 1.65.1",
  ],
  acceptance: [
    { text: 'package.json gains an "e2e": "playwright test" script' },
  ],
  touches: ["e2e/**", "package.json", "package-lock.json"],
};
const oneline = {
  title: "Spell out the duration column header",
  description: "One header string.",
  constraints: ["no new dependencies"],
  acceptance: [{ text: "header changes" }],
  touches: ["src/lib/domain/csv.ts"],
};

const result = {
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 7,
  duration_ms: 61000,
  total_cost_usd: 0.42,
  usage: {
    input_tokens: 10,
    output_tokens: 2000,
    cache_creation_input_tokens: 30000,
    cache_read_input_tokens: 150000,
  },
  modelUsage: {
    "claude-haiku-5-5": { costUSD: 0.01 },
    "claude-opus-5-5": { costUSD: 0.41 },
  },
};

const checks = {
  "the policy allows a plan budget stop"() {
    const d = decideStop(
      "budget_exhausted: the plan call reached its 4-turn limit before it replied with a plan",
      oneline,
    );
    assert.equal(d.allow, true);
  },
  "the policy allows the card's named dependency, naming it"() {
    const d = decideStop(
      "new_dependency: package.json adds @playwright/test",
      t0028,
    );
    assert.equal(d.allow, true);
    assert.match(d.note, /@playwright\/test/);
  },
  "the policy stops on a dependency the card doesn't name"() {
    assert.equal(
      decideStop("new_dependency: package.json adds left-pad", t0028).allow,
      false,
    );
    assert.equal(
      decideStop("new_dependency: package.json adds @playwright/test", oneline)
        .allow,
      false,
    );
  },
  "the policy allows package.json scripts the card names"() {
    const stop =
      "protected_path: package.json — changes package.json scripts (the commands the checks run)";
    assert.equal(decideStop(stop, t0028).allow, true);
    assert.equal(decideStop(stop, oneline).allow, false);
  },
  "the policy stops on anything else"() {
    for (const s of [
      "schema_change: src/lib/domain/types.ts",
      "protected_path: .github/workflows/ci.yml",
      "agent_question: which port?",
      "timeout: a claude call ran past its limit",
    ])
      assert.equal(decideStop(s, t0028).allow, false, s);
  },
  "dependency names drop versions"() {
    assert.deepEqual(
      dependencyNames("package.json adds @playwright/test@1.65.1 and zod"),
      ["@playwright/test", "zod"],
    );
  },
  "calls are classified by their arguments"() {
    assert.equal(
      classifyCall(
        "-p --output-format stream-json --verbose --safe-mode --allowedTools Read --max-turns 4 --disallowedTools Agent,Task",
      ),
      "plan",
    );
    assert.equal(
      classifyCall(
        "-p --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools Edit",
      ),
      "build",
    );
    assert.equal(
      classifyCall(
        '-p --output-format json --model claude-opus-5-5 --tools ""',
      ),
      "review",
    );
  },
  "a version probe isn't an AI call"() {
    assert.equal(classifyCall("--version"), "probe");
  },
  "usage comes from the stream's result line"() {
    const stream = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: {} }),
      JSON.stringify(result),
      "",
    ].join("\n");
    const u = usageOf(resultOf(stream));
    assert.deepEqual(u.tokens, {
      input: 10,
      output: 2000,
      cacheCreation: 30000,
      cacheRead: 150000,
      total: 182010,
    });
    assert.equal(u.usd, 0.42);
    assert.equal(u.turns, 7);
    assert.deepEqual(u.models, ["claude-opus-5-5", "claude-haiku-5-5"]);
  },
  "a killed call has no usage, and says so"() {
    assert.equal(usageOf(resultOf('{"type":"assistant"}\n{"type":"res')), null);
    const row = sumCalls("build round 1", [{ usage: null }], 30);
    assert.equal(row.unreadCalls, 1);
    assert.equal(row.usd, 0);
  },
  "rows add up"() {
    const call = { usage: usageOf(result) };
    const a = sumCalls("plan", [call], 60.4);
    const b = sumCalls("build round 1", [call, call], 120);
    const t = totalOf([a, b]);
    assert.equal(t.calls, 3);
    assert.equal(t.turns, 21);
    assert.equal(t.tokens.total, 3 * 182010);
    assert.equal(t.usd, 1.26);
    assert.equal(t.seconds, 180);
  },
  "the ledger's usage notes are read"() {
    const entries = [
      {
        seq: 12,
        beat: "build",
        text: "build started · skills spine only · ~13552 prompt tokens · 2 repo file(s) in context · 188684 tokens · $0.31 · 5 turns",
      },
      {
        seq: 41,
        beat: "judge",
        text: "judge review round 1: approve; 0 blocking, 2 suggestion(s) (claude-opus-5-5) · 12420 tokens · $0.12",
      },
      {
        seq: 46,
        beat: "judge",
        section: "timeline",
        text: "judge passed · round 1 · head 77a3ca2258cd · record sha256 e3",
      },
    ];
    const u = ledgerUsage(entries);
    assert.equal(u.length, 2);
    assert.deepEqual([u[0].tokens, u[0].usd, u[0].turns], [188684, 0.31, 5]);
    assert.deepEqual([u[1].tokens, u[1].usd, u[1].turns], [12420, 0.12, null]);
    assert.equal(verdictOf(entries), "passed");
  },
  "the base comes from the pilot's isolate entry"() {
    const lines = [
      JSON.stringify({ beat: "route", text: "route approved" }),
      JSON.stringify({
        beat: "isolate",
        text: "worktree .worktrees/T-0028 · branch chore/t-0028 from origin/main (4190baa70132) · port 5175",
      }),
    ];
    assert.equal(baseFromLedger(lines), "4190baa70132");
  },
  "the cards the bench knows exist and name a base"() {
    const cards = JSON.parse(
      readFileSync(join(BENCH, "cards", "cards.json"), "utf8"),
    );
    for (const name of ["t0028", "t0019", "oneline"]) {
      const c = cards.cards[name];
      assert.ok(c, name);
      assert.match(c.base, /^[0-9a-f]{40}$/);
      assert.ok(
        readFileSync(join(BENCH, "cards", c.file), "utf8").includes(
          "acceptance:",
        ),
      );
    }
  },
  "a results row has every column"() {
    const row = tableRow({
      date: "2026-11-24",
      rivetari: { sha: "6dd1342" },
      card: "oneline",
      outcome: "reached ship (not run)",
      verdict: "passed",
      stops: [],
      buildRounds: 1,
      judgeRounds: 1,
      totals: { turns: 5, tokens: { total: 100 }, usd: 0.1, seconds: 60 },
      committed: { committed: true },
      file: "x.json",
    });
    assert.equal(row.split("|").length - 2, 14);
  },
};

checks["npm ci gets the allowlisted env, never GH_TOKEN or ANTHROPIC_API_KEY"] =
  () => {
    let seen = null;
    npmCi(
      "fixture",
      fixtureEnvWithTokensSet(),
      (cmd, args, opts) => {
        seen = { cmd, args, opts };
      },
      false,
    );
    assert.equal(seen.cmd, "npm");
    assert.equal(seen.args[0], "ci");
    assert.equal(seen.opts.env.GH_TOKEN, undefined);
    assert.equal(seen.opts.env.ANTHROPIC_API_KEY, undefined);
    assert.ok(seen.opts.env.PATH ?? seen.opts.env.Path, "PATH reaches npm");
  };

checks[
  "the CLI's env comes from the same allowlist: no tokens, no CI, the shim first"
] = () => {
  const env = cliEnv(fixtureEnvWithTokensSet(), {
    shim: "SHIM",
    ghConfig: "GH-EMPTY",
    delimiter: ";",
  });
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CI, undefined);
  assert.equal(env.Path, undefined);
  assert.ok(env.PATH.startsWith("SHIM;"));
  assert.equal(env.GH_CONFIG_DIR, "GH-EMPTY");
};

export function selfCheck() {
  let failed = 0;
  for (const [name, fn] of Object.entries(checks)) {
    try {
      fn();
      process.stdout.write(`ok   ${name}\n`);
    } catch (err) {
      failed++;
      process.stdout.write(
        `FAIL ${name}\n     ${err.message.split("\n").join("\n     ")}\n`,
      );
    }
  }
  process.stdout.write(
    `${Object.keys(checks).length - failed}/${Object.keys(checks).length} checks pass\n`,
  );
  return failed === 0 ? 0 : 1;
}
