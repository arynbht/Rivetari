// Sign in for UI proof: the profile's `proof.auth.script`, run once the app
// answers and before any screenshot, so pages behind sign-in are shot signed
// in rather than as the login redirect. The script drives a page with the
// runtime's own Playwright (the repo needn't install it), in a child process
// with the allowlisted environment (it's the repo's code), and the signed-in
// browser state is saved as a Playwright storageState file the shots load.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { allowlistedEnv, runTool } from "@arynbht/rivetari-engine";

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

// Runs in the child: argv is [playwright-core entry, script, state file, base URL].
// The browser falls back to an installed Chrome or Edge, as the shots do.
const RUNNER = `
import { pathToFileURL } from "node:url";
const [pw, script, state, baseURL] = process.argv.slice(1);
try {
  const mod = await import(pathToFileURL(pw).href);
  const chromium = mod.chromium ?? mod.default.chromium;
  let browser;
  let first;
  for (const channel of [undefined, "chrome", "msedge"]) {
    try {
      browser = await chromium.launch(channel ? { channel } : {});
      break;
    } catch (err) {
      first ??= err;
    }
  }
  if (!browser) throw new Error("no browser: run \`npx playwright install chromium\` (" + String(first?.message).split("\\n")[0] + ")");
  try {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    const setup = (await import(pathToFileURL(script).href)).default;
    if (typeof setup !== "function") throw new Error("it must export a default function ({ page, context, baseURL })");
    await setup({ page, context, baseURL });
    await context.storageState({ path: state });
  } finally {
    await browser.close();
  }
} catch (err) {
  process.stderr.write(String(err?.message ?? err));
  process.exit(1);
}
`;

// The start of the output: the error's message, before Playwright's call log.
const head = (s: string, n = 600) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * Run the auth script against the served app and check it left a signed-in
 * state in `stateFile`. Throws an {@link AuthError} saying why when the script
 * fails, times out, or saves no cookies or local storage (a sign-in that
 * didn't stick would otherwise shoot the login page as the proof).
 */
export async function signIn(options: {
  /** The module that signs in, relative to `root`. */
  script: string;
  root: string;
  /** Where it runs: the checkout being served. */
  cwd: string;
  baseUrl: string;
  port: number;
  stateFile: string;
  timeoutMs?: number | undefined;
}): Promise<void> {
  const script = resolve(options.root, options.script);
  const timeoutMs = options.timeoutMs ?? 120_000;
  let playwright: string;
  try {
    playwright = createRequire(import.meta.url).resolve("playwright-core");
  } catch {
    throw new AuthError(
      "proof.auth needs playwright-core, which this install of rivetari doesn't have",
    );
  }
  const what = `the auth script ${options.script}`;
  let res: Awaited<ReturnType<typeof runTool>>;
  try {
    res = await runTool(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        RUNNER,
        playwright,
        script,
        options.stateFile,
        options.baseUrl,
      ],
      options.cwd,
      {
        timeoutMs,
        env: {
          // Where Playwright's own Chromium is, when it isn't the default.
          ...allowlistedEnv(["PLAYWRIGHT_BROWSERS_PATH"]),
          PORT: String(options.port),
          URL: options.baseUrl,
        },
      },
    );
  } catch (err) {
    throw new AuthError(
      (err as Error).name === "ToolTimeoutError"
        ? `${what} didn't finish within ${Math.round(timeoutMs / 1000)}s`
        : `${what} couldn't run: ${head((err as Error).message)}`,
    );
  }
  if (res.exitCode !== 0)
    throw new AuthError(
      `${what} failed (exit ${res.exitCode}): ${head(`${res.stdout}\n${res.stderr}`)}`,
    );
  const state = await readFile(options.stateFile, "utf8")
    .then(
      (t) =>
        JSON.parse(t) as {
          cookies?: unknown[];
          origins?: { localStorage?: unknown[] }[];
        },
    )
    .catch(() => null);
  if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins))
    throw new AuthError(`${what} exited 0 but saved no browser state`);
  const stored = state.origins.reduce(
    (n, o) => n + (o.localStorage?.length ?? 0),
    state.cookies.length,
  );
  if (stored === 0)
    throw new AuthError(
      `${what} finished but left no cookies or local storage: it didn't sign in`,
    );
}
