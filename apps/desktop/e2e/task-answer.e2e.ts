import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { closeApp, launchApp, type LaunchedApp, runAxe } from "./helpers";
import { LEDGER_KEY, tasksRepo } from "./tasks-fixture";

// Tasks tab actions: answering a stop (allow or deny, with a note) through the
// main process and the runtime, and opening a shipped task's PR. The fixture
// repo is made a git repo with its own user, so the answer is recorded under
// that name and pushed to its local rivetari/tasks branch, as the CLI would.

const WHO = "e2e@example.com";

function answerRepo() {
  const fixture = tasksRepo();
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: fixture.repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", WHO);
  git("config", "user.name", "E2E");
  git("commit", "-q", "--allow-empty", "-m", "init");
  return fixture;
}

/**
 * Put a task on the rivetari/tasks branch as its holder last pushed it, so its
 * lease is one the runtime honours (it reads leases from the branch).
 */
function pushTask(repo: string, id: string) {
  const env = {
    ...process.env,
    GIT_INDEX_FILE: join(repo, ".git", "e2e-index"),
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", env }).trim();
  git("--work-tree", join(repo, ".rivetari", "tasks"), "add", "-f", id);
  const tree = git("write-tree");
  const commit = git("commit-tree", tree, "-m", `${id}: build`);
  git("update-ref", "refs/heads/rivetari/tasks", commit);
}

function lastEntry(repo: string, id: string): { text: string; by: string } {
  const lines = readFileSync(
    join(repo, ".rivetari", "tasks", id, "ledger.jsonl"),
    "utf8",
  )
    .trim()
    .split("\n");
  return JSON.parse(lines.at(-1) ?? "{}") as { text: string; by: string };
}

async function openTasks(page: Page) {
  await page
    .getByRole("button", { name: /tasks-repo/ })
    .first()
    .click();
  await page.getByRole("tab", { name: "Tasks" }).click();
  return page.locator("#panel-tasks");
}

test.describe("task actions", () => {
  let launched: LaunchedApp | undefined;
  let repo: string | undefined;

  test.afterEach(async () => {
    if (launched) await closeApp(launched);
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  test("denies a stop with a note: the ledger gains the answer and the task leaves Needs you", async () => {
    const testInfo = test.info();
    const fixture = answerRepo();
    repo = fixture.repo;
    launched = await launchApp({
      repos: [{ path: repo, name: "tasks-repo" }],
      env: { RIVETARI_LEDGER_KEY: LEDGER_KEY },
    });
    const { page } = launched;
    const panel = await openTasks(page);

    const needsYou = panel.getByRole("region", { name: "Needs you" });
    await needsYou.getByRole("button", { name: /T-0002/ }).click();
    const form = panel.getByRole("form", { name: "Answer the stop" });
    await expect(form).toContainText("dependency: adds @radix-ui/react-switch");
    await form.getByLabel(/Note/).fill("use a native checkbox instead");

    await page.screenshot({ path: testInfo.outputPath("answer-before.png") });
    await testInfo.attach("answer-before", {
      path: testInfo.outputPath("answer-before.png"),
      contentType: "image/png",
    });
    expect(await runAxe(page), "answer form").toEqual([]);

    await form.getByRole("button", { name: "Deny" }).click();

    const detail = panel.getByRole("region", { name: /T-0002/ });
    await expect(detail.getByRole("status")).toContainText(
      `T-0002 denied by ${WHO}`,
    );
    // The watcher sees the answer: nothing waits on a person, and the form goes.
    await expect(needsYou).toContainText("No task is waiting on a person.");
    await expect(form).toHaveCount(0);
    await expect(
      panel.getByRole("list", { name: "T-0002 ledger" }),
    ).toContainText("answered: denied — use a native checkbox instead");

    expect(lastEntry(repo, "T-0002")).toMatchObject({
      text: "answered: denied — use a native checkbox instead",
      by: WHO,
    });
    const branch = execFileSync(
      "git",
      ["show", "rivetari/tasks:T-0002/ledger.jsonl"],
      { cwd: repo, encoding: "utf8" },
    );
    expect(branch).toContain("answered: denied");

    await page.screenshot({ path: testInfo.outputPath("answer-after.png") });
    await testInfo.attach("answer-after", {
      path: testInfo.outputPath("answer-after.png"),
      contentType: "image/png",
    });
    expect(await runAxe(page), "answered").toEqual([]);
  });

  test("allows a stop, shows a refused answer inline, and opens a shipped task's PR", async () => {
    const fixture = answerRepo();
    repo = fixture.repo;
    // The running task asks too, but someone else holds its lease.
    fixture.running.append(["build", "stop", "asked: schema: adds a column"]);
    pushTask(repo, "T-0001");
    launched = await launchApp({
      repos: [{ path: repo, name: "tasks-repo" }],
      env: { RIVETARI_LEDGER_KEY: LEDGER_KEY },
    });
    const { page } = launched;
    const panel = await openTasks(page);
    const needsYou = panel.getByRole("region", { name: "Needs you" });
    await expect(needsYou.getByRole("button")).toHaveCount(2);

    // Refused by the runtime: the error shows in place and the task still waits.
    await needsYou.getByRole("button", { name: /T-0001/ }).click();
    const running = panel.getByRole("region", { name: /T-0001/ });
    await running.getByRole("button", { name: "Allow" }).click();
    await expect(running.getByRole("alert")).toContainText("build-box");
    await expect(needsYou.getByRole("button")).toHaveCount(2);

    await needsYou.getByRole("button", { name: /T-0002/ }).click();
    const stopped = panel.getByRole("region", { name: /T-0002/ });
    await stopped.getByLabel(/Note/).fill("fine by me");
    const allow = stopped.getByRole("button", { name: "Allow" });
    await allow.click();
    await expect(stopped.getByRole("status")).toContainText(
      `T-0002 allowed by ${WHO}`,
    );
    await expect(needsYou.getByRole("button")).toHaveCount(1);
    expect(lastEntry(repo, "T-0002")).toMatchObject({
      text: "answered: allowed — fine by me",
      by: WHO,
    });

    // The PR opens in the browser from the main process (a no-op under E2E).
    await panel
      .getByRole("group", { name: "Show tasks as" })
      .getByRole("button", { name: "List" })
      .click();
    await panel
      .getByRole("region", { name: "All tasks" })
      .getByRole("button", { name: /T-0003/ })
      .click();
    const shipped = panel.getByRole("region", { name: /T-0003/ });
    await shipped.getByRole("link", { name: "PR #42" }).click();
    await expect(shipped.getByRole("status")).toContainText(
      "Opened https://github.com/arynbht/example/pull/42 in your browser.",
    );
  });
});
