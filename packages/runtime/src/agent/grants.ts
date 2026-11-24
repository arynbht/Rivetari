// A person's "allowed" to a stop that names commands widens the next build
// round's tool permissions by exactly those commands. Without it the answer
// was recorded and the agent's --allowedTools still refused the command, so
// it asked the same question again. A grant is an exact rule per command,
// never a prefix, and never reaches past the build's deny list.
import { DENIED_BUILD_TOOLS } from "@arynbht/rivetari-engine";

export interface Grants {
  /** The commands as the agent should run them; each is an exact `Bash(...)` rule. */
  commands: string[];
  /** Commands that were named but can't be granted, with why. */
  refused: { command: string; why: string }[];
}

/** A command is named in backticks, the way the agent and the prompt quote them. */
const SPAN = /`([^`\n]+)`/g;
/** `PORT=5178 npm run e2e`: the assignments before the command. */
const ENV = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/;
/** What a program's name looks like: `npm`, `./node_modules/.bin/next`. */
const PROGRAM = /^[\w@./\\:-]+$/;
/**
 * Anything that would let one rule run more than the command it names:
 * chaining, pipes, redirects, substitution, globs, and the characters the
 * tool list and its rule syntax split on.
 */
const UNSAFE = /[;&|<>`$(){}*,\n]|:\*/;
/** The deny list's command prefixes, from its `Bash(<prefix>:*)` rules. */
const DENIED = DENIED_BUILD_TOOLS.flatMap((rule) => {
  const m = /^Bash\((.+):\*\)$/.exec(rule);
  return m?.[1] ? [m[1]] : [];
});
/**
 * npx is npm exec under another name, so a named `npm exec -- x` is granted
 * as `npx x`: the same command, under a name the deny list doesn't carve out.
 */
const NPM_EXEC = /^npm (?:exec|x) (?:-- )?/;
/**
 * Programs that run another command, so a grant for them would vouch for
 * whatever they're handed (`env git push`, `bash -c "…"`).
 */
const WRAPPERS =
  /^(env|command|exec|builtin|eval|nohup|time|timeout|nice|ionice|stdbuf|sudo|doas|runas|xargs|start|sh|bash|zsh|dash|fish|ksh|cmd|powershell|pwsh)$/;

/** `C:\Git\bin\bash.exe` → `bash`. */
const programName = (word: string) =>
  (word.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.(exe|cmd)$/, "");

/**
 * The deny-list prefix a command falls under: its program is the prefix's,
 * and the prefix's other words appear in it in order, wherever options put
 * them (`git -C . push` is `git push`).
 */
function deniedBy(run: string): string | undefined {
  const [program = "", ...rest] = run.split(" ");
  return DENIED.find((prefix) => {
    const [head = "", ...words] = prefix.split(" ");
    if (programName(program) !== head) return false;
    let at = 0;
    for (const w of rest) if (w === words[at]) at++;
    return at === words.length;
  });
}

export const grantRule = (command: string) => `Bash(${command})`;

/** The commands named in `texts` that a person's "allowed" grants. */
export function grantedCommands(texts: readonly string[]): Grants {
  const commands: string[] = [];
  const refused: Grants["refused"] = [];
  for (const text of texts)
    for (const m of text.matchAll(SPAN)) {
      const named = (m[1] ?? "").trim().replace(/\s+/g, " ");
      const env = ENV.exec(named)?.[0] ?? "";
      const bare = named.slice(env.length);
      // A file, a word or code, not a command line: nothing to grant.
      if (
        !bare.includes(" ") ||
        named.length > 200 ||
        !PROGRAM.test(bare.split(" ")[0] ?? "")
      )
        continue;
      if (UNSAFE.test(named)) {
        refused.push({
          command: named,
          why: "it isn't a single plain command (no chaining, pipes, redirects, substitution or globs)",
        });
        continue;
      }
      const command = NPM_EXEC.test(bare)
        ? `${env}npx ${bare.replace(NPM_EXEC, "")}`
        : named;
      const run = command.slice(env.length);
      const wrapper = programName(run.split(" ")[0] ?? "");
      if (WRAPPERS.test(wrapper)) {
        refused.push({
          command: named,
          why: `it runs another command through \`${wrapper}\`; name that command itself`,
        });
        continue;
      }
      const denied = deniedBy(run);
      if (denied) {
        refused.push({
          command: named,
          why: `the build never runs \`${denied}\``,
        });
        continue;
      }
      if (!commands.includes(command)) commands.push(command);
    }
  return {
    commands,
    refused: refused.filter(
      (r, i) => refused.findIndex((o) => o.command === r.command) === i,
    ),
  };
}

/** What the agent is told about its grants, or "" when there are none. */
export function grantNote(grants: Grants): string {
  return [
    grants.commands.length > 0
      ? `a person allowed these commands for this round, and you can run them now; run each exactly as written: ${grants.commands.map((c) => `\`${c}\``).join(", ")}`
      : "",
    ...grants.refused.map(
      (r) => `\`${r.command}\` stays blocked: ${r.why}; don't ask for it again`,
    ),
  ]
    .filter(Boolean)
    .join(". ");
}

/** The ledger's record of the grants, or null when there are none. */
export function grantLine(grants: Grants): string | null {
  const parts = [
    grants.commands.length > 0
      ? `granted for this round: ${grants.commands.map(grantRule).join(", ")}`
      : "",
    grants.refused.length > 0
      ? `not granted: ${grants.refused.map((r) => `\`${r.command}\` (${r.why})`).join(", ")}`
      : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}
