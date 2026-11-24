import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { closeApp, launchApp, type LaunchedApp, runAxe } from "./helpers";
import { PROFILE, projectRepo } from "./project-fixture";
import { LEDGER_KEY } from "./tasks-fixture";

// The Project tab against a repo whose profile has fallen behind it: every
// difference (the stack, the phase, the uses-ai flag) is highlighted and
// nothing else is, "Update the profile" drafts one card the runtime records
// listing each change from → to, and profile.yml is never written. The
// autonomy history, proof settings (sign-in shown only as set), skills with
// their gaps and the banned patterns render, and axe finds nothing serious.
// Screenshots of the old Profile tab and of Project go to RIVETARI_SHOTS_DIR
// when it's set.

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

test.describe("project", () => {
  let launched: LaunchedApp | undefined;
  const cleanup: string[] = [];

  test.afterEach(async () => {
    if (launched) await closeApp(launched);
    launched = undefined;
    for (const dir of cleanup.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  test("highlights where profile.yml differs from the repo and drafts a card to fix it", async () => {
    const repo = projectRepo();
    // A private config dir: no sign-in, and no ledger key but the fixture's.
    const config = mkdtempSync(join(tmpdir(), "rivetari-e2e-config-"));
    cleanup.push(repo, config);
    launched = await launchApp({
      repos: [{ path: repo, name: "project-repo" }],
      env: { RIVETARI_LEDGER_KEY: LEDGER_KEY, RIVETARI_CONFIG_DIR: config },
    });
    const { page } = launched;
    await page
      .getByRole("button", { name: /project-repo/ })
      .first()
      .click();

    // The old Profile tab, as it is before this view.
    await page.getByRole("tab", { name: "Profile" }).click();
    await expect(
      page.locator("#panel-profile").getByRole("textbox", { name: "Name" }),
    ).toHaveValue("project-repo");
    await shot(page, "before-profile");

    // Project sits right after Posture.
    const tabs = page.getByRole("tab");
    await expect(tabs.nth(1)).toHaveText("Posture");
    await expect(tabs.nth(2)).toHaveText("Project");
    await page.getByRole("tab", { name: "Project" }).click();
    const panel = page.locator("#panel-project");
    await expect(
      panel.getByRole("heading", { name: "Project", exact: true }),
    ).toBeVisible();
    await expect(panel).toContainText("Checked ");
    await expect(panel).toContainText(
      "Checked again when the repo opens, after a task merges, and once a day.",
    );

    // Every difference is highlighted, and only those.
    const table = panel.getByRole("table", {
      name: "Profile against the repo",
    });
    const differing = table.locator('tr[data-differs="true"]');
    await expect(differing).toHaveCount(3);
    const row = (label: string) =>
      table.getByRole("row").filter({
        has: page.getByRole("rowheader", { name: new RegExp(`^${label}`) }),
      });
    await expect(row("Stack")).toHaveAttribute("data-differs", "true");
    await expect(row("Stack")).toContainText("none");
    await expect(row("Stack")).toContainText("node, typescript");
    await expect(row("Phase")).toHaveAttribute("data-differs", "true");
    await expect(row("Phase")).toContainText("scaffold");
    await expect(row("Phase")).toContainText("Update: phase → build");
    await expect(row("Flag: uses-ai")).toHaveAttribute("data-differs", "true");
    await expect(row("Flag: uses-ai")).toContainText(
      "package.json depends on openai",
    );
    for (const label of ["Name", "Type", "Package manager"])
      await expect(row(label)).not.toHaveAttribute("data-differs", "true");
    await expect(row("Package manager")).toContainText("From proof.start");
    await expect(panel).toContainText("3 fields differ");
    await expect(panel).toContainText("profile.yml also sets has-users");

    // Autonomy: the configured level and the ledger's history, read without
    // the repair the ladder makes, so no ledger.md is written.
    const autonomy = panel.getByRole("region", { name: "Autonomy" });
    await expect(autonomy).toContainText(
      "Configured (profile.yml)review-at-pr",
    );
    await expect(autonomy).toContainText("rivetari autonomy");
    const history = autonomy.getByRole("table", { name: "Autonomy history" });
    await expect(history.getByRole("row")).toHaveCount(2);
    await expect(history).toContainText("override");
    await expect(history).toContainText("reason: trial on the docs site");
    await expect(history).toContainText("ann@example.com");
    expect(existsSync(join(repo, ".rivetari", "autonomy", "ledger.md"))).toBe(
      false,
    );

    // Proof: the settings, and sign-in only as set, never its script.
    const proof = panel.getByRole("region", { name: "Proof" });
    await expect(proof).toContainText("npm run dev");
    await expect(proof).toContainText("120 s");
    await expect(proof).toContainText("Sign-in scriptset");
    await expect(panel).not.toContainText("sign-in.mjs");

    // Skills: what's locked, what the last sync installed, and the gaps.
    const skills = panel.getByRole("region", { name: "Skills" });
    await expect(skills).toContainText("3 locked · 1 of 2 always-on installed");
    const locked = skills.getByRole("table", { name: "Locked skills" });
    const skill = (name: string) =>
      locked.getByRole("row").filter({ hasText: name });
    await expect(skill("ui-kit")).toContainText("Installed");
    await expect(skill("api-docs")).toContainText("Not installed");
    await expect(skill("api-docs")).toContainText("api-docs is not installed");
    await expect(skill("motion-kit")).toContainText("Per task");
    const gaps = skills.getByRole("list", { name: /Gaps the router hit/ });
    await expect(gaps.getByRole("listitem")).toHaveCount(1);
    await expect(gaps).toContainText(
      "motion: no vendored skill covers it; the agent works from the spine",
    );
    await expect(gaps).toContainText("Hit by T-0001");

    // Banned patterns, read-only.
    const banned = panel.getByRole("table", { name: "Banned patterns" });
    await expect(banned.getByRole("row")).toHaveCount(3);
    await expect(banned).toContainText("no-moment");
    await expect(banned).toContainText("moment is retired here; use date-fns");
    await expect(banned).toContainText("no-eval");

    // No direct write: the old Save isn't here.
    await expect(panel.getByRole("button", { name: /save/i })).toHaveCount(0);

    await shot(page, "after-project");
    for (const [name, part] of [
      ["after-project-autonomy", autonomy],
      ["after-project-skills", skills],
    ] as const) {
      await part.evaluate((el) => el.scrollIntoView({ block: "start" }));
      await shot(page, name);
    }
    expect(await runAxe(page), "project").toEqual([]);

    // Fix the differences: one card through the runtime, at intake.
    await table.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await panel.getByRole("button", { name: "Update the profile" }).click();
    const status = panel.getByRole("status");
    await expect(status).toContainText(
      "Bring profile.yml up to date: stack, phase, flags.uses-ai",
    );
    await expect(status).toContainText("waits at intake");
    await status.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await shot(page, "after-project-drafted");
    const id = /Drafted (T-\d{4})/.exec(
      (await status.textContent()) ?? "",
    )?.[1];
    expect(id).toBeTruthy();

    const card = readFileSync(
      join(repo, ".rivetari", "tasks", id!, "card.yml"),
      "utf8",
    );
    for (const text of [
      ".rivetari/profile.yml sets stack to node, typescript (it was none)",
      ".rivetari/profile.yml sets phase to build (it was scaffold)",
      ".rivetari/profile.yml sets flags.uses-ai to true (it was not set)",
    ])
      expect(card).toContain(text);
    expect(card).toContain("- stack: none → node, typescript");
    expect(card).toContain("- phase: scaffold → build");
    expect(card).toContain("- flags.uses-ai: not set → true");
    expect(card).toContain("owner: e2e@example.com");
    const ledger = readFileSync(
      join(repo, ".rivetari", "tasks", id!, "ledger.jsonl"),
      "utf8",
    );
    expect(ledger).toContain("card drafted with 3 acceptance criteria");
    expect(
      execFileSync("git", ["show", `rivetari/tasks:${id}/card.yml`], {
        cwd: repo,
        encoding: "utf8",
      }),
    ).toBe(card);

    // profile.yml is as it was, and nothing landed on main.
    expect(readFileSync(join(repo, ".rivetari", "profile.yml"), "utf8")).toBe(
      PROFILE,
    );
    expect(
      execFileSync("git", ["log", "--format=%s", "main"], {
        cwd: repo,
        encoding: "utf8",
      }).trim(),
    ).toBe("init");

    // Once the Now hub has read the new task, the view knows it changes
    // profile.yml.
    await expect(async () => {
      await panel.getByRole("button", { name: "Refresh" }).click();
      await expect(panel).toContainText(`${id} already changes profile.yml`, {
        timeout: 2000,
      });
    }).toPass();
    expect(await runAxe(page), "project after drafting").toEqual([]);
  });
});
