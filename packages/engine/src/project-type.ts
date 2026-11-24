// The project type a repo's root manifests point at. `rivetari init --yes`
// takes it when --type isn't given, so a fresh repo needs no flag, and the
// desktop's Project view holds it against the type profile.yml declares, so
// both read the repo the same way.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Dependencies that make a Node package an app that serves pages. */
const WEB_DEPS = [
  "next",
  "react",
  "react-dom",
  "vue",
  "nuxt",
  "svelte",
  "@sveltejs/kit",
  "vite",
  "@angular/core",
  "astro",
  "@remix-run/react",
  "solid-js",
];

const readIfThere = (path: string): Promise<string | null> =>
  readFile(path, "utf8").catch(() => null);

interface Pkg {
  bin?: unknown;
  main?: unknown;
  module?: unknown;
  exports?: unknown;
  workspaces?: unknown;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

/** The type a package.json implies, or null when it doesn't say. */
function nodeType(pkg: Pkg, pnpmWorkspace: boolean): string | null {
  if (pnpmWorkspace || pkg.workspaces) return "monorepo";
  // A CLI can render with React (Ink), so `bin` is read first.
  if (pkg.bin) return "cli";
  const has = (deps: Record<string, unknown> | undefined) =>
    WEB_DEPS.some((d) => deps && typeof deps === "object" && d in deps);
  const library = Boolean(pkg.main || pkg.module || pkg.exports);
  if (has(pkg.dependencies)) return "web-app";
  // A component library builds with its framework but doesn't depend on it.
  if (has(pkg.devDependencies)) return library ? "library" : "web-app";
  return library ? "library" : null;
}

/** The type the Python manifests imply, or null. */
function pythonType(manifests: string): string | null {
  const names = manifests.toLowerCase();
  const mentions = (dep: string) =>
    new RegExp(`(^|[^a-z0-9_-])${dep}([^a-z0-9_-]|$)`, "m").test(names);
  if (mentions("django")) return "web-app";
  if (mentions("fastapi") || mentions("flask")) return "api";
  return null;
}

/**
 * The project type the repo's root manifests point at: a pnpm or yarn
 * workspace is a monorepo; a package.json with `bin` a cli; one that depends
 * on a web framework a web-app; one with main/exports and no framework a
 * library; Django a web-app and FastAPI or Flask an api. Null when none of
 * these fits, and init asks for --type.
 */
export async function inferProjectType(root: string): Promise<string | null> {
  const at = (rel: string) => resolve(root, rel);
  const pkgText = await readIfThere(at("package.json"));
  if (pkgText !== null) {
    let pkg: Pkg | null = null;
    try {
      const parsed: unknown = JSON.parse(pkgText);
      if (parsed && typeof parsed === "object") pkg = parsed as Pkg;
    } catch {
      // A package.json that won't parse says nothing about the type.
    }
    const pnpmWorkspace =
      (await readIfThere(at("pnpm-workspace.yaml"))) !== null;
    const type = pkg ? nodeType(pkg, pnpmWorkspace) : null;
    if (type) return type;
  }
  const python = (
    await Promise.all(
      [
        "pyproject.toml",
        "requirements.txt",
        "setup.py",
        "setup.cfg",
        "Pipfile",
      ].map((f) => readIfThere(at(f))),
    )
  )
    .filter((t): t is string => t !== null)
    .join("\n");
  return python ? pythonType(python) : null;
}
