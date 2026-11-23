// Every claude call has a limit, and a run's budget ends whichever call is in
// flight when it runs out. Real node children stand in for `claude`.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  budgetSpent,
  CALL_TIMEOUT_ENV,
  CallTimeoutError,
  callTimeoutMinutes,
  DEFAULT_CALL_TIMEOUT_MINUTES,
  minutesFromEnv,
  spawnWithLimit,
  withTimeBudget,
} from "./call-limit.js";

const saved = process.env[CALL_TIMEOUT_ENV];
const made: string[] = [];
afterEach(async () => {
  if (saved === undefined) delete process.env[CALL_TIMEOUT_ENV];
  else process.env[CALL_TIMEOUT_ENV] = saved;
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 50 && alive(pid); i++)
    await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
}

/** A child that writes its pid (and, with `grandchild`, its child's) and hangs. */
async function hanging(grandchild = false) {
  const dir = await mkdtemp(join(tmpdir(), "rivetari-limit-"));
  made.push(dir);
  const file = join(dir, "pids.json");
  const script = `
    const { spawn } = require("node:child_process");
    const pids = [process.pid];
    ${grandchild ? `pids.push(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }).pid);` : ""}
    require("node:fs").writeFileSync(${JSON.stringify(file)}, JSON.stringify(pids));
    setInterval(() => {}, 1000);
  `;
  const pids = async () => {
    for (let i = 0; i < 50; i++) {
      const text = await readFile(file, "utf8").catch(() => "");
      if (text) return JSON.parse(text) as number[];
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("the child never wrote its pid");
  };
  return { argv: ["-e", script], pids };
}

describe("call limits", { timeout: 30_000 }, () => {
  it("defaults to 20 minutes, and RIVETARI_CALL_TIMEOUT_MINUTES overrides it", () => {
    expect(DEFAULT_CALL_TIMEOUT_MINUTES).toBe(20);
    expect(callTimeoutMinutes({})).toBe(20);
    expect(callTimeoutMinutes({ [CALL_TIMEOUT_ENV]: "5" })).toBe(5);
    expect(callTimeoutMinutes({ [CALL_TIMEOUT_ENV]: "0.5" })).toBe(0.5);
    for (const bad of ["", "0", "-3", "soon"])
      expect(callTimeoutMinutes({ [CALL_TIMEOUT_ENV]: bad })).toBe(20);
    expect(minutesFromEnv("X", 90, {})).toBe(90);
    expect(minutesFromEnv("X", 90, { X: "120" })).toBe(120);
  });

  it("returns a call's output unchanged when it finishes inside its limit", async () => {
    process.env[CALL_TIMEOUT_ENV] = "1";
    const out = await spawnWithLimit(
      process.execPath,
      ["-e", "process.stdin.pipe(process.stdout)"],
      { input: '{"result":"ok"}' },
    );
    expect(out).toBe('{"result":"ok"}');
  });

  it("still reports a failed call by its stderr", async () => {
    await expect(
      spawnWithLimit(
        process.execPath,
        ["-e", "console.error('not signed in'); process.exit(3)"],
        { input: "" },
      ),
    ).rejects.toThrow("not signed in");
  });

  it("kills a call that runs past its limit", async () => {
    process.env[CALL_TIMEOUT_ENV] = "0.005";
    const child = await hanging();
    const call = spawnWithLimit(process.execPath, child.argv, { input: "" });
    const pids = child.pids();
    const err = await call.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CallTimeoutError);
    expect(err).toMatchObject({
      limit: "call",
      minutes: 0.005,
      env: CALL_TIMEOUT_ENV,
    });
    expect((err as Error).message).toBe(
      "a claude call ran past its 0.005-minute limit (RIVETARI_CALL_TIMEOUT_MINUTES) and was killed",
    );
    const [pid] = await pids;
    expect(await gone(pid!)).toBe(true);
  });

  it.runIf(process.platform === "win32")(
    "kills the call's whole process tree on Windows",
    async () => {
      process.env[CALL_TIMEOUT_ENV] = "0.01";
      const child = await hanging(true);
      const call = spawnWithLimit(process.execPath, child.argv, { input: "" });
      const pids = child.pids();
      await expect(call).rejects.toBeInstanceOf(CallTimeoutError);
      for (const pid of await pids) expect(await gone(pid)).toBe(true);
    },
  );

  it("a budget ends the call in flight when it runs out first", async () => {
    delete process.env[CALL_TIMEOUT_ENV];
    const child = await hanging();
    const err = await withTimeBudget(
      { minutes: 0.005, env: "RIVETARI_TASK_BUDGET_MINUTES" },
      async () => {
        expect(budgetSpent()).toBeUndefined();
        return spawnWithLimit(process.execPath, child.argv, { input: "" });
      },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({
      limit: "budget",
      minutes: 0.005,
      env: "RIVETARI_TASK_BUDGET_MINUTES",
    });
    expect((err as Error).message).toMatch(
      /during a claude call, which was killed$/,
    );
    const [pid] = await child.pids();
    expect(await gone(pid!)).toBe(true);
  });

  it("a spent budget refuses a new call without starting it", async () => {
    await withTimeBudget({ minutes: 0.0001, env: "B" }, async () => {
      await new Promise((r) => setTimeout(r, 20));
      expect(budgetSpent()?.message).toBe(
        "the 0.0001-minute budget (B) ran out",
      );
      await expect(
        spawnWithLimit(process.execPath, ["-e", "process.exit(9)"], {
          input: "",
        }),
      ).rejects.toMatchObject({ limit: "budget" });
    });
    // Outside the budget there is none.
    expect(budgetSpent()).toBeUndefined();
  });

  it("kills the call when its signal aborts", async () => {
    const child = await hanging();
    const controller = new AbortController();
    const call = spawnWithLimit(process.execPath, child.argv, {
      input: "",
      signal: controller.signal,
    });
    const [pid] = await child.pids();
    controller.abort();
    await expect(call).rejects.toThrow();
    expect(await gone(pid!)).toBe(true);
  });
});
