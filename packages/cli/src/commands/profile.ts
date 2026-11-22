import { resolve } from "node:path";

import {
  type Autonomy,
  AUTONOMY_LEVELS,
  type Profile,
} from "@arynbht/factory-catalog";
import {
  loadProfile,
  ProfileError,
  saveProfile,
} from "@arynbht/factory-engine";
import {
  AUTONOMY_DIR,
  setAutonomy,
  TaskError,
  whoami,
} from "@arynbht/factory-runtime";

/** `factory profile show` — print the resolved profile. */
export async function runProfileShow(path: string): Promise<number> {
  const root = resolve(path);
  let profile: Profile | null;
  try {
    profile = await loadProfile(root);
  } catch (err) {
    console.error(err instanceof ProfileError ? err.message : String(err));
    return 1;
  }
  if (!profile) {
    console.error(
      "No .factory/profile.yml found. Run `factory init` to create one.",
    );
    return 1;
  }
  process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
  return 0;
}

/** `factory profile set <key> <value>` — update one field and write it back. */
export async function runProfileSet(
  key: string,
  value: string,
  path: string,
  options: { override?: string | undefined } = {},
): Promise<number> {
  const root = resolve(path);
  if (key === "autonomy")
    return setAutonomyLevel(root, value, options.override);
  if (options.override !== undefined) {
    console.error("--override only applies to `profile set autonomy`.");
    return 1;
  }
  let profile: Profile | null;
  try {
    profile = await loadProfile(root);
  } catch (err) {
    console.error(err instanceof ProfileError ? err.message : String(err));
    return 1;
  }
  if (!profile) {
    console.error(
      "No .factory/profile.yml found. Run `factory init` to create one.",
    );
    return 1;
  }

  const draft: Record<string, unknown> = { ...profile };
  const toBool = (v: string): boolean | null =>
    v === "true" ? true : v === "false" ? false : null;

  if (key === "name" || key === "type" || key === "phase") {
    draft[key] = value;
  } else if (key === "severity-floor") {
    draft[key] = value;
  } else if (key === "stack") {
    draft["stack"] = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (key.startsWith("flags.") || key.startsWith("lanes.")) {
    const flag = toBool(value);
    if (flag === null) {
      console.error(`${key} must be "true" or "false" (got "${value}").`);
      return 1;
    }
    const group = key.startsWith("flags.") ? "flags" : "lanes";
    draft[group] = { ...(profile[group] ?? {}), [key.slice(6)]: flag };
  } else if (key === "quality.no-new-comments") {
    const on = toBool(value);
    if (on === null) {
      console.error(`${key} must be "true" or "false" (got "${value}").`);
      return 1;
    }
    draft["quality"] = { ...(profile.quality ?? {}), "no-new-comments": on };
  } else {
    console.error(
      `Unknown profile key "${key}". Try: name, type, phase, severity-floor, autonomy, stack, flags.<flag>, lanes.<lane>, quality.no-new-comments.`,
    );
    return 1;
  }

  try {
    await saveProfile(root, draft);
  } catch (err) {
    console.error(err instanceof ProfileError ? err.message : String(err));
    return 1;
  }
  process.stdout.write(`Set ${key} = ${value}\n`);
  return 0;
}

async function setAutonomyLevel(
  root: string,
  value: string,
  override: string | undefined,
): Promise<number> {
  if (!(AUTONOMY_LEVELS as readonly string[]).includes(value)) {
    console.error(
      `autonomy must be one of ${AUTONOMY_LEVELS.join(", ")} (got "${value}").`,
    );
    return 1;
  }
  if (override !== undefined && !override.trim()) {
    console.error("--override needs a reason.");
    return 1;
  }
  try {
    const { state, kind } = await setAutonomy(root, value as Autonomy, {
      by: await whoami(root),
      override,
    });
    process.stdout.write(
      kind === null
        ? `autonomy is already ${value}\n`
        : `Set autonomy = ${value} (${kind}); recorded in ${AUTONOMY_DIR}/ledger.md\n${state.effective !== state.configured ? `but it runs at ${state.effective}: ${state.fallback}\n` : ""}`,
    );
    return 0;
  } catch (err) {
    if (err instanceof TaskError || err instanceof ProfileError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
}
