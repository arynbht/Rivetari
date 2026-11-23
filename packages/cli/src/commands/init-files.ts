// The files `rivetari init` writes into a repo: the contract every agent
// reads (AGENTS.md, with CLAUDE.md pointing at it), the Claude Code hooks, the
// PR template with its Proof section, and a CONSTRAINTS.md seed for the judge.
import { BEATS, PROTECTED } from "@arynbht/rivetari-runtime";

/** What the generated files say about this repo. */
export interface RepoFacts {
  name: string;
  type: string;
  phase?: string | undefined;
  stack: string[];
  flags: string[];
  /** Detected stacks: node, python, go, rust, … */
  stacks: string[];
  /** The repo's own commands, when it declares them. */
  commands: {
    install?: string | undefined;
    lint?: string | undefined;
    typecheck?: string | undefined;
    test?: string | undefined;
  };
  /** Rules moved here from the repo's own CLAUDE.md, headings already nested. */
  houseRules?: string | undefined;
}

const BEAT_LINES: Record<(typeof BEATS)[number], string> = {
  intake:
    "**intake**: a task card with acceptance criteria, each saying how it's verified. A person confirms it.",
  route:
    "**route**: the router picks sectors, at most four skills, the judge's checks and the proof. A person approves the assembly.",
  isolate:
    "**isolate**: a worktree in `.worktrees/<id>` on its own branch from the default branch, with its own port and database.",
  build:
    "**build**: one agent plans, then builds, inside the worktree; it stops and asks on the triggers below.",
  prove: "**prove**: a tool produces the proof; the agent never describes it.",
  judge:
    "**judge**: a clean clone of base plus the change. Deterministic checks first, then a scoped review.",
  ship: "**ship**: a draft PR written from the card, the ledger and the proof.",
  close:
    "**close**: after a person merges, the ledger is sealed, the worktree removed and the metrics row appended.",
};

const code = (s: string) => `\`${s}\``;

export function renderAgentsMd(facts: RepoFacts): string {
  const protectedPaths = [
    ...PROTECTED.rivetariState,
    ...PROTECTED.agentConfig,
    ...PROTECTED.ciConfig,
    ...PROTECTED.lintConfig,
  ];
  const cmds = Object.entries(facts.commands).filter(
    (e): e is [string, string] => Boolean(e[1]),
  );
  return `# AGENTS.md

<!-- Written by \`rivetari init\`. Everything above "This repo" is Rivetari's
contract, the same in every rivetari repo; the "This repo" section is yours to edit.
The judge reads this file from the base branch and blocks a change that breaks it. -->

This repo is built with Rivetari. These rules apply to every agent that
works in it (Claude Code, Codex, Cursor) and to Rivetari's own agents.

## Before anything

Run ${code("rivetari doctor")}. If it fails, do what it says (often
${code("rivetari skills sync")}) before starting work.

## Every task starts with /rivetari

In Claude Code: ${code("/rivetari <what you want>")} or ${code("/rivetari #<issue>")}.
Anywhere else, use the ${code("rivetari task")} commands the skill uses. Don't change
files in this checkout on the default branch: each task gets its own worktree and
branch, and the change reaches the default branch only through a reviewed PR.

## The beats

0. **sync**: ${code("rivetari doctor && rivetari skills sync")}. Machine and skills ready, pinned and verified.
${BEATS.map((b, i) => `${i + 1}. ${BEAT_LINES[b]}`).join("\n")}

The ledger in ${code(".rivetari/tasks/<id>/")} is the record and the resume point:
${code("rivetari task resume <id>")}. Only the runtime writes it.

## Protected paths

A task never edits these. The judge marks any change to them as needing a person:

${protectedPaths.map((p) => `- ${code(p)}`).join("\n")}
- tests that already exist (add new tests instead)
- new ${code("eslint-disable")}, ${code("@ts-ignore")}, ${code("# noqa")} or similar suppressions

## Stop and ask

Pause and ask the person before:

- adding a dependency
- a schema change or a migration
- touching a protected path, or deleting or changing an existing test
- any change to lint config, CI config or ${code(".rivetari/**")}
- going past the plan's step budget
- treating an acceptance criterion as impossible

## Proof and review

- Proof comes from tools: before and after screenshots with axe for UI work, the
  test run for everything else. It is never written up by the agent.
- The judge works on a clean clone. Lint, typecheck and tests run first; a check
  that's red on the base too is reported as pre-existing. Then comes a review where
  only three things block: a defect, a breach of this file, CONSTRAINTS.md or
  DESIGN.md, and an unmet acceptance criterion. Everything else is a suggestion.
- Blocking findings go back to the agent at most twice. After that a person decides.

## People merge

Rivetari opens draft PRs. It never merges, and neither does any agent.

## This repo

- **${facts.name}**: ${facts.type}${facts.phase ? `, phase ${facts.phase}` : ""}
- Stack: ${[...new Set([...facts.stacks, ...facts.stack])].join(", ") || "not detected"}
${facts.flags.length > 0 ? `- Flags: ${facts.flags.join(", ")}\n` : ""}${
    cmds.length > 0
      ? `- Commands: ${cmds.map(([k, v]) => `${k} ${code(v)}`).join(" · ")}\n`
      : "- Commands: none declared yet; the judge fails closed on a check it can't run.\n"
  }
<!-- House patterns, naming, where things live: add them here. The judge holds changes to them. -->
${
  facts.houseRules
    ? `
<!-- Moved here from CLAUDE.md by \`rivetari init\`, so every agent reads them. -->

${facts.houseRules}
`
    : ""
}`;
}

export const CLAUDE_MD = `# CLAUDE.md

@AGENTS.md

Start every task with \`/rivetari\`. The contract above applies to Claude Code too.
`;

/**
 * The rules in a repo's own CLAUDE.md, for AGENTS.md's "This repo" section:
 * everything but the title and the lines that only point at AGENTS.md (any
 * init's), with headings nested two levels down so they sit under "## This
 * repo". Null when nothing is left.
 */
export function houseRulesFrom(claudeMd: string): string | null {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of claudeMd.replace(/\r\n?/g, "\n").split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (fence === null || marker.startsWith(fence))) {
      fence = fence === null ? marker : null;
      kept.push(line);
      continue;
    }
    if (fence === null) {
      if (/^#\s+CLAUDE\.md\s*$/i.test(line)) continue;
      if (/^\s*@AGENTS\.md\s*$/.test(line)) continue;
      if (line.startsWith("Start every task with `/rivetari`")) continue;
      const heading = /^(#{1,6})(\s.*)$/.exec(line);
      if (heading) {
        kept.push(
          `${"#".repeat(Math.min(6, heading[1]!.length + 2))}${heading[2]}`,
        );
        continue;
      }
    }
    kept.push(line);
  }
  const text = kept.join("\n").trim();
  return text || null;
}

/** Claude Code hooks: the beats at session start, and the edit guard. */
// The hooks fail closed. A hook that can't run exits non-blocking, so
// the guard's command turns any failure, `Rivetari` missing from PATH included,
// into exit 2, which blocks the call. The session-start one says why on the
// first line of the session instead of leaving every edit blocked unexplained.
// Both parse the same in sh and cmd.
export const GUARD_COMMAND = "rivetari hook guard || exit 2";
export const GUARD_MATCHER = "Edit|Write|MultiEdit|NotebookEdit|Bash";
export const SESSION_START_COMMAND =
  "rivetari hook session-start || echo rivetari: the session-start hook could not run, so Rivetari CLI is probably not on PATH. Until it is, the guard blocks every edit and command. Install it in a terminal, then run rivetari doctor.";

/** A hook command `rivetari init` installed, this version's or an earlier one's. */
export const isRivetariHook = (command: unknown): boolean =>
  typeof command === "string" &&
  /^rivetari hook (guard|session-start)\b/.test(command);

const RIVETARI_HOOKS = {
  SessionStart: [
    { hooks: [{ type: "command", command: SESSION_START_COMMAND }] },
  ],
  PreToolUse: [
    {
      matcher: GUARD_MATCHER,
      hooks: [{ type: "command", command: GUARD_COMMAND }],
    },
  ],
};

export const SETTINGS_JSON = `${JSON.stringify({ hooks: RIVETARI_HOOKS }, null, 2)}\n`;

interface HookGroup {
  matcher?: string;
  hooks?: { command?: unknown }[];
}

/**
 * `settings` with Rivetari's hooks in it: every other setting and hook
 * kept as it is, and any rivetari hook an earlier `init` wrote replaced by this
 * version's, so a re-run converges. Throws when `settings` isn't an object
 * with an object of hook arrays.
 */
export function mergeRivetariHooks(settings: unknown): Record<string, unknown> {
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObject(settings)) throw new Error("not a JSON object");
  const hooks = settings.hooks ?? {};
  if (!isObject(hooks)) throw new Error("`hooks` is not an object");
  const merged: Record<string, unknown> = { ...hooks };
  for (const [event, ours] of Object.entries(RIVETARI_HOOKS)) {
    const theirs = merged[event] ?? [];
    if (!Array.isArray(theirs))
      throw new Error(`\`hooks.${event}\` is not an array`);
    const kept = (theirs as HookGroup[]).flatMap((group) => {
      if (!Array.isArray(group?.hooks)) return [group];
      const rest = group.hooks.filter((h) => !isRivetariHook(h?.command));
      if (rest.length === group.hooks.length) return [group];
      // A group that held only Rivetari hooks goes; ours replaces it.
      return rest.length > 0 ? [{ ...group, hooks: rest }] : [];
    });
    merged[event] = [...kept, ...ours];
  }
  return { ...settings, hooks: merged };
}

export const PR_TEMPLATE = `## Summary

<!-- What changed and why. Link the issue. -->

## Acceptance criteria

<!-- Each criterion, and whether it's met. -->

## Proof

<!-- Required. Produced by a tool, not described: before/after screenshots for UI,
test output for logic, plan output for infra. Rivetari tasks fill this in. -->

## Notes
`;

export function renderConstraintsMd(facts: RepoFacts): string {
  const checks = [
    facts.commands.lint,
    facts.commands.typecheck,
    facts.commands.test,
  ]
    .filter(Boolean)
    .map((c) => code(c!));
  return `# CONSTRAINTS.md

<!-- Seeded by \`rivetari init\`. The judge's review blocks a change that breaks a rule
here, so keep every rule concrete enough to check against a diff. Add this codebase's
rules below; delete any of these that don't fit. -->

## Always

- ${checks.length > 0 ? `${checks.join(", ")} pass` : "Lint, typecheck and tests pass"}, with no new warnings.
- No new dependency without asking first.
- Nothing silences a check: no new \`eslint-disable\`, \`@ts-ignore\`, \`# noqa\` or skipped tests.
- New behaviour comes with new tests; existing tests aren't changed to make a change pass.
- No secrets, keys or tokens in code, tests, fixtures or logs.
- Errors are handled or passed on with context, never swallowed.

## This codebase

<!-- e.g. "All database access goes through src/db/; nothing else imports the driver." -->
`;
}
