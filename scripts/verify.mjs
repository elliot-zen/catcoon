import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const temp = await mkdtemp(join(tmpdir(), "catcoon-browser-"));
const project = join(temp, "project");
const alternate = join(temp, "a-long-project-directory-" + "x".repeat(100));
const file = join(temp, "file.txt");
await mkdir(project);
await mkdir(alternate);
await writeFile(file, "file");
const port = 3137;
const base = `http://localhost:${port}`;
const server = spawn(
  process.execPath,
  ["--import", "tsx", "tests/browser-server.ts"],
  {
    env: {
      ...process.env,
      PORT: String(port),
      TEST_DB: join(temp, "test.sqlite"),
      TYPESAFE_API_KEY: "test",
      AGENT_WORKSPACE: project,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let stderr = "";
server.stderr.on("data", (c) => (stderr += c));
let browser;
try {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(base + "/api/issues");
      if (r.ok) break;
    } catch {}
    if (i === 99) throw new Error("Server did not start: " + stderr);
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 960 },
  });
  async function bindingAction(agent, action) {
    await page
      .getByRole("button", { name: `${agent} binding actions`, exact: true })
      .click();
    await page.getByRole("menuitem", { name: action, exact: true }).click();
  }
  const readIssue = () =>
    page.evaluate(async () =>
      (
        await fetch("/api/issues/" + decodeURIComponent(location.hash.slice(1)))
      ).json(),
    );
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.getByRole("button", { name: /New issue/ }).click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Build the Issue workspace");
  await page
    .getByLabel("Description", { exact: true })
    .fill(
      "Create a shared workspace for coordinating agents around Issues. Implement the API and have Pi review the result.",
    );
  await page.getByRole("button", { name: "Create issue", exact: true }).click();
  await page.getByRole("button", { name: "+ Add", exact: true }).click();
  assert.equal(
    await page.getByLabel("Approval level", { exact: true }).inputValue(),
    "on-request",
  );
  await page
    .getByLabel("Agent description", { exact: true })
    .fill("Write the backend logic and verify the API.");
  const directory = page.getByLabel("Working directory *", { exact: true });
  await expect(directory).toHaveValue(project);
  for (const [value, message] of [
    ["  ", "Working directory is required."],
    ["relative/path", "Enter an absolute path on the agent’s machine."],
  ]) {
    await directory.fill(value);
    await expect(page.getByRole("alert")).toHaveText(message);
    await expect(
      page.getByRole("button", { name: "Bind agent", exact: true }),
    ).toBeDisabled();
  }
  for (const [value, message] of [
    [
      join(temp, "missing"),
      "Directory not found. Enter an existing directory.",
    ],
    [file, "This path is a file. Enter a directory."],
  ]) {
    await directory.fill(value);
    await page.getByRole("button", { name: "Bind agent", exact: true }).click();
    await expect(page.locator("#directory-error")).toHaveText(message);
    await expect(directory).toHaveValue(value);
    await expect(
      page.getByLabel("Agent description", { exact: true }),
    ).toHaveValue("Write the backend logic and verify the API.");
    if (value === join(temp, "missing"))
      await page.screenshot({
        path: "/tmp/catcoon-directory-error.png",
        fullPage: true,
      });
  }
  await directory.fill(alternate);
  await page.getByLabel("Agent runtime").selectOption("pi");
  await expect(directory).toHaveValue(alternate);
  await page.getByLabel("Agent runtime").selectOption("codex");
  await page.route("**/bindings", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.continue();
  });
  await page.getByRole("button", { name: "Bind agent", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Binding…", exact: true }),
  ).toBeDisabled();
  await expect(directory).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.unroute("**/bindings");
  await expect(page.locator(".binding-directory")).toHaveText(alternate);
  await bindingAction("Codex", "Edit Codex binding");
  await expect(directory).toHaveValue(alternate);
  await directory.fill(project);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".binding-directory")).toHaveText(alternate);
  await bindingAction("Codex", "Edit Codex binding");
  await directory.fill(project);
  await page.getByRole("button", { name: "Save binding", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".binding-directory")).toHaveText(project);
  await page.getByRole("button", { name: "+ Add", exact: true }).click();
  await page.getByLabel("Agent runtime").selectOption("pi");
  assert.equal(
    await page.getByLabel("Approval level", { exact: true }).inputValue(),
    "strict",
  );
  await page
    .getByLabel("Approval level", { exact: true })
    .selectOption("on-request");
  await page
    .getByLabel("Agent description")
    .fill("Review the implementation and verify the complete happy path.");
  await expect(directory).toHaveValue(project);
  await directory.fill(alternate);
  await page.setViewportSize({ width: 390, height: 520 });
  assert.ok(
    await page.evaluate(() => {
      const dialog = document.querySelector("dialog");
      const box = dialog.getBoundingClientRect();
      return (
        box.x >= 16 &&
        box.right <= innerWidth - 16 &&
        box.y >= 16 &&
        box.bottom <= innerHeight - 16
      );
    }),
    "Binding dialog must remain within the mobile viewport",
  );
  await page
    .getByRole("button", { name: "Bind agent", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "/tmp/catcoon-directory-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("button", { name: "Bind agent", exact: true }).click();
  await expect(page.locator(".binding-directory")).toHaveText([
    project,
    alternate,
  ]);
  await page.screenshot({
    path: "/tmp/catcoon-directory-card.png",
    fullPage: true,
  });
  await bindingAction("Pi", "Edit Pi binding");
  assert.equal(
    await page.getByLabel("Approval level", { exact: true }).inputValue(),
    "on-request",
  );
  await expect(directory).toHaveValue(alternate);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Pi binding actions", exact: true })
    .click();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("menu").count(), 0);
  assert.equal(
    await page
      .getByRole("button", { name: "Pi binding actions", exact: true })
      .evaluate((button) => button === document.activeElement),
    true,
  );
  await bindingAction("Pi", "Open Pi session");
  await page.getByText("No session history yet.", { exact: true }).waitFor();
  await page.locator(".breadcrumb").click();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByRole("button", { name: "Approve", exact: true }).waitFor();
  const beforeEdit = await readIssue();
  await page.getByRole("button", { name: "Edit issue", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Title", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("textbox", { name: "Description", exact: true })
    .fill(
      "Updated goal while awaiting approval. Implement the API and have Pi review the result.",
    );
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator(".description p")).toHaveText(
    "Updated goal while awaiting approval. Implement the API and have Pi review the result.",
  );
  const afterEdit = await readIssue();
  assert.equal(afterEdit.status, "waiting_human");
  assert.equal(afterEdit.currentTurnId, beforeEdit.currentTurnId);
  assert.deepEqual(afterEdit.requests, beforeEdit.requests);
  await expect(
    page.getByRole("button", { name: "Approve", exact: true }),
  ).toBeVisible();
  assert.equal(await page.locator(".comment-composer").count(), 0);
  const humanRequest = page.getByRole("region", {
    name: "Human request",
    exact: true,
  });
  assert.ok(
    (await humanRequest.boundingBox()).y <
      (await page.locator(".title-row").boundingBox()).y,
    "Human request must appear above the issue title and activity",
  );
  await page
    .getByLabel("Filter activity", { exact: true })
    .selectOption("System");
  assert.equal(
    await humanRequest
      .getByRole("button", { name: "Approve", exact: true })
      .count(),
    1,
    "Activity filtering must not hide approval controls",
  );
  await page.getByLabel("Filter activity", { exact: true }).selectOption("all");
  await page
    .getByRole("button", { name: "Codex binding actions", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("menuitem", { name: "Edit Codex binding", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByRole("heading", { name: "Activity", exact: true }).click();
  assert.equal(await page.getByRole("menu").count(), 0);
  await page.screenshot({ path: "/tmp/catcoon-approval.png", fullPage: true });
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page
    .locator(".properties-card .badge")
    .filter({ hasText: "Stopped" })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Approve", exact: true }).count(),
    0,
  );
  await bindingAction("Codex", "Edit Codex binding");
  assert.equal(
    await page.getByLabel("Agent runtime", { exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page.getByLabel("Agent description", { exact: true }).isDisabled(),
    true,
  );
  await page
    .getByLabel("Approval level", { exact: true })
    .selectOption("strict");
  await page.getByRole("button", { name: "Save binding", exact: true }).click();
  await page
    .locator(".binding-settings")
    .filter({ hasText: "Strict approval" })
    .waitFor();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page
    .getByText("Codex · Finished agent turn", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Approve", exact: true }).waitFor();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page
    .locator(".properties-card .badge")
    .filter({ hasText: "Done" })
    .waitFor();
  await page.screenshot({ path: "/tmp/catcoon-detail.png", fullPage: true });
  await page.getByRole("button", { name: "Edit issue", exact: true }).click();
  await expect(page.getByLabel("Title", { exact: true })).toBeFocused();
  await page.getByLabel("Title", { exact: true }).fill("Discard this title");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".title-row h1")).toHaveText(
    "Build the Issue workspace",
  );
  await page.getByRole("button", { name: "Edit issue", exact: true }).click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Updated Issue workspace");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.reload();
  await expect(page.locator(".title-row h1")).toHaveText(
    "Updated Issue workspace",
  );
  await expect(page.locator(".properties-card .badge")).toHaveText("Done");
  await expect(
    page.locator(".issue-title .issue-edit .lucide-square-pen"),
  ).toHaveCount(1);
  await expect(page.locator(".description .issue-edit")).toHaveCount(0);
  await expect(page.locator('img[src^="/assets/"]')).toHaveCount(0);
  await bindingAction("Pi", "Open Pi session");
  await page
    .getByText("Task completed and verified.", { exact: true })
    .waitFor();
  const composer = page.getByRole("textbox", {
    name: "Message Pi",
    exact: true,
  });
  await composer.fill("解释当前实现");
  await composer.press("Shift+Enter");
  await composer.pressSequentially("Next steps");
  const chatDraft = await composer.inputValue();
  assert.equal(chatDraft, "解释当前实现\nNext steps");
  await composer.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
  });
  assert.equal(
    await composer.inputValue(),
    chatDraft,
    "IME Enter must not send a message",
  );
  await page.route(
    "**/bindings/*/messages",
    async (route) => {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "Chat test rejection" }),
      });
    },
    { times: 1 },
  );
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Chat test rejection" })
    .waitFor();
  assert.equal(
    await composer.inputValue(),
    chatDraft,
    "Failed sends must preserve the draft",
  );
  await composer.press("Enter");
  await page
    .locator(".session-notice")
    .filter({ hasText: "human decision" })
    .waitFor();
  assert.equal(await composer.inputValue(), "");
  await page.locator(".task-message").filter({ hasText: chatDraft }).waitFor();
  await composer.fill("Draft while awaiting approval");
  assert.equal(
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "Open issue", exact: true }).click();
  await humanRequest
    .getByRole("button", { name: "Approve", exact: true })
    .click();
  await page
    .locator(".properties-card .badge")
    .filter({ hasText: "Done" })
    .waitFor();
  await page.reload();
  await bindingAction("Pi", "Open Pi session");
  await page.locator(".task-message").filter({ hasText: chatDraft }).waitFor();
  await page
    .getByRole("button", { name: "Issue", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Updated Issue workspace", exact: true })
    .waitFor();
  await page.screenshot({ path: "/tmp/catcoon-list.png", fullPage: true });
  await page
    .getByRole("textbox", { name: "Search issues" })
    .fill("nothing matches");
  await page.getByText("No matching issues", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("textbox", { name: "Search issues" }).fill("");
  await page
    .getByRole("button", { name: "Updated Issue workspace", exact: true })
    .click();
  await page
    .locator(".properties-card .badge")
    .filter({ hasText: "Done" })
    .waitFor();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Mobile page must not overflow",
  );
  const mobileTitle = await page.locator(".issue-title").boundingBox();
  const mobileActions = await page.locator(".workflow-actions").boundingBox();
  assert.ok(
    mobileActions.y >= mobileTitle.y + mobileTitle.height,
    "Mobile workflow controls must leave room for the title and edit icon",
  );
  await page.screenshot({ path: "/tmp/catcoon-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page
    .getByRole("button", { name: "Issue", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: /New issue/ }).click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Change approval after execution");
  await page
    .getByLabel("Description", { exact: true })
    .fill(
      "Verify persisted approval settings and edit access with session history.",
    );
  await page.getByRole("button", { name: "Create issue", exact: true }).click();
  await page.getByRole("button", { name: "+ Add", exact: true }).click();
  await page
    .getByLabel("Agent description", { exact: true })
    .fill("Verify approval changes");
  await page
    .getByLabel("Approval level", { exact: true })
    .selectOption("automatic");
  assert.equal(
    await page.locator("#approval-runtime").textContent(),
    "Codex · Full access; sandbox disabled.",
  );
  assert.equal(
    await page
      .locator('select[aria-label="Approval level"] option:checked')
      .textContent(),
    "Fully automatic",
  );
  await page.screenshot({
    path: "/tmp/catcoon-binding-approval.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Bind agent", exact: true }).click();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page
    .locator(".properties-card .badge")
    .filter({ hasText: "Stopped" })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Approve", exact: true }).count(),
    0,
  );
  await bindingAction("Codex", "Edit Codex binding");
  assert.equal(
    await page.getByLabel("Approval level", { exact: true }).inputValue(),
    "automatic",
  );
  await expect(directory).toHaveAttribute("readonly", "");
  await expect(directory).toHaveValue(project);
  await expect(page.locator("#directory-help")).toHaveText(
    "This session uses the saved directory. Bind a new agent to choose another directory.",
  );
  await page
    .getByLabel("Approval level", { exact: true })
    .selectOption("strict");
  assert.match(
    await page.locator("#approval-runtime").textContent(),
    /Sandbox restrictions enabled/,
  );
  await page.getByRole("button", { name: "Save binding", exact: true }).click();
  await page.reload();
  await bindingAction("Codex", "Edit Codex binding");
  assert.equal(
    await page.getByLabel("Approval level", { exact: true }).inputValue(),
    "strict",
  );
  await page.screenshot({
    path: "/tmp/catcoon-binding-strict.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByRole("button", { name: "Approve", exact: true }).waitFor();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page
    .locator(".properties-card .badge")
    .filter({ hasText: "Done" })
    .waitFor();
  await page
    .getByRole("button", { name: "Issue", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: /New issue/ }).click();
  await page.getByLabel("Title", { exact: true }).fill("Standalone chat");
  await page
    .getByLabel("Description", { exact: true })
    .fill("Check manual chat and active steering without automatic routing.");
  await page.getByRole("button", { name: "Create issue", exact: true }).click();
  await page.getByRole("button", { name: "+ Add", exact: true }).click();
  await page
    .getByLabel("Agent description", { exact: true })
    .fill("Discuss the implementation");
  await page
    .getByLabel("Approval level", { exact: true })
    .selectOption("automatic");
  await page.getByRole("button", { name: "Bind agent", exact: true }).click();
  await bindingAction("Codex", "Open Codex session");
  await page
    .getByRole("textbox", { name: "Message Codex", exact: true })
    .fill("Explain this workspace");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page
    .locator(".task-message")
    .filter({ hasText: "Explain this workspace" })
    .waitFor();
  await page
    .getByRole("textbox", { name: "Message Codex", exact: true })
    .fill("Focus on tests");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByText("Received: Focus on tests", { exact: true }).waitFor();
  await page
    .locator(".session-header .badge")
    .filter({ hasText: "Stopped" })
    .waitFor();
  await page.getByText("Automatic work completed.", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .isDisabled(),
    true,
  );
  await page.locator(".breadcrumb").click();
  assert.equal(
    await page.locator(".activity").filter({ hasText: "Jev ·" }).count(),
    0,
    "Standalone chat must not start automatic routing",
  );
  await page.reload();
  await bindingAction("Codex", "Open Codex session");
  await page
    .locator(".task-message")
    .filter({ hasText: "Explain this workspace" })
    .waitFor();
  await page
    .locator(".task-message")
    .filter({ hasText: "Focus on tests" })
    .waitFor();
  await page.screenshot({ path: "/tmp/catcoon-chat.png", fullPage: true });
  await page
    .getByRole("button", { name: "Issue", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: /New issue/ }).click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Human answer placement");
  await page
    .getByLabel("Description", { exact: true })
    .fill("Human questions stay above a long activity history.");
  await page.getByRole("button", { name: "Create issue", exact: true }).click();
  await page.getByRole("button", { name: "+ Add", exact: true }).click();
  await page
    .getByLabel("Agent description", { exact: true })
    .fill("Execute after clarification");
  await page
    .getByLabel("Approval level", { exact: true })
    .selectOption("automatic");
  await page.getByRole("button", { name: "Bind agent", exact: true }).click();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await humanRequest
    .getByRole("button", { name: "Submit answer", exact: true })
    .waitFor();
  assert.ok((await page.locator(".activity").count()) >= 60);
  await page
    .getByLabel("Filter activity", { exact: true })
    .selectOption("Human");
  assert.equal(
    await humanRequest
      .getByRole("button", { name: "Submit answer", exact: true })
      .count(),
    1,
  );
  assert.ok(
    (await humanRequest.boundingBox()).y < 300,
    "Human answer stays visible at the top even with many activities",
  );
  await page.screenshot({
    path: "/tmp/catcoon-human-request.png",
    fullPage: true,
  });
  await humanRequest
    .getByRole("textbox", { name: "Your answer", exact: true })
    .fill("Use the local workspace");
  await humanRequest
    .getByRole("button", { name: "Submit answer", exact: true })
    .click();
  await page
    .locator(".properties-card .badge")
    .filter({ hasText: "Done" })
    .waitFor();
  assert.equal(await humanRequest.count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "Browser happy path passed: workflow and approvals, issue editing during approval and after completion, save/cancel/reload, Lucide icons, binding policies and menus, independent directories and validation, locked sessions, session chat/steering and persistence, failed-submit draft retention, IME/multiline input, Human requests above activity, search and mobile layout.",
  );
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise((r) => server.once("exit", r));
  }
  await rm(temp, { recursive: true, force: true });
}
