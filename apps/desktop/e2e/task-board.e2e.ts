import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { boardRepo } from "./board-fixture";
import { closeApp, launchApp, type LaunchedApp, runAxe } from "./helpers";
import { LEDGER_KEY } from "./tasks-fixture";

// The Tasks tab's board and a task in full, against a repo with a task at
// every beat: each sits in its beat's column, a shipped PR and a route to
// approve look different, and the detail shows the card with each criterion's
// status from the latest judge round, the route with its skills and gaps, the
// plan, the UI proof with its screenshots, axe and the R-25 warning, every
// judge round, and the PR. axe finds nothing serious on the board or the
// detail. Screenshots go to RIVETARI_SHOTS_DIR when it's set.

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

const R25 =
  "Rivetari's UI screenshots may show the loading state (known issue R-25): check the page loaded.";

test.describe("task board and detail", () => {
  let launched: LaunchedApp | undefined;
  const cleanup: string[] = [];

  test.afterEach(async () => {
    if (launched) await closeApp(launched);
    launched = undefined;
    for (const dir of cleanup.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  async function openTasks(): Promise<{
    page: Page;
    panel: ReturnType<Page["locator"]>;
  }> {
    const repo = boardRepo();
    // A private config dir: no sign-in, and no ledger key but the fixture's.
    const config = mkdtempSync(join(tmpdir(), "rivetari-e2e-config-"));
    cleanup.push(repo, config);
    launched = await launchApp({
      repos: [{ path: repo, name: "board-repo" }],
      env: { RIVETARI_LEDGER_KEY: LEDGER_KEY, RIVETARI_CONFIG_DIR: config },
    });
    const { page } = launched;
    await page
      .getByRole("button", { name: /board-repo/ })
      .first()
      .click();
    await page.getByRole("tab", { name: "Tasks" }).click();
    const panel = page.locator("#panel-tasks");
    await expect(
      panel.getByRole("heading", { name: "Tasks", exact: true }),
    ).toBeVisible();
    return { page, panel };
  }

  test("places each task in its beat's column, and a task's detail shows its whole record", async () => {
    const { page, panel } = await openTasks();
    const toggle = panel.getByRole("group", { name: "Show tasks as" });
    await toggle.getByRole("button", { name: "Board" }).click();
    await expect(toggle.getByRole("button", { name: "Board" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const board = panel.getByRole("region", { name: "Board", exact: true });
    const columns = board.getByRole("heading", { level: 4 });
    await expect(columns).toHaveText([
      /^intake/,
      /^route/,
      /^build/,
      /^prove/,
      /^judge/,
      /^ship/,
      /^close/,
    ]);
    const column = (beat: string) =>
      board.getByRole("region", { name: new RegExp(`^${beat}`) });
    for (const [beat, id] of [
      ["intake", "T-0001"],
      ["route", "T-0002"],
      ["build", "T-0003"],
      ["judge", "T-0004"],
      ["ship", "T-0005"],
      ["close", "T-0006"],
      ["prove", "T-0007"],
    ] as const) {
      await expect(column(beat).getByRole("button")).toHaveCount(1);
      await expect(column(beat).getByRole("button")).toContainText(id);
    }

    // Shipped and waiting to merge doesn't look like stuck at route.
    const ship = column("ship").getByRole("button");
    await expect(ship).toContainText("PR #42 waiting to merge");
    await expect(ship).toHaveClass(/border-sky-500/);
    const route = column("route").getByRole("button");
    await expect(route).toContainText("Needs you: Route to approve");
    await expect(route).toHaveClass(/border-amber-500/);
    await expect(column("build").getByRole("button")).toContainText(
      "Running: build",
    );
    await expect(column("judge").getByRole("button")).toContainText(
      "medium risk",
    );
    await expect(column("judge").getByRole("button")).toContainText(
      "build 2 · judge 2",
    );

    await shot(page, "board-after");
    // The board scrolls sideways in a narrow window: ship and close, in view.
    await column("close").evaluate((el) =>
      el.scrollIntoView({ inline: "end", block: "nearest" }),
    );
    await shot(page, "board-after-ship-close");
    expect(await runAxe(page), "task board").toEqual([]);

    // The judged task, in full.
    await column("judge").getByRole("button").click();
    const detail = panel.getByRole("region", { name: /T-0004/ });
    await expect(detail).toContainText("Tighten the theme toggle");

    const card = detail.getByRole("region", { name: "Card", exact: true });
    await expect(card).toContainText(
      "Tighten the theme toggle, so readers can choose.",
    );
    await expect(card).toContainText("feature · medium risk");
    await expect(card).toContainText("print styles");
    const criteria = card.getByRole("list", { name: "Acceptance criteria" });
    const criterion = criteria.getByRole("listitem");
    await expect(criterion).toHaveCount(2);
    await expect(criterion.nth(0)).toContainText("A1");
    await expect(criterion.nth(0)).toContainText("verified by e2e");
    await expect(criterion.nth(0)).toContainText(/met$/);
    await expect(criterion.nth(1)).toContainText("A2");
    await expect(criterion.nth(1)).toContainText("no test reloads the app");
    await expect(criterion.nth(1)).toContainText(/unverified$/);
    // An unverified criterion stands out from a met one.
    await expect(criterion.nth(1)).toHaveClass(/border-amber-400/);
    await expect(criterion.nth(0)).not.toHaveClass(/border-amber-400/);
    await expect(card).toContainText("judge round 2: 1 met · 1 unverified");

    const routePart = detail.getByRole("region", { name: /^Route/ });
    await expect(routePart).toContainText("approved");
    await expect(routePart).toContainText("Sectorsui, motion");
    await expect(routePart).toContainText(
      "design-system, react-patterns (spine: rivetari-core)",
    );
    await expect(routePart).toContainText(
      "Gapsno vendored skill covers motion",
    );
    await expect(routePart).toContainText(
      "skill design-system matches sector ui",
    );

    const plan = detail.getByRole("region", { name: "Plan" });
    await expect(plan.getByRole("listitem")).toHaveText([
      "Add a theme toggle to the header",
      "Keep the choice in settings",
      "Test both themes",
    ]);

    const proof = detail.getByRole("region", { name: /^Proof/ });
    await expect(proof).toContainText("Passed · ui-screenshots");
    await expect(proof.getByText(R25)).toBeVisible();
    const shots = proof.getByRole("list", { name: "Screenshots" });
    await expect(shots.getByRole("img")).toHaveCount(2);
    await expect(
      shots.getByRole("img", { name: "after screenshot of / at lg" }),
    ).toBeVisible();
    await expect(shots).toContainText("after · / · lg · HTTP 200 · 640×400");
    await expect(shots).toContainText("after-home-lg.png");
    await expect(proof).toContainText("region");
    await expect(proof).toContainText("moderate");
    await expect(proof).toContainText(
      "src/theme/toggle.test.ts: keeps the choice",
    );
    await proof.getByText("test-run.txt").click();
    await expect(proof.getByLabel("test-run.txt")).toContainText("12 passed");

    const judge = detail.getByRole("region", { name: /^Judge/ });
    await expect(judge).toContainText("verdict: needs a human (round 2)");
    const rounds = judge.getByRole("article");
    await expect(rounds).toHaveCount(2);
    await expect(rounds.nth(0)).toContainText("Round 1: failed");
    await expect(rounds.nth(0)).toContainText("Tier 1: pass");
    await expect(rounds.nth(0)).toContainText(
      "pre-existing quality.tests.pass — 1 failing test fails on the base too",
    );
    await expect(rounds.nth(0)).toContainText("Blocking (1)");
    await expect(rounds.nth(0)).toContainText(
      "[defect] The toggle forgets the choice on reload src/theme/toggle.tsx:14",
    );
    await expect(rounds.nth(0)).toContainText("A2 unmet — the choice is lost");
    await expect(rounds.nth(1)).toContainText("Round 2: needs a human");
    await expect(rounds.nth(1)).toContainText("Suggestions (1)");
    await expect(rounds.nth(1)).toContainText("Name the storage key once");

    await expect(
      detail.getByRole("region", { name: "Pull request" }),
    ).toContainText("No PR yet");
    await expect(
      panel.getByRole("list", { name: "T-0004 ledger" }),
    ).toContainText("judge needs a human · round 2");

    // The tab scrolls inside its pane, so each part is shot in view.
    for (const [name, part] of [
      ["detail-summary", detail.getByRole("heading", { name: /T-0004/ })],
      ["detail-card-route", card],
      ["detail-proof", proof],
      ["detail-judge", judge],
    ] as const) {
      await part.evaluate((el) => el.scrollIntoView({ block: "start" }));
      await shot(page, name);
    }
    expect(await runAxe(page), "task detail").toEqual([]);

    // The shipped task: a person checked A2 by hand, and its PR is linked.
    await column("ship").getByRole("button").click();
    const shipped = panel.getByRole("region", { name: /T-0005/ });
    const shippedCriteria = shipped
      .getByRole("list", { name: "Acceptance criteria" })
      .getByRole("listitem");
    await expect(shippedCriteria.nth(0)).toContainText(/met$/);
    await expect(shippedCriteria.nth(1)).toContainText(/hand-checked$/);
    await expect(shippedCriteria.nth(1)).toContainText(
      "allowed by ann@example.com: checked it on my machine",
    );
    const pr = shipped.getByRole("region", { name: "Pull request" });
    await expect(pr.getByRole("link", { name: "PR #42" })).toHaveAttribute(
      "href",
      "https://github.com/arynbht/example/pull/42",
    );
    await expect(pr).toContainText("sign in to see the PR's state and checks");
    await shot(page, "detail-shipped");
    expect(await runAxe(page), "shipped task detail").toEqual([]);

    // The list is still there, a toggle away.
    await toggle.getByRole("button", { name: "List" }).click();
    await expect(
      panel.getByRole("region", { name: "All tasks" }).locator("tbody tr"),
    ).toHaveCount(7);
    await expect(
      panel.getByRole("region", { name: "Board", exact: true }),
    ).toHaveCount(0);
  });

  test("a Now item opens its task's detail", async () => {
    const { page } = await openTasks();
    await page.getByRole("tab", { name: "Now" }).click();
    const nowPanel = page.locator("#panel-now");
    await nowPanel
      .getByRole("article", { name: /T-0002/ })
      .getByRole("button", { name: "Open T-0002 in Tasks" })
      .click();
    await expect(page.getByRole("tab", { name: "Tasks" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const detail = page
      .locator("#panel-tasks")
      .getByRole("region", { name: /T-0002/ });
    const route = detail.getByRole("region", { name: /^Route/ });
    await expect(route).toContainText("waiting for approval");
    await expect(route).toContainText("no vendored skill covers motion");
    await expect(
      detail
        .getByRole("list", { name: "Acceptance criteria" })
        .getByRole("listitem")
        .first(),
    ).toContainText(/not judged$/);
  });
});
