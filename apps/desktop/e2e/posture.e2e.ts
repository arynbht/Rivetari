import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { closeApp, launchApp, type LaunchedApp, runAxe } from "./helpers";
import { postureRepo, TOTALS, WAIVERS } from "./posture-fixture";
import { LEDGER_KEY } from "./tasks-fixture";

// The Posture tab against a repo with a recorded audit, posture snapshots,
// waivers and evidence: the totals are state.json's, the trend draws every
// snapshot, the phase lens shows the declared phase beside the one the
// controls give and what stands before the next, and the expired waiver is
// flagged. "Start a task for these gaps" and "Start a task to waive" draft
// cards the runtime records on the tasks branch, and neither writes
// waivers.yml. axe finds nothing serious. Screenshots of Posture go to
// RIVETARI_SHOTS_DIR when it's set.

const shotsDir = process.env.RIVETARI_SHOTS_DIR;

async function shot(page: Page, name: string): Promise<void> {
  const testInfo = test.info();
  const path = shotsDir
    ? join(shotsDir, `${name}.png`)
    : testInfo.outputPath(`${name}.png`);
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test.describe("posture", () => {
  let launched: LaunchedApp | undefined;
  const cleanup: string[] = [];

  test.afterEach(async () => {
    if (launched) await closeApp(launched);
    launched = undefined;
    for (const dir of cleanup.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  test("joins the scorecard, the phase lens, the trend and waivers, and drafts cards for gaps", async () => {
    const repo = postureRepo();
    // A private config dir: no sign-in, and no ledger key but the fixture's.
    const config = mkdtempSync(join(tmpdir(), "rivetari-e2e-config-"));
    cleanup.push(repo, config);
    launched = await launchApp({
      repos: [{ path: repo, name: "posture-repo" }],
      env: { RIVETARI_LEDGER_KEY: LEDGER_KEY, RIVETARI_CONFIG_DIR: config },
    });
    const { page } = launched;
    await page
      .getByRole("button", { name: /posture-repo/ })
      .first()
      .click();

    // Posture sits right after Now and Tasks.
    const tabs = page.getByRole("tab");
    await expect(tabs.nth(0)).toHaveText("Now");
    await expect(tabs.nth(1)).toHaveText("Tasks");
    await expect(tabs.nth(2)).toHaveText("Posture");
    await page.getByRole("tab", { name: "Posture" }).click();
    const panel = page.locator("#panel-posture");
    await expect(
      panel.getByRole("heading", { name: "Posture", exact: true }),
    ).toBeVisible();
    await expect(panel).toContainText("8 controls · recorded");

    // The totals are the recorded audit's, as `rivetari audit` counts it.
    const recorded = panel.locator('dl[aria-label="Recorded totals"]');
    for (const [label, n] of Object.entries(TOTALS)) {
      await expect(
        recorded.locator("div", {
          has: page.getByText(label, { exact: true }),
        }),
      ).toHaveText(`${label}${n}`);
    }

    // The trend draws all four snapshots, and its table lists them.
    const trend = panel.getByRole("region", { name: "Trend" });
    await expect(
      trend.getByRole("img", { name: /Posture trend over 4 snapshots/ }),
    ).toBeVisible();
    const legend = trend.getByRole("list", { name: "Trend legend" });
    await expect(legend).toContainText("Pass2");
    await expect(legend).toContainText("Fail3");
    await expect(legend).toContainText("Needs evidence1");
    await expect(trend).toContainText("Older snapshots record only passing");
    await trend.getByRole("button", { name: "Show as table" }).click();
    await expect(trend.getByRole("row")).toHaveCount(5);
    // The oldest snapshot predates status counts: pass of total only.
    await expect(trend.getByRole("row").nth(1)).toContainText("1––6");
    await trend.getByRole("button", { name: "Show as chart" }).click();

    // The lens: the profile says scaffold, the controls say build, and two
    // controls stand between build and harden.
    const phase = panel.getByRole("region", { name: "Phase" });
    await expect(
      phase
        .getByText("Current phase (profile.yml)", { exact: true })
        .locator(".."),
    ).toHaveText("Current phase (profile.yml)Scaffold");
    await expect(
      phase
        .getByText("Where the controls put it", { exact: true })
        .locator(".."),
    ).toHaveText("Where the controls put itBuild");
    await expect(phase).toContainText(
      "The Scaffold gate is green, so the controls put the repo at Build.",
    );
    const next = phase.getByRole("list", {
      name: "Between Build and Harden: 2 controls",
    });
    await expect(next.getByRole("listitem")).toHaveCount(2);
    await expect(next.getByRole("listitem").nth(0)).toContainText(
      "a11y.keyboard.manual-pass",
    );
    await expect(next.getByRole("listitem").nth(1)).toContainText(
      "ci.changelog-automated",
    );

    // Waivers and evidence, with who, when and the expired ones flagged.
    const onFile = panel.getByRole("region", { name: "Waivers and evidence" });
    const waivers = onFile.getByRole("table", { name: /Waivers/ });
    const waiver = (id: string) =>
      waivers.getByRole("row").filter({ hasText: id });
    await expect(waiver("product.discovery.brief")).toContainText("Expired");
    await expect(waiver("product.discovery.brief")).toContainText(
      "ann@example.com",
    );
    await expect(waiver("dev.env-example")).toContainText("Expires soon");
    await expect(waiver("ci.actions-pinned-sha")).toContainText("Active");
    const evidence = onFile.getByRole("table", { name: /Evidence/ });
    await expect(
      evidence
        .getByRole("row")
        .filter({ hasText: "a11y.keyboard.manual-pass" }),
    ).toContainText("Expired");
    await expect(
      evidence.getByRole("row").filter({ hasText: "a11y.screen-reader.pass" }),
    ).toContainText("Expires soon");

    // The old direct-write buttons aren't here; every write is a task.
    await expect(panel.getByRole("button", { name: /^Waive$/ })).toHaveCount(0);

    await shot(page, "after-posture");
    // The view scrolls inside the window: the trend, the controls and what's
    // on file, each in view.
    for (const [name, part] of [
      ["after-posture-trend", trend],
      [
        "after-posture-controls",
        panel.getByRole("region", { name: "Controls" }),
      ],
      ["after-posture-waivers", onFile],
    ] as const) {
      await part.evaluate((el) => el.scrollIntoView({ block: "start" }));
      await shot(page, name);
    }
    expect(await runAxe(page), "posture").toEqual([]);

    // Pick the blockers and start one task for them.
    await phase
      .getByRole("button", { name: "Select these for a task" })
      .click();
    await expect(
      panel.getByRole("checkbox", { name: "Select ci.changelog-automated" }),
    ).toBeChecked();
    await panel
      .getByRole("checkbox", { name: "Select ci.actions-pinned-sha" })
      .check();
    const bar = panel.getByRole("region", { name: "Selected gaps" });
    await expect(bar).toContainText("3 selected");
    await bar
      .getByRole("button", { name: "Start a task for these gaps" })
      .click();
    const status = panel.getByRole("status");
    await expect(status).toContainText("Drafted T-0001: Close posture gaps:");
    await expect(status).toContainText("waits at intake");
    await expect(bar).toContainText("Select failing controls");
    await status.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await shot(page, "after-posture-drafted");

    // The runtime recorded it: the card with one criterion per control, a
    // signed ledger, and the card on the tasks branch.
    const card = readFileSync(
      join(repo, ".rivetari", "tasks", "T-0001", "card.yml"),
      "utf8",
    );
    for (const id of [
      "a11y.keyboard.manual-pass",
      "ci.changelog-automated",
      "ci.actions-pinned-sha",
    ])
      expect(card).toContain(`${id} passes in \`rivetari audit\``);
    expect(card).toContain(`owner: e2e@example.com`);
    const ledger = readFileSync(
      join(repo, ".rivetari", "tasks", "T-0001", "ledger.jsonl"),
      "utf8",
    );
    expect(ledger).toContain("card drafted with 3 acceptance criteria");
    const onBranch = execFileSync(
      "git",
      ["show", "rivetari/tasks:T-0001/card.yml"],
      { cwd: repo, encoding: "utf8" },
    );
    expect(onBranch).toBe(card);

    // A waiver is a task too, and waivers.yml stays as it was.
    await panel
      .getByRole("button", { name: "Waive ci.changelog-automated" })
      .click();
    const form = panel.getByRole("form", {
      name: "Start a task to waive ci.changelog-automated",
    });
    await form
      .getByLabel("Why it should be waived")
      .fill("Release notes are written by hand");
    await shot(page, "after-posture-waive-form");
    expect(await runAxe(page), "posture waive form").toEqual([]);
    await form.getByRole("button", { name: "Start a task to waive" }).click();
    await expect(status).toContainText(
      "Drafted T-0002: Waive ci.changelog-automated",
    );
    expect(readFileSync(join(repo, ".rivetari", "waivers.yml"), "utf8")).toBe(
      WAIVERS,
    );
    expect(
      readFileSync(
        join(repo, ".rivetari", "tasks", "T-0002", "card.yml"),
        "utf8",
      ),
    ).toContain("Reason: Release notes are written by hand");
    expect(readdirSync(join(repo, ".rivetari", "tasks"))).toEqual(
      expect.arrayContaining(["T-0001", "T-0002"]),
    );
    // Nothing landed on main: its last commit is still the fixture's.
    expect(
      execFileSync("git", ["log", "--format=%s", "main"], {
        cwd: repo,
        encoding: "utf8",
      }).trim(),
    ).toBe("init");
  });
});
