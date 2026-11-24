import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { appendHistory, loadHistory } from "./history.js";

const made: string[] = [];
afterEach(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

describe("history status counts", () => {
  it("keeps a snapshot's status counts, and reads older rows without them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rivetari-hist-summary-"));
    made.push(dir);
    await mkdir(join(dir, ".rivetari"), { recursive: true });
    const summary = {
      pass: 6,
      fail: 3,
      needsEvidence: 1,
      waived: 0,
      skip: 0,
      na: 2,
      total: 12,
    };
    await appendHistory(dir, {
      date: "2026-11-01",
      byLane: { security: { pass: 5, total: 10 } },
    });
    await appendHistory(dir, {
      date: "2026-11-08",
      byLane: { security: { pass: 6, total: 10 } },
      summary,
    });

    const entries = await loadHistory(dir);
    expect(entries[0]?.summary).toBeUndefined();
    expect(entries[1]?.summary).toEqual(summary);
  });
});
