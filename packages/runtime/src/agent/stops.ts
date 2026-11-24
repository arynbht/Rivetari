// Stop-and-ask: what the agent's change did that a person has to agree
// to before the task moves on. Found from the committed diff, not the agent's
// account of it, so an agent can't talk its way past one.
import { readFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";

import { looksLikeSecret } from "@arynbht/rivetari-engine";
import { OSI_ALLOWED } from "@arynbht/rivetari-registry";
import picomatch from "picomatch";
import { type SimpleGit, simpleGit } from "simple-git";

import {
  type DiffEntry,
  findProtected,
  isTestFile,
  protectedDetail,
  type ProtectedReason,
} from "../judge/protected.js";
import {
  parseAddedLines,
  parseHunks,
  parseNameStatus,
} from "../judge/tier1.js";
import { generatedPaths } from "../judge/tier2.js";
import type { Assembly } from "../router/route.js";
import { CONTRACT_DEFAULTS, contractChange } from "./contracts.js";
import {
  addedDeps,
  formatDeps,
  LOCKFILES,
  manifestParser,
  packageJsonDeps,
} from "./dependencies.js";

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
  | "history_rewritten"
  | "timeout"
  // Asked by the judge, not found in the diff: at review-at-pr and above a
  // criterion the reviewer couldn't confirm from the evidence goes to a person.
  | "unverified_acceptance";

export interface Stop {
  trigger: StopTrigger;
  detail: string;
  reason?: ProtectedReason | undefined;
  manifest?: string | undefined;
  packages?: string[] | undefined;
  osi?: boolean | undefined;
  /**
   * A schema change that only adds optional fields or new types: nothing that
   * read the old shape breaks, so autonomy may flag it instead of asking.
   */
  additive?: boolean | undefined;
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

async function textAt(
  git: SimpleGit,
  rev: string,
  path: string,
): Promise<string | null> {
  try {
    return await git.show([`${rev}:${path}`]);
  } catch {
    return null;
  }
}

async function jsonAt(
  git: SimpleGit,
  rev: string,
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse((await textAt(git, rev, path)) ?? "") as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

const EMPTY_LOCK = (): Map<string, Map<string, string>> => new Map();

/**
 * The new-dependency stops in a diff: one per manifest, naming each package
 * it adds and the version, so the allow a person gives covers exactly those.
 * A lockfile that gains a direct dependency no package.json declares is one
 * too: the dependency is installed all the same.
 */
async function dependencyStops(
  git: SimpleGit,
  base: string,
  head: string,
  diff: readonly DiffEntry[],
): Promise<Stop[]> {
  const stops: Stop[] = [];
  for (const entry of diff) {
    if (entry.status === "D") continue;
    const was = entry.oldPath ?? entry.path;
    const lockfile = LOCKFILES[posix.basename(entry.path)];
    if (entry.path.endsWith("package.json")) {
      const added = addedDeps(
        packageJsonDeps(await jsonAt(git, base, was)),
        packageJsonDeps(await jsonAt(git, head, entry.path)),
      );
      if (added.length > 0)
        stops.push({
          trigger: "new_dependency",
          detail: `${entry.path} adds ${formatDeps(added)}`,
          manifest: entry.path,
          packages: added.map((d) => d.name),
        });
    } else if (lockfile) {
      const read = async (rev: string, path: string) => {
        const text = await textAt(git, rev, path);
        try {
          return text === null ? EMPTY_LOCK() : lockfile(text);
        } catch {
          return null;
        }
      };
      const before = (await read(base, was)) ?? EMPTY_LOCK();
      const after = await read(head, entry.path);
      // A lockfile that can't be read can't show it adds nothing.
      if (after === null) {
        stops.push({
          trigger: "new_dependency",
          detail: `${entry.path} changed, and couldn't be read`,
        });
        continue;
      }
      const dir = posix.dirname(entry.path);
      const added: { name: string; version: string }[] = [];
      for (const [importer, declared] of after) {
        // What a package.json declares is its own stop's to name, or not new.
        const manifest = posix.join(dir, importer, "package.json");
        const own = packageJsonDeps(await jsonAt(git, head, manifest));
        added.push(
          ...addedDeps(before.get(importer) ?? new Map(), declared).filter(
            (d) => !own.has(d.name),
          ),
        );
      }
      if (added.length > 0)
        stops.push({
          trigger: "new_dependency",
          detail: `${entry.path} adds ${formatDeps(added)}, which no package.json declares`,
          manifest: entry.path,
          packages: added.map((d) => d.name),
        });
    } else if (OTHER_MANIFESTS(entry.path)) {
      const parse = manifestParser(entry.path);
      const added = parse
        ? addedDeps(
            parse((await textAt(git, base, was)) ?? ""),
            parse((await textAt(git, head, entry.path)) ?? ""),
          )
        : [];
      stops.push({
        trigger: "new_dependency",
        detail:
          added.length > 0
            ? `${entry.path} adds ${formatDeps(added)}`
            : `${entry.path} changed`,
      });
    }
  }
  return stops;
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
  options: {
    /** The profile's own contract files, on top of `CONTRACT_DEFAULTS`. */
    contracts?: readonly string[] | undefined;
  } = {},
): Promise<Stop[]> {
  const git = simpleGit(worktree);
  const diff = parseNameStatus(
    await git.raw(["diff", "--name-status", "-M", base, head]),
  );
  const stops: Stop[] = [];
  const asks = new Set<string>(
    assembly.stop_and_ask.flatMap((s) => (typeof s === "string" ? [s] : [])),
  );

  if (asks.has("new_dependency"))
    stops.push(...(await dependencyStops(git, base, head, diff)));

  const unified = await git.raw(["diff", "-U0", "--no-color", base, head]);
  if (asks.has("schema_change")) {
    const isContract = picomatch(
      [...CONTRACT_DEFAULTS, ...(options.contracts ?? [])],
      { dot: true },
    );
    const hunks = parseHunks(unified);
    const changes = await Promise.all(
      diff
        .filter((e) => [e.path, e.oldPath].some((p) => p && isContract(p)))
        .map(async (e) =>
          contractChange(
            e,
            hunks.get(e.path) ?? [],
            (await textAt(git, head, e.path)) ?? undefined,
          ),
        ),
    );
    if (changes.length > 0) {
      const breaking = changes.flatMap((c) =>
        c.breaking.map((why) => `${c.path} ${why}`),
      );
      const more =
        breaking.length > 3 ? `; and ${breaking.length - 3} more` : "";
      stops.push({
        trigger: "schema_change",
        detail: `touches ${changes.map((c) => c.path).join(", ")}${
          breaking.length > 0
            ? ` — ${breaking.slice(0, 3).join("; ")}${more}`
            : ""
        }`,
        additive: breaking.length === 0,
      });
    }
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

  const added = parseAddedLines(unified);
  // Scripts are the commands the checks run, in any package of a workspace.
  const scripts = async (rev: string, path: string) =>
    JSON.stringify((await jsonAt(git, rev, path))?.scripts ?? null);
  let scriptsChanged = false;
  for (const entry of diff) {
    if (!entry.path.endsWith("package.json")) continue;
    const before = await scripts(base, entry.oldPath ?? entry.path);
    if (before !== (await scripts(head, entry.path))) scriptsChanged = true;
  }
  const generated = await generatedPaths(git, [...added.keys()]);
  for (const f of findProtected(diff, added, scriptsChanged, generated)) {
    stops.push({
      trigger: "protected_path",
      detail: protectedDetail(f),
      reason: f.reason,
    });
  }
  // A rebuilt bundle re-adds every minified line it touches, so it matches
  // whatever the old bundle already did. A secret in it came from source,
  // which is checked here too.
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
