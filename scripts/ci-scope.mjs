// The packages a pull request's CI has to check, by the same rule as the
// judge's affected-only tier 1 (packages/runtime/src/judge/workspace.ts): the
// packages the diff touches, plus every package that depends on one of them,
// transitively. A path outside every package (root config, the lockfile, CI,
// scripts) can affect anything, so it scopes to everything. Docs never count.
//
//   node scripts/ci-scope.mjs <base-rev>
//
// With no base (a push or a schedule), everything is in scope. The answer goes
// to $GITHUB_OUTPUT when it's set, and to stdout either way.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Keep in step with the `code` filter in .github/workflows/ci-next.yml.
const isDocs = (path) =>
  path.startsWith("docs/") ||
  path.startsWith(".changeset/") ||
  (!path.includes("/") && path.endsWith(".md")) ||
  path.endsWith("/CHANGELOG.md");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function workspacePackages() {
  const manifest = readFileSync("pnpm-workspace.yaml", "utf8");
  const globs = [
    ...manifest.matchAll(/^\s*-\s*["']?([^"'\s]+)["']?\s*$/gm),
  ].map((m) => m[1]);
  // Only `dir/*` globs are read here; anything fancier checks everything.
  if (globs.length === 0 || globs.some((g) => !/^[\w.-]+\/\*$/.test(g)))
    return null;
  const packages = [];
  for (const glob of globs) {
    const parent = glob.slice(0, -2);
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      const dir = `${parent}/${entry.name}`;
      if (!entry.isDirectory() || !existsSync(join(dir, "package.json")))
        continue;
      const pkg = readJson(join(dir, "package.json"));
      packages.push({ dir, name: pkg.name, deps: depsOf(pkg) });
    }
  }
  return packages;
}

function depsOf(pkg) {
  return [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ].flatMap((field) => Object.keys(pkg[field] ?? {}));
}

function scope(base) {
  if (!base) return { all: "no base to diff against" };
  const paths = execFileSync(
    "git",
    // Without renames a moved file lists both ends, so the package it left
    // is in scope too.
    ["diff", "--name-only", "--no-renames", "-z", base, "HEAD"],
    {
      encoding: "utf8",
    },
  )
    .split("\0")
    .filter((p) => p && !isDocs(p));
  if (paths.length === 0) return { dirs: [], touched: [] };
  const packages = workspacePackages();
  if (!packages) return { all: "pnpm-workspace.yaml has globs we don't read" };
  const byDepth = [...packages].sort((a, b) => b.dir.length - a.dir.length);
  const touched = new Set();
  for (const path of paths) {
    const owner = byDepth.find((p) => path.startsWith(`${p.dir}/`));
    if (!owner) return { all: `${path} is outside every workspace package` };
    touched.add(owner);
  }
  const affected = new Set(touched);
  for (let grew = true; grew;) {
    grew = false;
    const names = new Set([...affected].map((p) => p.name));
    for (const p of packages) {
      if (affected.has(p) || !p.deps.some((d) => names.has(d))) continue;
      affected.add(p);
      grew = true;
    }
  }
  const rootDeps = depsOf(readJson("package.json"));
  const rootUses = [...affected].find((p) => rootDeps.includes(p.name));
  if (rootUses) return { all: `the root package depends on ${rootUses.name}` };
  if (affected.size === packages.length)
    return { all: "the change reaches every workspace package" };
  // What the checks build: each affected package and the packages it uses,
  // where the root tsc --build graph has them (tsc follows the references).
  const referenced = new Set(
    (readJson("tsconfig.json").references ?? []).map((r) =>
      r.path.replace(/^\.\//, ""),
    ),
  );
  const byName = new Map(packages.map((p) => [p.name, p]));
  const build = new Set();
  for (const p of affected) {
    for (const q of [p, ...p.deps.flatMap((d) => byName.get(d) ?? [])])
      if (referenced.has(q.dir)) build.add(`${q.dir}/tsconfig.json`);
  }
  return {
    dirs: [...affected].map((p) => p.dir).sort(),
    touched: [...touched].map((p) => p.dir).sort(),
    tsconfigs: [...build].sort(),
  };
}

const result = scope(process.argv[2]);
const all = "all" in result;
const dirs = all ? [] : result.dirs;
const outputs = {
  all: String(all),
  // Nothing to check: the diff is docs only.
  none: String(!all && dirs.length === 0),
  dirs: dirs.join(" "),
  // vitest and eslint take these as path filters.
  paths: dirs.map((d) => `${d}/`).join(" "),
  tsconfigs: all ? "tsconfig.json" : (result.tsconfigs ?? []).join(" "),
  desktop: String(all || dirs.includes("apps/desktop")),
};
console.log(
  all
    ? `checking every package: ${result.all}`
    : dirs.length === 0
      ? "nothing to check: the diff is docs only"
      : `checking ${dirs.join(", ")}: the change touches ${result.touched.join(", ")}`,
);
for (const [key, value] of Object.entries(outputs))
  console.log(`${key}=${value}`);
if (process.env.GITHUB_OUTPUT)
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(outputs)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(""),
  );
