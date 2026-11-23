import { describe, expect, it } from "vitest";

import {
  oneAtATime,
  parallelExitCode,
  type ParallelResult,
  runParallel,
  touchesOverlap,
} from "./parallel.js";
import type { RunOutcome } from "./run.js";
import type { Task } from "./tasks.js";

const outcome = (ran: string[], next: string): RunOutcome => ({
  task: {} as Task,
  ran,
  next,
});

/** A run that finishes only when the test says so, recording what's running. */
function gate() {
  const running = new Set<string>();
  const log: string[] = [];
  const release = new Map<string, () => void>();
  let peak = 0;
  const run = (id: string) =>
    new Promise<RunOutcome>((done) => {
      running.add(id);
      peak = Math.max(peak, running.size);
      log.push(`start ${id}`);
      release.set(id, () => {
        running.delete(id);
        log.push(`end ${id}`);
        done(outcome(["isolate", "build", "prove", "judge", "ship"], "close"));
      });
    });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { run, running, log, release, tick, peak: () => peak };
}

describe("touchesOverlap", () => {
  it("paths: the same file, or a file under a directory named plainly", () => {
    expect(touchesOverlap(["src/a.ts"], ["src/a.ts"])).toBe(true);
    expect(touchesOverlap(["./src/a.ts"], ["src\\a.ts"])).toBe(true);
    expect(touchesOverlap(["src/ui"], ["src/ui/button.ts"])).toBe(true);
    expect(touchesOverlap(["src/a.ts"], ["src/b.ts"])).toBe(false);
    expect(touchesOverlap(["src/ui"], ["src/uikit/x.ts"])).toBe(false);
  });

  it("a glob against a path", () => {
    expect(touchesOverlap(["src/**/*.ts"], ["src/ui/button.ts"])).toBe(true);
    expect(touchesOverlap(["src/*.ts"], ["src/a.ts"])).toBe(true);
    expect(touchesOverlap(["src/*.ts"], ["src/a.css"])).toBe(false);
    expect(touchesOverlap(["src/*.ts"], ["src/ui/a.ts"])).toBe(false);
    expect(touchesOverlap(["docs/**"], ["src/a.ts"])).toBe(false);
  });

  it("a glob against a glob", () => {
    expect(touchesOverlap(["src/**"], ["src/ui/*.ts"])).toBe(true);
    expect(touchesOverlap(["src/**/*.ts"], ["src/ui/**"])).toBe(true);
    expect(touchesOverlap(["src/**/*.ts"], ["src/**/*.d.ts"])).toBe(true);
    expect(touchesOverlap(["src/**/*.ts"], ["src/ui/*.css"])).toBe(false);
    expect(touchesOverlap(["src/a/**"], ["src/b/**"])).toBe(false);
    expect(touchesOverlap(["packages/*/src/**"], ["packages/*/test/**"])).toBe(
      false,
    );
    expect(touchesOverlap(["packages/cli/**"], ["packages/*/src/x.ts"])).toBe(
      true,
    );
  });

  it("any pair across the two lists, and a card with no touches overlaps every card", () => {
    expect(touchesOverlap(["docs/a.md", "src/a.ts"], ["src/**"])).toBe(true);
    expect(touchesOverlap(["docs/a.md"], ["src/**", "lib/**"])).toBe(false);
    expect(touchesOverlap([], ["src/a.ts"])).toBe(true);
    expect(touchesOverlap(["src/a.ts"], [])).toBe(true);
  });
});

describe("runParallel", () => {
  it("runs two disjoint tasks at the same time", async () => {
    const g = gate();
    const all = runParallel(
      [
        { id: "T-0001", touches: ["src/a.ts"] },
        { id: "T-0002", touches: ["docs/**"] },
      ],
      { parallel: 2, run: g.run },
    );
    await g.tick();
    expect([...g.running].sort()).toEqual(["T-0001", "T-0002"]);
    g.release.get("T-0002")?.();
    g.release.get("T-0001")?.();
    const results = await all;
    expect(results.map((r) => r.status)).toEqual(["shipped", "shipped"]);
    expect(g.peak()).toBe(2);
  });

  it("runs an overlapping pair one after the other, and says who waits for whom", async () => {
    const g = gate();
    const waits: string[] = [];
    const all = runParallel(
      [
        { id: "T-0001", touches: ["src/**"] },
        { id: "T-0002", touches: ["src/ui/button.ts"] },
        { id: "T-0003", touches: ["docs/a.md"] },
      ],
      {
        parallel: 3,
        run: g.run,
        onWait: (id, behind) => waits.push(`${id} <- ${behind.join(",")}`),
      },
    );
    await g.tick();
    // The disjoint one doesn't wait for the pair.
    expect([...g.running].sort()).toEqual(["T-0001", "T-0003"]);
    expect(waits).toEqual(["T-0002 <- T-0001"]);
    g.release.get("T-0001")?.();
    await g.tick();
    expect(g.running.has("T-0002")).toBe(true);
    g.release.get("T-0002")?.();
    g.release.get("T-0003")?.();
    await all;
    expect(g.log.indexOf("start T-0002")).toBeGreaterThan(
      g.log.indexOf("end T-0001"),
    );
  });

  it("keeps the queue's order among overlapping tasks and never runs more than asked", async () => {
    const g = gate();
    const all = runParallel(
      [
        { id: "T-0001", touches: ["src/a.ts"] },
        { id: "T-0002", touches: ["src/a.ts", "src/b.ts"] },
        { id: "T-0003", touches: ["src/b.ts"] },
        { id: "T-0004", touches: ["lib/x.ts"] },
        { id: "T-0005", touches: ["bin/y.ts"] },
      ],
      { parallel: 2, run: g.run },
    );
    await g.tick();
    // T-0003 doesn't overlap T-0001, but T-0002 is ahead of it on src/b.ts.
    expect([...g.running].sort()).toEqual(["T-0001", "T-0004"]);
    g.release.get("T-0001")?.();
    await g.tick();
    expect([...g.running].sort()).toEqual(["T-0002", "T-0004"]);
    g.release.get("T-0004")?.();
    await g.tick();
    expect([...g.running].sort()).toEqual(["T-0002", "T-0005"]);
    g.release.get("T-0002")?.();
    await g.tick();
    g.release.get("T-0003")?.();
    g.release.get("T-0005")?.();
    await all;
    expect(g.peak()).toBe(2);
  });

  it("with --parallel 1, runs the tasks one at a time in order", async () => {
    const g = gate();
    const all = runParallel(
      [
        { id: "T-0001", touches: ["a.ts"] },
        { id: "T-0002", touches: ["b.ts"] },
      ],
      { parallel: 1, run: g.run },
    );
    await g.tick();
    expect([...g.running]).toEqual(["T-0001"]);
    g.release.get("T-0001")?.();
    await g.tick();
    g.release.get("T-0002")?.();
    await all;
    expect(g.log).toEqual([
      "start T-0001",
      "end T-0001",
      "start T-0002",
      "end T-0002",
    ]);
  });

  it("reports each task's ending in the order given, an error included", async () => {
    const results = await runParallel(
      [
        { id: "T-0001", touches: ["a.ts"] },
        { id: "T-0002", touches: ["b.ts"] },
        { id: "T-0003", touches: ["c.ts"] },
      ],
      {
        parallel: 3,
        run: async (id) => {
          if (id === "T-0002") throw new Error("judge blew up");
          return id === "T-0001"
            ? outcome(["ship"], "close")
            : outcome(["build"], "stop-and-ask: answer it");
        },
      },
    );
    expect(results).toEqual([
      { id: "T-0001", status: "shipped", next: "close" },
      { id: "T-0002", status: "errored", next: "judge blew up" },
      { id: "T-0003", status: "stopped", next: "stop-and-ask: answer it" },
    ]);
  });
});

describe("parallelExitCode", () => {
  const r = (status: ParallelResult["status"]): ParallelResult => ({
    id: "T-0001",
    status,
    next: "",
  });
  it("is 0 when all shipped, 2 when any stopped for a person, 1 when any errored", () => {
    expect(parallelExitCode([r("shipped"), r("shipped")])).toBe(0);
    expect(parallelExitCode([r("shipped"), r("stopped")])).toBe(2);
    expect(parallelExitCode([r("stopped"), r("errored"), r("shipped")])).toBe(
      1,
    );
    expect(parallelExitCode([])).toBe(0);
  });
});

describe("oneAtATime", () => {
  it("runs what it's given one after the other, even after a failure", async () => {
    const lock = oneAtATime();
    const log: string[] = [];
    let inside = 0;
    const step = (name: string, fail = false) =>
      lock(async () => {
        inside++;
        expect(inside).toBe(1);
        await new Promise((r) => setTimeout(r, 5));
        log.push(name);
        inside--;
        if (fail) throw new Error(name);
        return name;
      });
    const runs = [step("a"), step("b", true), step("c")];
    const settled = await Promise.allSettled(runs);
    expect(log).toEqual(["a", "b", "c"]);
    expect(settled.map((s) => s.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);
  });
});
