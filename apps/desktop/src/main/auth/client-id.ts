// Which GitHub client id the device-flow sign-in uses (ADR-0007). The env var
// wins, so a dev build can point at a test App; otherwise it's the App that
// `rivetari app register` recorded in Rivetari's config directory, the same one
// the CLI uses. Only app.json is read: its client id isn't a secret, and the
// App's private key and secrets stay where they are.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { rivetariConfigDir } from "@arynbht/rivetari-engine";

export const CLIENT_ID_ENV = "RIVETARI_GITHUB_CLIENT_ID";

export interface ClientId {
  clientId: string;
  /** Where it came from, for the message when sign-in fails. */
  source: "env" | "app";
}

/** app.json's path, for the message that names where the client id is looked for. */
export const appJsonPath = (): string => join(rivetariConfigDir(), "app.json");

/**
 * The registered App's client id, or null when no App is registered (no
 * app.json) or its record has none. An app.json that can't be read or isn't
 * JSON is an error, said with the path, so it isn't mistaken for "not set up".
 */
export async function appClientId(
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<string | null> {
  const path = appJsonPath();
  let text: string;
  try {
    text = await read(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(
      `couldn't read ${path} for the GitHub App's client id: ${(err as Error).message}`,
      { cause: err },
    );
  }
  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `${path} isn't valid JSON (${(err as Error).message}); run \`rivetari app register\` again or fix the file`,
      { cause: err },
    );
  }
  const clientId = (record as { clientId?: unknown } | null)?.clientId;
  return typeof clientId === "string" && clientId.trim() !== ""
    ? clientId.trim()
    : null;
}

/** The env var's client id, else the registered App's, else null. */
export async function resolveClientId(
  env: NodeJS.ProcessEnv = process.env,
  app: () => Promise<string | null> = () => appClientId(),
): Promise<ClientId | null> {
  const fromEnv = env[CLIENT_ID_ENV]?.trim();
  if (fromEnv) return { clientId: fromEnv, source: "env" };
  const fromApp = await app();
  return fromApp ? { clientId: fromApp, source: "app" } : null;
}

/** What sign-in says when neither source has a client id. */
export function notConfiguredMessage(): string {
  return (
    `GitHub sign-in isn't configured: ${CLIENT_ID_ENV} isn't set and ` +
    `${appJsonPath()} has no client id. Run \`rivetari app register\` to ` +
    `register Rivetari's GitHub App, or set ${CLIENT_ID_ENV} (ADR-0007).`
  );
}
