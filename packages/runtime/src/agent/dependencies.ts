// What each ecosystem's manifest or lockfile declares, name to version, so a
// new-dependency stop can name every package it adds and the version it adds
// it at. A person allows the dependencies the stop names, and no others.
import { parse } from "yaml";

/** Package name to the version (or range) declared for it. */
export type Declared = Map<string, string>;

export const NPM_DEPENDENCY_KEYS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** A package.json's dependencies, every section together. */
export function packageJsonDeps(pkg: Record<string, unknown> | null): Declared {
  const out: Declared = new Map();
  for (const key of NPM_DEPENDENCY_KEYS)
    for (const [name, range] of Object.entries(record(pkg?.[key])))
      out.set(name, typeof range === "string" ? range : "*");
  return out;
}

/** What `before` doesn't declare and `after` does, sorted by name. */
export function addedDeps(
  before: Declared,
  after: Declared,
): { name: string; version: string }[] {
  return [...after]
    .filter(([name]) => !before.has(name))
    .map(([name, version]) => ({ name, version }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A lockfile's direct dependencies per workspace package, keyed by the
 * package's directory relative to the lockfile ("." for the root). Only
 * these say what a package asked for; everything else in a lockfile is
 * what those pulled in.
 */
export type Importers = Map<string, Declared>;

function packageLock(text: string): Importers {
  const lock = record(JSON.parse(text));
  const packages = record(lock.packages);
  const out: Importers = new Map();
  for (const [key, value] of Object.entries(packages)) {
    if (key.split("/").includes("node_modules")) continue;
    const dir = key === "" ? "." : key;
    const declared: Declared = new Map();
    for (const section of NPM_DEPENDENCY_KEYS)
      for (const [name, range] of Object.entries(
        record(record(value)[section]),
      )) {
        const installed = record(
          packages[`${key ? `${key}/` : ""}node_modules/${name}`] ??
            packages[`node_modules/${name}`],
        ).version;
        declared.set(
          name,
          typeof installed === "string"
            ? installed
            : typeof range === "string"
              ? range
              : "*",
        );
      }
    out.set(dir, declared);
  }
  return out;
}

function pnpmLock(text: string): Importers {
  const lock = record(parse(text));
  // A lockfile from before workspaces lists the root's dependencies at the top.
  const importers = lock.importers ? record(lock.importers) : { ".": lock };
  const out: Importers = new Map();
  for (const [dir, value] of Object.entries(importers)) {
    const declared: Declared = new Map();
    for (const section of NPM_DEPENDENCY_KEYS)
      for (const [name, spec] of Object.entries(
        record(record(value)[section]),
      )) {
        const version = typeof spec === "string" ? spec : record(spec).version;
        // Peer suffixes, `1.2.3(react@18.3.1)`, aren't part of the version.
        declared.set(
          name,
          typeof version === "string" ? version.replace(/\(.*$/, "") : "*",
        );
      }
    out.set(dir, declared);
  }
  return out;
}

/** Lockfiles whose direct dependencies can be read, by file name. */
export const LOCKFILES: Record<string, (text: string) => Importers> = {
  "package-lock.json": packageLock,
  "pnpm-lock.yaml": pnpmLock,
};

function requirements(text: string): Declared {
  const out: Declared = new Map();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    // Options and includes (-r, -e, --index-url) aren't packages.
    if (!line || line.startsWith("-")) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/.exec(
      line,
    );
    if (!m) continue;
    const name = m[1]!.toLowerCase().replace(/[._]+/g, "-");
    out.set(name, m[2]!.split(";")[0]!.trim() || "any version");
  }
  return out;
}

function goMod(text: string): Declared {
  const out: Declared = new Map();
  let block = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^require\s*\($/.test(line)) {
      block = true;
      continue;
    }
    if (block && line === ")") {
      block = false;
      continue;
    }
    const m = (
      block ? /^(\S+)\s+(\S+)(.*)$/ : /^require\s+(\S+)\s+(\S+)(.*)$/
    ).exec(line);
    if (!m || m[1]!.startsWith("//")) continue;
    out.set(
      m[1]!,
      `${m[2]!}${/\/\/\s*indirect/.test(m[3] ?? "") ? " (indirect)" : ""}`,
    );
  }
  return out;
}

function cargo(text: string): Declared {
  const out: Declared = new Map();
  let section = "";
  let table: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s#.*$/, "").trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1]!.trim();
      // `[dependencies.serde]`: a table for one dependency.
      const one = /^(?:.+\.)?(?:dev-|build-)?dependencies\.([\w-]+)$/.exec(
        section,
      );
      table = one ? one[1]! : null;
      if (table) out.set(table, "*");
      continue;
    }
    if (table) {
      const v = /^version\s*=\s*"([^"]*)"/.exec(line);
      if (v) out.set(table, v[1]!);
      continue;
    }
    if (!/^(?:.+\.)?(?:dev-|build-)?dependencies$/.test(section)) continue;
    const m = /^([\w-]+)(?:\.[\w-]+)?\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2]!;
    const version =
      /^"([^"]*)"/.exec(value)?.[1] ??
      /version\s*=\s*"([^"]*)"/.exec(value)?.[1] ??
      (/workspace\s*=\s*true/.test(value) ? "workspace" : "*");
    out.set(m[1]!, version);
  }
  return out;
}

/** Manifests outside npm whose dependencies can be read, by path. */
export function manifestParser(
  path: string,
): ((text: string) => Declared) | undefined {
  const name = path.split("/").at(-1) ?? "";
  if (/^requirements.*\.txt$/.test(name)) return requirements;
  if (name === "go.mod") return goMod;
  if (name === "Cargo.toml") return cargo;
  return undefined;
}

export const formatDeps = (
  deps: readonly { name: string; version: string }[],
) => deps.map((d) => `${d.name}@${d.version}`).join(", ");
