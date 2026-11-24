import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { type Profile, ProfileSchema } from "@arynbht/rivetari-catalog";
import {
  parse as parseYaml,
  parseDocument,
  stringify as stringifyYaml,
} from "yaml";

import { deepEqual } from "./detectors/path.js";

export class ProfileError extends Error {}

function validateProfile(profile: unknown): Profile {
  const result = ProfileSchema.safeParse(profile);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ProfileError(`invalid profile: ${issues}`);
  }
  return result.data;
}

export interface LoadProfileOptions {
  /**
   * What a key this version doesn't know does: fail (the default, so a
   * person's typo is caught), or warn and be ignored. The action warns: a
   * profile written by a newer CLI shouldn't turn every PR red.
   */
  unknownKeys?: "fail" | "warn" | undefined;
  /** Hears the warning when `unknownKeys` is "warn". */
  onWarning?: ((message: string) => void) | undefined;
}

/** The dotted names of the keys an unrecognized-keys issue reports. */
function unknownKeyNames(issues: readonly ZodIssueLike[]): string[] {
  return issues.flatMap((i) =>
    (i.keys ?? []).map((k) => [...i.path, k].join(".")),
  );
}

interface ZodIssueLike {
  code: string;
  path: PropertyKey[];
  keys?: string[];
}

/** `value` without the keys an unrecognized-keys issue names. */
function withoutKeys(value: unknown, issues: readonly ZodIssueLike[]): unknown {
  const copy: unknown = structuredClone(value);
  for (const issue of issues) {
    let at: unknown = copy;
    for (const step of issue.path)
      at = (at as Record<PropertyKey, unknown> | undefined)?.[step];
    if (at && typeof at === "object")
      for (const key of issue.keys ?? [])
        delete (at as Record<string, unknown>)[key];
  }
  return copy;
}

/**
 * Load and validate `<repo>/.rivetari/profile.yml`. Returns null if there is no
 * profile (every control then applies); throws {@link ProfileError} if the file
 * is present but invalid, so the caller can surface a clear message.
 */
export async function loadProfile(
  repoPath: string,
  options: LoadProfileOptions = {},
): Promise<Profile | null> {
  let raw: string;
  try {
    raw = await readFile(resolve(repoPath, ".rivetari", "profile.yml"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new ProfileError(
      `profile.yml is not valid YAML: ${(err as Error).message}`,
    );
  }

  const result = ProfileSchema.safeParse(parsed);
  if (result.success) return result.data;
  const issues = result.error.issues as unknown as ZodIssueLike[];
  // Only keys it doesn't know, and asked to warn: drop them and check again,
  // so anything actually wrong with the rest still fails.
  if (
    options.unknownKeys === "warn" &&
    issues.every((i) => i.code === "unrecognized_keys")
  ) {
    const again = ProfileSchema.safeParse(withoutKeys(parsed, issues));
    if (again.success) {
      options.onWarning?.(
        `profile.yml has keys this version doesn't know, ignored: ${unknownKeyNames(issues).join(", ")}. Pin the action to the release that added them.`,
      );
      return again.data;
    }
  }
  const detail = result.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  throw new ProfileError(`profile.yml is invalid: ${detail}`);
}

/** Validate and write a profile to `<repo>/.rivetari/profile.yml` (full serialize). */
export async function saveProfile(
  repoPath: string,
  profile: unknown,
): Promise<Profile> {
  const validated = validateProfile(profile);
  const dir = resolve(repoPath, ".rivetari");
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(dir, "profile.yml"),
    stringifyYaml(validated),
    "utf8",
  );
  return validated;
}

/**
 * Apply profile changes with a **minimal, comment-preserving** edit: only the
 * leaves that differ from the on-disk profile are written (yaml Document
 * round-trip), so toggling one flag yields a one-line diff. A flag/lane that is
 * absent on disk is already "off", so turning it off is a no-op (no `false` line
 * is added). When there is no file yet, writes a fresh full serialization.
 */
export async function updateProfile(
  repoPath: string,
  profile: unknown,
): Promise<Profile> {
  const validated = validateProfile(profile);
  const file = resolve(repoPath, ".rivetari", "profile.yml");

  let raw: string | null = null;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  await mkdir(resolve(repoPath, ".rivetari"), { recursive: true });
  if (raw === null) {
    await writeFile(file, stringifyYaml(validated), "utf8");
    return validated;
  }

  const doc = parseDocument(raw, { keepSourceTokens: true });
  const parsedCurrent = ProfileSchema.safeParse(doc.toJS());
  const current = parsedCurrent.success ? parsedCurrent.data : null;

  // Compare against the parsed-current values (plain JS), not raw yaml nodes.
  const setIfChanged = (
    path: (string | number)[],
    next: unknown,
    currentValue: unknown,
  ): void => {
    if (!deepEqual(next, currentValue)) doc.setIn(path, next);
  };

  setIfChanged(["version"], validated.version, current?.version);
  setIfChanged(["name"], validated.name, current?.name);
  setIfChanged(["type"], validated.type, current?.type);
  setIfChanged(["stack"], validated.stack, current?.stack);
  if (validated.phase !== undefined) {
    setIfChanged(["phase"], validated.phase, current?.phase);
  }
  setIfChanged(
    ["severity-floor"],
    validated["severity-floor"],
    current?.["severity-floor"],
  );
  setIfChanged(["autonomy"], validated.autonomy, current?.autonomy);
  if (validated.quality !== undefined)
    setIfChanged(["quality"], validated.quality, current?.quality);

  const applyToggles = (
    key: "flags" | "lanes",
    values: Record<string, boolean | undefined>,
    currentValues: Record<string, boolean | undefined> | undefined,
    defaultWhenAbsent: boolean,
  ): void => {
    for (const [name, value] of Object.entries(values)) {
      const onDisk = currentValues?.[name];
      // An absent toggle already has its default value, so don't add a redundant
      // line for it (flags default off; a lane absent here defaults to on).
      if (onDisk === undefined && value === defaultWhenAbsent) continue;
      if (!deepEqual(value, onDisk)) doc.setIn([key, name], value);
    }
  };

  applyToggles("flags", validated.flags, current?.flags, false);
  if (validated.lanes)
    applyToggles("lanes", validated.lanes, current?.lanes, true);

  await writeFile(file, doc.toString(), "utf8");
  return validated;
}
