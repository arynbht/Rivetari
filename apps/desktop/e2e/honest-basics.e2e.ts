import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, type ElectronApplication, test } from "@playwright/test";

import {
  closeApp,
  copyFixtureRepo,
  launchApp,
  type LaunchedApp,
  runAxe,
} from "./helpers";

// The shell's honest basics: Scorecard shows the audit state.json records, Run
// audit never starts the paid swarm, the Floor Plan refresh asks first and says it
// costs money, Gates names the declared phase as current, and the dead org
// setting is gone.

/**
 * Replace main's floor-plan handlers with ones that report the swarm as
 * available and count runs instead of starting Claude agents.
 */
async function stubSwarm(app: ElectronApplication, repoPath: string) {
  const model: unknown = JSON.parse(
    readFileSync(join(repoPath, ".rivetari", "floorplan.json"), "utf8"),
  );
  await app.evaluate(({ ipcMain }, m) => {
    const g = globalThis as unknown as { swarmRuns: number };
    g.swarmRuns = 0;
    const view = { model: m, deepAuditAvailable: true, stale: false };
    ipcMain.removeHandler("floorplan:get");
    ipcMain.handle("floorplan:get", () => view);
    ipcMain.removeHandler("floorplan:run");
    ipcMain.handle("floorplan:run", () => {
      g.swarmRuns += 1;
      return view;
    });
  }, model);
  return () =>
    app.evaluate(
      () => (globalThis as unknown as { swarmRuns: number }).swarmRuns,
    );
}

test.describe("honest basics", () => {
  let launched: LaunchedApp;

  test.afterEach(async () => {
    if (launched) await closeApp(launched);
  });

  test("Scorecard shows the audit state.json records", async () => {
    const repoPath = copyFixtureRepo();
    // As an older CLI recorded it: three controls, one of them since retired.
    writeFileSync(
      join(repoPath, ".rivetari", "state.json"),
      JSON.stringify({
        version: 1,
        generatedAt: "2026-11-23T02:17:38.576Z",
        summary: {
          pass: 1,
          fail: 2,
          needsEvidence: 0,
          waived: 0,
          skip: 0,
          na: 0,
          total: 3,
        },
        controls: [
          {
            id: "repo.readme.present",
            status: "pass",
            lane: "hygiene",
            phase: "discovery",
            severity: "low",
          },
          {
            id: "repo.license.present",
            status: "fail",
            lane: "hygiene",
            phase: "build",
            severity: "high",
          },
          {
            id: "repo.retired-control",
            status: "fail",
            lane: "hygiene",
            phase: "build",
            severity: "low",
          },
        ],
      }),
    );
    launched = await launchApp({
      repos: [{ path: repoPath, name: "sample-repo" }],
    });
    const { page } = launched;

    await page
      .getByRole("button", { name: /sample-repo/ })
      .first()
      .click();

    // No Run audit click: the recorded numbers show as soon as the repo opens.
    const panel = page.locator("#panel-scorecard");
    await expect(panel.getByText(/^3 controls · recorded /)).toBeVisible();
    await expect(panel.getByText("2 fail").first()).toBeVisible();
    // A control the current catalog no longer has still shows, under its id.
    await expect(
      panel.getByRole("button", { name: /^repo\.retired-control/ }),
    ).toBeVisible();
  });

  test("with no state.json it says so, and Run audit records one", async () => {
    const repoPath = copyFixtureRepo();
    launched = await launchApp({
      repos: [{ path: repoPath, name: "sample-repo" }],
    });
    const { app, page } = launched;
    const swarmRuns = await stubSwarm(app, repoPath);

    await page
      .getByRole("button", { name: /sample-repo/ })
      .first()
      .click();
    const panel = page.locator("#panel-scorecard");
    await expect(
      panel.getByText(/No audit has been recorded for this repository yet/),
    ).toBeVisible();
    expect(await runAxe(page), "scorecard with nothing recorded").toEqual([]);

    await page.getByRole("button", { name: "Run audit" }).click();
    await expect(panel.getByText(/\d+ controls · recorded /)).toBeVisible();

    // The scorecard is what Run audit wrote to state.json.
    const state = JSON.parse(
      readFileSync(join(repoPath, ".rivetari", "state.json"), "utf8"),
    ) as { summary: { total: number } };
    await expect(
      panel.getByText(new RegExp(`^${state.summary.total} controls · `)),
    ).toBeVisible();

    // And it didn't start the deep-audit swarm on the side.
    expect(await swarmRuns()).toBe(0);
  });

  test("Refresh floor plan says it costs money and asks first", async () => {
    const repoPath = copyFixtureRepo();
    launched = await launchApp({
      repos: [{ path: repoPath, name: "sample-repo" }],
    });
    const { app, page } = launched;
    const swarmRuns = await stubSwarm(app, repoPath);

    await page
      .getByRole("button", { name: /sample-repo/ })
      .first()
      .click();
    await page.getByRole("tab", { name: "Floor Plan" }).click();
    const panel = page.locator("#panel-floorplan");
    await expect(panel.getByText(/\d+ systems · \d+ nodes/)).toBeVisible();

    const refresh = panel.getByRole("button", { name: "Refresh floor plan" });
    await expect(refresh).toHaveAccessibleDescription(/costs money/);

    // Asking, then cancelling, runs nothing.
    await refresh.click();
    const confirm = panel.getByRole("group", { name: "Run the deep audit?" });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("costs money");
    expect(await runAxe(page), "floor plan refresh confirm").toEqual([]);
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    expect(await swarmRuns()).toBe(0);

    // Confirming runs it once.
    await refresh.click();
    await panel
      .getByRole("group", { name: "Run the deep audit?" })
      .getByRole("button", { name: "Run the deep audit" })
      .click();
    await expect.poll(swarmRuns).toBe(1);
  });

  test("Gates shows the declared phase as current, inferred apart", async () => {
    const repoPath = copyFixtureRepo();
    const profile = join(repoPath, ".rivetari", "profile.yml");
    writeFileSync(
      profile,
      readFileSync(profile, "utf8").replace(
        "flags: {}",
        "phase: build\nflags: {}",
      ),
    );
    launched = await launchApp({
      repos: [{ path: repoPath, name: "sample-repo" }],
    });
    const { page } = launched;

    await page
      .getByRole("button", { name: /sample-repo/ })
      .first()
      .click();
    await page.getByRole("tab", { name: "Gates" }).click();
    const panel = page.locator("#panel-gates");
    await expect(panel).toContainText(
      "Current phase: Build (declared in the profile)",
    );
    await expect(panel).toContainText("Inferred from controls: Discovery");
    await expect(panel.getByText("current phase", { exact: true })).toHaveCount(
      1,
    );
  });

  test("Settings has no Default GitHub org and loads an old file", async () => {
    // A settings file from before the field was removed.
    launched = await launchApp({ settings: { defaultOrg: "my-org" } });
    const { page } = launched;

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page.getByLabel("Theme")).toBeVisible();
    await expect(page.getByText("Default GitHub org")).toHaveCount(0);
  });
});
