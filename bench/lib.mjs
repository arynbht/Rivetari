// The bench's pure parts: the scripted stop policy, reading the claude CLI's
// usage out of a call's output, and adding calls and ledger notes up per beat.
// run.mjs does the I/O; selfcheck.mjs tests these without a fixture.

/** How many dollars one card may spend before the bench stops it. */
export const DEFAULT_MAX_USD = 8;

/**
 * The scripted stand-in for the person who answers stop-and-ask questions.
 * Each answer is recorded as a human stop. Anything the policy doesn't name
 * stops the run, so the bench never invents a decision.
 */
export function decideStop(stop, card) {
  const text = String(stop);
  const kind = text.split(":")[0].trim();
  const cardText = [
    card.title,
    card.description,
    ...(card.constraints ?? []),
    ...(card.acceptance ?? []).map((a) => a.text),
  ]
    .join("\n")
    .toLowerCase();
  if (kind === "budget_exhausted")
    return {
      allow: true,
      note: "bench policy: the plan budget ran out; allow it to plan again",
    };
  if (kind === "new_dependency") {
    const named = dependencyNames(text);
    const unnamed = named.filter((n) => !cardText.includes(n.toLowerCase()));
    if (named.length > 0 && unnamed.length === 0)
      return {
        allow: true,
        note: `bench policy: the card names this dependency (${named.join(", ")})`,
      };
    return { allow: false, why: `a dependency the card doesn't name: ${text}` };
  }
  if (kind === "protected_path") {
    const touchesPackageJson = (card.touches ?? []).some(
      (t) => t === "package.json",
    );
    const scripts = /package\.json/.test(text) && /\bscripts?\b/.test(text);
    if (scripts && touchesPackageJson && /\bscripts?\b/.test(cardText))
      return {
        allow: true,
        note: "bench policy: package.json scripts the card names",
      };
    return {
      allow: false,
      why: `a protected path the policy doesn't cover: ${text}`,
    };
  }
  return { allow: false, why: text };
}

/** Package names a new_dependency stop names: "package.json adds a, b". */
export function dependencyNames(text) {
  const m = /\badds?\s+(.+)$/i.exec(text);
  if (!m) return [];
  return m[1]
    .split(/,|\band\b/)
    .map((s) => s.trim().split(/\s+/)[0] ?? "")
    .map((s) => s.replace(/[.;:)]+$/, "").replace(/@[\^~]?\d[\w.-]*$/, ""))
    .filter((s) => /^(@[\w.-]+\/)?[\w.-]+$/.test(s));
}

/** The CLI's final result object in a call's stdout (json or stream-json), or null. */
export function resultOf(stdout) {
  const lines = String(stdout)
    .split(/\r?\n/)
    .filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(lines[i]);
      if (j && j.type === "result") return j;
    } catch {
      // A partial line from a killed call: keep looking upwards.
    }
  }
  try {
    const j = JSON.parse(String(stdout));
    if (j && (j.type === "result" || "usage" in j)) return j;
  } catch {
    // Not one JSON document either.
  }
  return null;
}

/**
 * What kind of call the runtime made, from its arguments: the build agent's
 * plan call is read-only with a turn cap, its build call edits, and the
 * judge's review goes through the engine's json transport.
 */
export function classifyCall(args) {
  const a = String(args);
  // doctor asks for `claude --version`: a probe, not an AI call.
  if (/^\s*(--version|-v)\s*$/.test(a)) return "probe";
  if (a.includes("--permission-mode acceptEdits")) return "build";
  if (a.includes("stream-json") && a.includes("--max-turns")) return "plan";
  if (a.includes("stream-json")) return "agent";
  if (/--output-format\s+json\b/.test(a)) return "review";
  return "other";
}

const ZERO = () => ({
  input: 0,
  output: 0,
  cacheCreation: 0,
  cacheRead: 0,
  total: 0,
});

/** One call's usage as the CLI reported it; null fields when it didn't. */
export function usageOf(result) {
  if (!result) return null;
  const u = result.usage ?? {};
  const tokens = {
    input: Number(u.input_tokens ?? 0),
    output: Number(u.output_tokens ?? 0),
    cacheCreation: Number(u.cache_creation_input_tokens ?? 0),
    cacheRead: Number(u.cache_read_input_tokens ?? 0),
  };
  tokens.total =
    tokens.input + tokens.output + tokens.cacheCreation + tokens.cacheRead;
  const models = Object.entries(result.modelUsage ?? {})
    .map(([model, m]) => ({ model, usd: Number(m.costUSD ?? 0) }))
    .sort((x, y) => y.usd - x.usd)
    .map((m) => m.model);
  return {
    tokens,
    usd:
      typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
    turns: typeof result.num_turns === "number" ? result.num_turns : null,
    models,
    subtype: result.subtype ?? null,
    isError: result.is_error === true,
    durationMs:
      typeof result.duration_ms === "number" ? result.duration_ms : null,
  };
}

/** Add calls into one beat row. */
export function sumCalls(beat, calls, seconds) {
  const tokens = ZERO();
  let usd = 0;
  let turns = 0;
  const models = new Set();
  let unread = 0;
  for (const c of calls) {
    if (!c.usage) {
      unread++;
      continue;
    }
    for (const k of Object.keys(tokens)) tokens[k] += c.usage.tokens[k];
    usd += c.usage.usd ?? 0;
    turns += c.usage.turns ?? 0;
    for (const m of c.usage.models) models.add(m);
  }
  return {
    beat,
    calls: calls.length,
    turns,
    tokens,
    usd: Math.round(usd * 10000) / 10000,
    seconds: Math.round(seconds),
    models: [...models],
    ...(unread > 0 ? { unreadCalls: unread } : {}),
  };
}

/** Totals over beat rows. */
export function totalOf(rows) {
  const tokens = ZERO();
  let usd = 0;
  let turns = 0;
  let seconds = 0;
  let calls = 0;
  for (const r of rows) {
    for (const k of Object.keys(tokens)) tokens[k] += r.tokens[k];
    usd += r.usd;
    turns += r.turns;
    seconds += r.seconds;
    calls += r.calls;
  }
  return {
    calls,
    turns,
    tokens,
    usd: Math.round(usd * 10000) / 10000,
    seconds: Math.round(seconds),
  };
}

/** " · 12345 tokens · $0.42 · 7 turns" notes the runtime writes on the ledger. */
export function ledgerUsage(entries) {
  const out = [];
  const re = /· (\d+) tokens · \$(\d+(?:\.\d+)?)(?: · (\d+) turns)?/;
  for (const e of entries) {
    const m = re.exec(e.text ?? "");
    if (!m) continue;
    out.push({
      seq: e.seq,
      beat: e.beat,
      tokens: Number(m[1]),
      usd: Number(m[2]),
      turns: m[3] ? Number(m[3]) : null,
      text: String(e.text).slice(0, 160),
    });
  }
  return out;
}

/** The judge's last verdict on the timeline, or null. */
export function verdictOf(entries) {
  let verdict = null;
  for (const e of entries) {
    const m = /^judge (passed|failed|needs a human) · round (\d+)/.exec(
      e.text ?? "",
    );
    if (e.beat === "judge" && e.section === "timeline" && m) verdict = m[1];
  }
  return verdict;
}

/** The base commit the pilot's isolate entry names ("from origin/main (sha)"). */
export function baseFromLedger(lines) {
  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.beat !== "isolate") continue;
    const m = /\bfrom \S+ \(([0-9a-f]{7,40})\)/.exec(e.text ?? "");
    if (m) return m[1];
  }
  return null;
}

/** A row for bench/results/README.md. */
export function tableRow(r) {
  const t = r.totals;
  const cell = (v, max = 90) => {
    if (v === null || v === undefined) return "—";
    const s = String(v).replace(/\|/g, "\\|").replace(/\s+/g, " ");
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  };
  return `| ${r.date} | ${r.rivetari.sha} | ${r.card} | ${cell(r.outcome)} | ${cell(r.verdict)} | ${r.stops.length} | ${r.buildRounds} | ${r.judgeRounds} | ${t.turns} | ${t.tokens.total} | ${t.usd.toFixed(2)} | ${t.seconds} | ${cell(r.committed?.committed)} | [json](${r.file}) |`;
}

export const TABLE_HEAD = [
  "| date | rivetari | card | outcome | verdict | stops | build rounds | judge rounds | turns | tokens | $ | wall s | committed | result |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
];

/** What the fixture environment keeps beyond the runtime's allowlist. */
export const FIXTURE_ENV_EXTRA = ["npm_config_cache"];

/**
 * `npm ci` in the fixture. It runs the fixture's install scripts, someone
 * else's code, so it gets `env` (the runtime's allowlist), never ours.
 */
export function npmCi(repo, env, run, win) {
  return run("npm", ["ci", "--no-audit", "--no-fund", "--prefer-offline"], {
    cwd: repo,
    shell: win,
    env,
  });
}

/**
 * The CLI's environment: the same allowlisted base `npm ci` gets, plus the
 * claude shim first on PATH and an empty gh config, so no GitHub token
 * reaches Rivetari either. CI is dropped: the allowlist sets it for
 * installs, and Rivetari behaves differently under CI.
 */
export function cliEnv(base, { shim, ghConfig, delimiter }) {
  const env = {
    ...base,
    PATH: `${shim}${delimiter}${base.PATH ?? base.Path ?? ""}`,
    GH_CONFIG_DIR: ghConfig,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    LEFTHOOK: "0",
  };
  delete env.CI;
  // Windows spells it Path as well; one PATH, with the shim first, is unambiguous.
  delete env.Path;
  return env;
}
