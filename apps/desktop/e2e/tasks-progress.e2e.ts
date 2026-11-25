import { rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { closeApp, launchApp, type LaunchedApp, runAxe } from "./helpers";
import { LEDGER_KEY, tasksRepo } from "./tasks-fixture";

// Tasks tab while a beat runs: the runtime writes a progress file beside each
// running task's directory, and the tab shows it live. T-0001 is building and
// busy, T-0002's beat has gone quiet for seven minutes (amber), and T-0003 runs
// nothing, so it shows what comes next instead.

const MIN = 60_000;

/** A progress file as the runtime writes it, from this (live) process. */
function progress(
  repo: string,
  id: string,
  body: { beat: string; started: number; active: number; turns?: number },
) {
  writeFileSync(
    join(repo, ".rivetari", "tasks", `${id}.progress.json`),
    JSON.stringify({
      beat: body.beat,
      startedAt: new Date(body.started).toISOString(),
      lastActivityAt: new Date(body.active).toISOString(),
      ...(body.turns === undefined
        ? {}
        : { turns: body.turns, tokens: 52_000, lastTool: "Edit" }),
      pid: process.pid,
    }),
  );
}

test.describe("tasks while they run", () => {
  let launched: LaunchedApp | undefined;
  let repo: string | undefined;

  test.afterEach(async () => {
    if (launched) await closeApp(launched);
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  test("shows each running beat live, a quiet one in amber, and Next only when idle", async () => {
    const testInfo = test.info();
    const fixture = tasksRepo();
    repo = fixture.repo;
    const now = Date.now();
    progress(repo, "T-0001", {
      beat: "build",
      started: now - 12 * MIN - 5000,
      active: now - 20_000,
      turns: 18,
    });
    progress(repo, "T-0002", {
      beat: "judge",
      started: now - 27 * MIN,
      active: now - 7 * MIN - 5000,
    });
    // The ledger's last write counts as activity: T-0002's was before its beat began.
    const before = new Date(now - 30 * MIN);
    utimesSync(
      join(repo, ".rivetari", "tasks", "T-0002", "ledger.jsonl"),
      before,
      before,
    );

    launched = await launchApp({
      repos: [{ path: repo, name: "tasks-repo" }],
      env: { RIVETARI_LEDGER_KEY: LEDGER_KEY },
    });
    const { page } = launched;
    await page
      .getByRole("button", { name: /tasks-repo/ })
      .first()
      .click();
    await page.getByRole("tab", { name: "Tasks" }).click();
    const panel = page.locator("#panel-tasks");
    await panel
      .getByRole("group", { name: "Show tasks as" })
      .getByRole("button", { name: "List" })
      .click();
    const rows = panel
      .getByRole("region", { name: "All tasks" })
      .locator("tbody tr");
    await expect(rows).toHaveCount(3);

    await expect(rows.nth(0)).toContainText(
      /Running: build · 12 min · turn 18 · last activity \d+ s ago/,
    );
    const quiet = rows.nth(1).getByText(/No activity for 7 min/);
    await expect(quiet).toContainText("Running: judge · 27 min");
    await expect(quiet).toHaveClass(/text-amber-400/);
    await expect(rows.nth(2)).not.toContainText("Running");

    // It moves as the runtime writes: a new turn shows up without a reload.
    progress(repo, "T-0001", {
      beat: "build",
      started: now - 12 * MIN - 5000,
      active: Date.now(),
      turns: 19,
    });
    await expect(rows.nth(0)).toContainText(/turn 19 · last activity \d s ago/);

    // A running task's detail says what it's doing, not what's next.
    await rows.nth(0).getByRole("button").click();
    const running = panel.getByRole("region", { name: /T-0001/ });
    await expect(running).toContainText("Running: build");
    await expect(running).toContainText("last tool Edit · 52,000 tokens");
    await expect(running).not.toContainText("Next:");
    // Its ledger is fetched when it's opened.
    await expect(
      panel.getByRole("list", { name: "T-0001 ledger" }),
    ).toContainText("build started");

    await page.screenshot({ path: testInfo.outputPath("tasks-running.png") });
    await testInfo.attach("tasks-running", {
      path: testInfo.outputPath("tasks-running.png"),
      contentType: "image/png",
    });
    expect(await runAxe(page), "tasks while running").toEqual([]);

    // An idle task shows its next step.
    await rows.nth(2).getByRole("button").click();
    const idle = panel.getByRole("region", { name: /T-0003/ });
    await expect(idle).toContainText("Next:");
    await expect(idle).not.toContainText("Running");

    // The beat ends: its file goes, and the task is idle again.
    rmSync(join(repo, ".rivetari", "tasks", "T-0001.progress.json"));
    await expect(rows.nth(0)).not.toContainText("Running");
  });
});
