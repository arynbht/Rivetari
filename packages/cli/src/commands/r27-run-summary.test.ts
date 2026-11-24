// R-27: `task run` printed no summary when the judge's review crashed, so the
// only sign was a stack trace and a ledger left at "next: judge". A stopped
// run now ends with what stopped it and the step it left the task at.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { stoppedLine } from "./task.js";

const made: string[] = [];
afterEach(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

describe("R-27: a stopped run still prints its summary", () => {
  it("says what stopped it and what's next, even when the task can't be read", async () => {
    const repo = await mkdtemp(join(tmpdir(), "rivetari-r27-"));
    made.push(repo);
    const line = await stoppedLine(
      repo,
      "T-0013",
      new Error("claude CLI failed: claude exited with code 1:\n  overloaded"),
    );
    expect(line).toBe(
      "run stopped: claude CLI failed: claude exited with code 1: overloaded\nnext: unknown (the task couldn't be read)",
    );
  });
});
