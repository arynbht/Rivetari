// Stop-and-ask: what the agent's change did that a person has to agree
// to before the task moves on. Found from the committed diff, not the agent's
// account of it, so an agent can't talk its way past one.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { looksLikeSecret } from "@arynbht/factory-engine";
import { OSI_ALLOWED } from "@arynbht/factory-registry";
import picomatch from "picomatch";
import { type SimpleGit, simpleGit } from "simple-git";

import {
  findProtected,
  generatedPaths,
  isTestFile,
  protectedDetail,
  type ProtectedReason,
} from "../judge/protected.js";
import { parseAddedLines, parseNameStatus } from "../judge/tier1.js";
import type { Assembly } from "../router/route.js";

export type StopTrigger =
  | "new_dependency"
  | "schema_change"
  | "protected_path"
  | "sensitive_path"
  | "budget_exhausted"
  | "no_change"
  | "agent_question"
  | "secret"
  | "database_url"
  | "history_rewritten";

export interface Stop {
  trigger: StopTrigger;
  detail: string;
  reason?: ProtectedReason | undefined;
  manifest?: string | undefined;
  packages?: string[] | undefined;
  osi?: boolean | undefined;
}

const DATABASE_URL =
  /DATABASE_URL["']?\s*[:=]\s*["'`]?[a-z][a-z0-9+.-]*:\/\/(?:[^@\s"'`/]*@)?([^\s:/?"'`]+)/i;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

export function remoteDatabaseHost(line: string): string | undefined {
  const host = DATABASE_URL.exec(line)?.[1];
  if (!host || /[${}]/.test(host)) return undefined;
  return LOCAL_HOSTS.has(host.toLowerCase()) ? undefined : host;
}

async function licenseOf(
  worktree: string,
  manifest: string,
  name: string,
): Promise<string | undefined> {
  for (const dir of [join(worktree, dirname(manifest)), worktree]) {
    try {
      const pkg = JSON.parse(
        await readFile(join(dir, "node_modules", name, "package.json"), "utf8"),
      ) as { license?: unknown };
      if (typeof pkg.license === "string") return pkg.license;
      const typed = (pkg.license as { type?: unknown } | undefined)?.type;
      if (typeof typed === "string") return typed;
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function withLicenses(
  worktree: string,
  stop: Stop,
): Promise<Stop> {
  if (stop.trigger !== "new_dependency" || !stop.manifest || !stop.packages)
    return stop;
  const licenses = await Promise.all(
    stop.packages.map(
      async (name) =>
        [name, await licenseOf(worktree, stop.manifest ?? "", name)] as const,
    ),
  );
  const osi = licenses.every(
    ([, license]) =>
      license !== undefined &&
      (OSI_ALLOWED as readonly string[]).includes(license),
  );
  return {
    ...stop,
    osi,
    detail: osi
      ? stop.detail
      : `${stop.detail} (${licenses.map(([n, l]) => `${n}: ${l ?? "license unknown"}`).join(", ")}; not all on the OSI list)`,
  };
}

const DEPENDENCY_KEYS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/** Other ecosystems' manifests: any change to one is a dependency change. */
const OTHER_MANIFESTS = picomatch(
  [
    "**/requirements*.txt",
    "**/pyproject.toml",
    "**/Pipfile",
    "**/go.mod",
    "**/Cargo.toml",
    "**/Gemfile",
    "**/composer.json",
    "**/*.csproj",
    "**/pom.xml",
    "**/build.gradle*",
  ],
  { dot: true },
);

const SCHEMA = picomatch(
  ["**/migrations/**", "**/*.sql", "**/schema.prisma", "**/migrate/**"],
  { dot: true },
);

async function jsonAt(
  git: SimpleGit,
  rev: string,
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await git.show([`${rev}:${path}`])) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

/** Package names a package.json gains between base and head. */
async function addedPackages(
  git: SimpleGit,
  base: string,
  head: string,
  path: string,
): Promise<string[]> {
  const before = (await jsonAt(git, base, path)) ?? {};
  const after = (await jsonAt(git, head, path)) ?? {};
  const names = (pkg: Record<string, unknown>) =>
    new Set(
      DEPENDENCY_KEYS.flatMap((k) =>
        Object.keys((pkg[k] as Record<string, unknown> | undefined) ?? {}),
      ),
    );
  const had = names(before);
  return [...names(after)].filter((n) => !had.has(n)).sort();
}

/**
 * Every stop the change from `base` to `head` (in `worktree`) triggers, given
 * the approved assembly. (The plan's budget is checked before building.)
 */
export async function findStops(
  worktree: string,
  base: string,
  head: string,
  assembly: Assembly,
): Promise<Stop[]> {
  const git = simpleGit(worktree);
  const diff = parseNameStatus(
    await git.raw(["diff", "--name-status", "-M", base, head]),
  );
  const stops: Stop[] = [];
  const asks = new Set<string>(
    assembly.stop_and_ask.flatMap((s) => (typeof s === "string" ? [s] : [])),
  );

  if (asks.has("new_dependency")) {
    for (const entry of diff) {
      if (entry.status === "D") continue;
      if (entry.path.endsWith("package.json")) {
        const added = await addedPackages(git, base, head, entry.path);
        if (added.length > 0)
          stops.push({
            trigger: "new_dependency",
            detail: `${entry.path} adds ${added.join(", ")}`,
            manifest: entry.path,
            packages: added,
          });
      } else if (OTHER_MANIFESTS(entry.path)) {
        stops.push({
          trigger: "new_dependency",
          detail: `${entry.path} changed`,
        });
      }
    }
  }

  if (asks.has("schema_change")) {
    const schema = diff.filter((e) => SCHEMA(e.path)).map((e) => e.path);
    if (schema.length > 0)
      stops.push({
        trigger: "schema_change",
        detail: `touches ${schema.join(", ")}`,
      });
  }

  for (const ask of assembly.stop_and_ask) {
    if (typeof ask === "string") continue;
    const isMatch = picomatch(ask.touches, { dot: true });
    const hit = diff.filter((e) => isMatch(e.path)).map((e) => e.path);
    if (hit.length > 0)
      stops.push({
        trigger: "sensitive_path",
        detail: `touches ${hit.join(", ")}`,
      });
  }

  const added = parseAddedLines(
    await git.raw(["diff", "-U0", "--no-color", base, head]),
  );
  // Scripts are the commands the checks run, in any package of a workspace.
  const scripts = async (rev: string, path: string) =>
    JSON.stringify((await jsonAt(git, rev, path))?.scripts ?? null);
  let scriptsChanged = false;
  for (const entry of diff) {
    if (!entry.path.endsWith("package.json")) continue;
    const before = await scripts(base, entry.oldPath ?? entry.path);
    if (before !== (await scripts(head, entry.path))) scriptsChanged = true;
  }
  // A rebuilt bundle re-adds every minified line it touches, so it matches
  // whatever the old bundle already did, including the suppression pattern
  // bundled into it. A secret or suppression in it came from source, which is
  // checked here too.
  const generated = await generatedPaths(git, [...added.keys()]);
  for (const f of findProtected(diff, added, scriptsChanged, generated)) {
    stops.push({
      trigger: "protected_path",
      detail: protectedDetail(f),
      reason: f.reason,
    });
  }
  for (const [path, lines] of added) {
    if (
      lines.length > 0 &&
      !generated.has(path) &&
      looksLikeSecret(lines.join("\n"), { generic: !isTestFile(path) })
    )
      stops.push({
        trigger: "secret",
        detail: `${path} adds a line that looks like a secret`,
      });
    const host = lines.map(remoteDatabaseHost).find(Boolean);
    if (host)
      stops.push({
        trigger: "database_url",
        detail: `${path} points DATABASE_URL at ${host}, not a local database`,
      });
  }
  return stops;
}
