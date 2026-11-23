import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ciBudgetCheck } from "./doctor.js";

const made: string[] = [];
afterEach(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

async function repoWithBudget(budget?: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rivetari-doctor-ci-"));
  made.push(dir);
  await mkdir(join(dir, ".rivetari"));
  await writeFile(
    join(dir, ".rivetari", "profile.yml"),
    `version: 1\nname: demo\ntype: web-app\n${budget ? `ci:\n  budget_minutes_per_month: ${budget}\n` : ""}`,
  );
  return dir;
}

const now = new Date("2026-11-23T08:00:00Z");
const used = (minutes: number) => async () => ({
  minutes,
  runs: 40,
  partial: false,
});

describe("doctor's CI budget check", () => {
  it("warns, without failing, at 75% of the month's budget and past it", async () => {
    const dir = await repoWithBudget(400);
    for (const minutes of [300, 520]) {
      const check = await ciBudgetCheck(dir, { now, minutes: used(minutes) });
      expect(check).toMatchObject({ name: "ci", status: "warn" });
      expect(check?.detail).toContain(
        `${minutes} of the 400 CI minutes budgeted for 2026-11 used`,
      );
    }
  });

  it("stays quiet below 75%", async () => {
    const dir = await repoWithBudget(400);
    expect(await ciBudgetCheck(dir, { now, minutes: used(299) })).toBeNull();
  });

  it("stays quiet without a budget, and never counts then", async () => {
    const dir = await repoWithBudget();
    let counted = false;
    const check = await ciBudgetCheck(dir, {
      now,
      minutes: async () => {
        counted = true;
        return { minutes: 10_000, runs: 1, partial: false };
      },
    });
    expect(check).toBeNull();
    expect(counted).toBe(false);
  });

  it("stays quiet without a token, or when the Actions API can't be read", async () => {
    const dir = await repoWithBudget(400);
    expect(await ciBudgetCheck(dir, { now, token: null })).toBeNull();
    expect(
      await ciBudgetCheck(dir, {
        now,
        minutes: () => Promise.reject(new Error("403")),
      }),
    ).toBeNull();
  });
});
