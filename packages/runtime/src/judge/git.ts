// Every git call the judge makes goes through judgeGit. For a task's repo it
// is plain simple-git. Inside a folder the judge eval registered, where the
// repo was built from a case's files, every call gets the eval's scratch
// environment instead: the allowlist, no system or global config, hooks
// pointed at an empty directory and no fsmonitor.
import { resolve, sep } from "node:path";

import { allowlistedEnv } from "@arynbht/rivetari-engine";
import { type SimpleGit, type SimpleGitOptions, simpleGit } from "simple-git";

const samePath = (p: string) =>
  process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p);

const scratch = new Map<string, NodeJS.ProcessEnv>();

/** The environment git gets inside a scratch folder. */
export function scratchGitEnv(
  noHooks: string,
  emptyConfig: string,
): NodeJS.ProcessEnv {
  return {
    ...allowlistedEnv(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: noHooks,
    GIT_CONFIG_KEY_1: "core.fsmonitor",
    GIT_CONFIG_VALUE_1: "false",
  };
}

/**
 * Registers `root` as a scratch folder: until the returned release runs,
 * every judgeGit call on a path inside it uses `env`. Registering a folder
 * that already is one changes nothing and returns a release that does
 * nothing, so the registration that came first keeps it.
 */
export function useScratchGit(
  root: string,
  env: NodeJS.ProcessEnv,
): () => void {
  const key = samePath(root);
  if (scratch.has(key)) return () => undefined;
  scratch.set(key, env);
  return () => {
    scratch.delete(key);
  };
}

/** The scratch environment for the first path inside a registered folder. */
export function scratchEnvFor(
  paths: readonly string[],
): NodeJS.ProcessEnv | null {
  for (const p of paths) {
    const at = samePath(p);
    for (const [root, env] of scratch)
      if (at === root || at.startsWith(root + sep)) return env;
  }
  return null;
}

/**
 * simple-git for the judge. `scope` names the other paths a call touches
 * (a clone's source and destination) when its base directory doesn't.
 */
export function judgeGit(
  baseDir?: string,
  options: Partial<SimpleGitOptions> = {},
  scope: readonly string[] = [],
): SimpleGit {
  const env = scratchEnvFor([baseDir ?? process.cwd(), ...scope]);
  if (!env)
    return baseDir === undefined
      ? simpleGit(options)
      : simpleGit(baseDir, options);
  // simple-git refuses config paths, counts, hooks and fsmonitor in the
  // environment unless asked; these are ours, and they keep a case's own
  // config and the caller's out.
  return simpleGit({
    ...options,
    baseDir: baseDir ?? process.cwd(),
    allowEnvironment: [
      ...(options.allowEnvironment ?? []),
      ...Object.keys(env).filter((k) => k.startsWith("GIT_")),
    ],
    unsafe: {
      ...options.unsafe,
      allowUnsafeConfigPaths: true,
      allowUnsafeConfigEnvCount: true,
      allowUnsafeHooksPath: true,
      allowUnsafeFsMonitor: true,
    },
  }).env(env);
}
