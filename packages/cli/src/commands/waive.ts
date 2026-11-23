import { resolve } from "node:path";

import type { Waiver } from "@arynbht/rivetari-catalog";
import { addWaiver, WaiverError } from "@arynbht/rivetari-engine";

export interface WaiveFlags {
  reason?: string;
  expires?: string;
  owner?: string;
}

/** `rivetari waive <control> --reason --expires [--owner]`. */
export async function runWaive(
  control: string,
  flags: WaiveFlags,
  path: string,
  created: string,
): Promise<number> {
  if (!flags.reason) {
    console.error("rivetari waive: --reason is required");
    return 1;
  }
  if (!flags.expires) {
    console.error("rivetari waive: --expires <YYYY-MM-DD> is required");
    return 1;
  }

  const waiver: Waiver = {
    control,
    reason: flags.reason,
    expires: flags.expires,
    created,
    ...(flags.owner ? { owner: flags.owner } : {}),
  };

  try {
    await addWaiver(resolve(path), waiver);
  } catch (err) {
    console.error(err instanceof WaiverError ? err.message : String(err));
    return 1;
  }
  process.stdout.write(`Waived ${control} until ${flags.expires}\n`);
  return 0;
}
