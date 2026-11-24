// Playwright's browsers are versioned with the package: a worktree that pins
// @playwright/test 1.65.1 needs chromium build 1255, and an older build in the
// cache doesn't do. The build agent can't install it (ad-hoc package runs are
// denied), so the runtime does, for the version the worktree pins, at isolate
// and again before the proof (the build may have added Playwright). Once that
// build is cached the install is a no-op.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  allowlistedEnv,
  type CommandRunner,
  runTool,
} from "@arynbht/rivetari-engine";
import { parse } from "yaml";

const PACKAGES = ["@playwright/test", "playwright"] as const;

/** A download of the browser is ~120 MB. */
const INSTALL_MS = 10 * 60 * 1000;

const readJson = async (
  path: string,
): Promise<Record<string, unknown> | null> =>
  readFile(path, "utf8")
    .then((t) => JSON.parse(t) as Record<string, unknown>)
    .catch(() => null);

type Deps = Record<string, string | undefined>;

/** The version a lockfile resolved Playwright to, or undefined. */
async function lockedVersion(dir: string): Promise<string | undefined> {
  const npm = await readJson(join(dir, "package-lock.json"));
  if (npm) {
    const packages = (npm.packages ?? {}) as Record<
      string,
      { version?: string }
    >;
    const legacy = (npm.dependencies ?? {}) as Record<
      string,
      { version?: string }
    >;
    for (const name of PACKAGES) {
      const v =
        packages[`node_modules/${name}`]?.version ?? legacy[name]?.version;
      if (v) return v;
    }
  }
  const pnpm = await readFile(join(dir, "pnpm-lock.yaml"), "utf8")
    .then((t) => parse(t) as Record<string, unknown> | null)
    .catch(() => null);
  const root = (
    pnpm?.importers as Record<string, Record<string, unknown>> | undefined
  )?.["."];
  for (const group of ["devDependencies", "dependencies"]) {
    const deps = (root?.[group] ?? {}) as Record<string, { version?: unknown }>;
    for (const name of PACKAGES) {
      const v = deps[name]?.version;
      // pnpm writes peers after the version: 1.65.1(react@19.0.0).
      if (typeof v === "string") return v.replace(/\(.*$/, "");
    }
  }
  return undefined;
}

const SEMVERISH = /^[~^]?\d+(\.\d+){0,2}(-[\w.]+)?$/;

/**
 * The Playwright version the worktree uses: the lockfile's, else the spec in
 * package.json when it's a version or a range. Undefined when it doesn't use
 * Playwright; a `reason` when it does but the version can't be told.
 */
export async function playwrightPin(
  dir: string,
): Promise<
  { version?: string | undefined; reason?: string | undefined } | undefined
> {
  const pkg = await readJson(join(dir, "package.json"));
  if (!pkg) return undefined;
  const deps: Deps = {
    ...((pkg.dependencies ?? {}) as Deps),
    ...((pkg.devDependencies ?? {}) as Deps),
  };
  const name = PACKAGES.find((n) => deps[n] !== undefined);
  if (!name) return undefined;
  const locked = await lockedVersion(dir);
  // Checked like the spec: it becomes an npx package argument.
  if (locked && SEMVERISH.test(locked)) return { version: locked };
  const spec = deps[name]?.trim() ?? "";
  if (SEMVERISH.test(spec)) return { version: spec };
  return {
    reason: `package.json asks for ${name} "${spec}", which isn't a version npx can install`,
  };
}

/**
 * Install the chromium build the worktree's Playwright needs. Returns the
 * ledger line, or null when the worktree doesn't use Playwright. Never
 * throws: a failed install is said plainly, with the command to run by hand.
 */
export async function ensurePlaywrightBrowser(
  dir: string,
  run: CommandRunner = (bin, args, cwd) =>
    runTool(bin, args, cwd, {
      timeoutMs: INSTALL_MS,
      env: allowlistedEnv(["PLAYWRIGHT_BROWSERS_PATH"]),
    }),
): Promise<string | null> {
  const pin = await playwrightPin(dir);
  if (!pin) return null;
  if (!pin.version)
    return `playwright browser not installed: ${pin.reason}; run \`npx playwright install chromium\` in the worktree`;
  const args = ["--yes", `playwright@${pin.version}`, "install", "chromium"];
  const command = `npx ${args.join(" ")}`;
  try {
    const res = await run("npx", args, dir);
    if (res.exitCode === 0)
      return `playwright browser ready: chromium for playwright ${pin.version} (\`${command}\`)`;
    const why = `${res.stderr}\n${res.stdout}`.trim().replace(/\s+/g, " ");
    return `playwright browser not installed: \`${command}\` exited ${res.exitCode}: ${why.slice(-300)}`;
  } catch (err) {
    return `playwright browser not installed: \`${command}\` failed: ${(err as Error).message.replace(/\s+/g, " ").slice(0, 300)}`;
  }
}
