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

/** The registered App's client id, or null when there's no readable app.json with one. */
export async function appClientId(
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<string | null> {
  let text: string;
  try {
    text = await read(appJsonPath());
  } catch {
    return null;
  }
  try {
    const clientId = (JSON.parse(text) as { clientId?: unknown }).clientId;
    return typeof clientId === "string" && clientId.trim() !== ""
      ? clientId.trim()
      : null;
  } catch {
    return null;
  }
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
