import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  closeApp,
  copyFixtureRepo,
  launchApp,
  type LaunchedApp,
  runAxe,
} from "./helpers";

// The shell's honest basics: Posture shows the audit state.json records, Run
// audit records a fresh one, and the dead org setting is gone.

test.describe("honest basics", () => {
  let launched: LaunchedApp;

  test.afterEach(async () => {
    if (launched) await closeApp(launched);
  });

  test("Posture shows the audit state.json records", async () => {
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

    // No Run audit click: the recorded numbers show as soon as Posture opens.
    await page.getByRole("tab", { name: "Posture" }).click();
    const panel = page.locator("#panel-posture");
    await expect(panel.getByText(/^3 controls · recorded /)).toBeVisible();
    await expect(panel.getByText(/· 2 fail/).first()).toBeVisible();
    // A control the current catalog no longer has still shows, under its id.
    await expect(
      panel.getByRole("checkbox", { name: "Select repo.retired-control" }),
    ).toBeVisible();
  });

  test("with no state.json it says so, and Run audit records one", async () => {
    const repoPath = copyFixtureRepo();
    launched = await launchApp({
      repos: [{ path: repoPath, name: "sample-repo" }],
    });
    const { page } = launched;

    await page
      .getByRole("button", { name: /sample-repo/ })
      .first()
      .click();
    await page.getByRole("tab", { name: "Posture" }).click();
    const panel = page.locator("#panel-posture");
    await expect(
      panel.getByText(/No audit has been recorded for this repository yet/),
    ).toBeVisible();
    expect(await runAxe(page), "posture with nothing recorded").toEqual([]);

    await panel.getByRole("button", { name: "Run audit" }).click();
    await expect(panel.getByText(/\d+ controls · recorded /)).toBeVisible();

    // The scorecard is what Run audit wrote to state.json.
    const state = JSON.parse(
      readFileSync(join(repoPath, ".rivetari", "state.json"), "utf8"),
    ) as { summary: { total: number } };
    await expect(
      panel.getByText(new RegExp(`^${state.summary.total} controls · `)),
    ).toBeVisible();
  });

  test("a Run audit that lands after a repo switch stays off the new repo", async () => {
    const first = copyFixtureRepo();
    const second = copyFixtureRepo();
    writeFileSync(
      join(second, ".rivetari", "state.json"),
      JSON.stringify({
        version: 1,
        generatedAt: "2026-11-23T02:17:38.576Z",
        controls: [
          {
            id: "repo.readme.present",
            status: "pass",
            lane: "hygiene",
            phase: "discovery",
            severity: "low",
          },
        ],
      }),
    );
    launched = await launchApp({
      repos: [
        { path: first, name: "first-repo" },
        { path: second, name: "second-repo" },
      ],
    });
    const { app, page } = launched;
    // A slow audit for the first repo, so the switch happens while it runs.
    await app.evaluate(({ ipcMain }, repoPath) => {
      ipcMain.removeHandler("audit:run");
      ipcMain.handle(
        "audit:run",
        () =>
          new Promise((done) =>
            setTimeout(
              () =>
                done({
                  repoPath,
                  generatedAt: "2026-11-24T00:00:00.000Z",
                  totals: {
                    pass: 0,
                    fail: 7,
                    needsEvidence: 0,
                    waived: 0,
                    skip: 0,
                    na: 0,
                    total: 7,
                  },
                  lanes: [],
                }),
              1500,
            ),
          ),
      );
    }, first);

    await page
      .getByRole("button", { name: /first-repo/ })
      .first()
      .click();
    await page.getByRole("tab", { name: "Posture" }).click();
    await page
      .locator("#panel-posture")
      .getByRole("button", { name: "Run audit" })
      .click();
    await page
      .getByRole("button", { name: /second-repo/ })
      .first()
      .click();
    await page.getByRole("tab", { name: "Posture" }).click();

    const panel = page.locator("#panel-posture");
    await expect(panel.getByText(/^1 controls · recorded /)).toBeVisible();
    // Long enough for the first repo's audit to have landed.
    await page.waitForTimeout(2000);
    await expect(panel.getByText(/^1 controls · recorded /)).toBeVisible();
    await expect(panel.getByText(/^7 controls/)).toHaveCount(0);
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
