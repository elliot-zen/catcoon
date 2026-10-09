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
  await page
    .getByRole("button", { name: "Edit Codex binding", exact: true })
    .click();
  await expect(directory).toHaveValue(alternate);
  await directory.fill(project);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".binding-directory")).toHaveText(alternate);
  await page
    .getByRole("button", { name: "Edit Codex binding", exact: true })
    .click();
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
  await page
    .getByRole("button", { name: "Edit Pi binding", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("Approval level", { exact: true }).inputValue(),
    "on-request",
  );
  await expect(directory).toHaveValue(alternate);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByRole("button", { name: "Approve", exact: true }).waitFor();
  await page.screenshot({ path: "/tmp/catcoon-approval.png", fullPage: true });
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page
    .locator(".metadata .badge")
    .filter({ hasText: "Stopped" })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Approve", exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page
    .getByText("Codex · Finished agent turn", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Approve", exact: true }).waitFor();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.locator(".metadata .badge").filter({ hasText: "Done" }).waitFor();
  await page.screenshot({ path: "/tmp/catcoon-detail.png", fullPage: true });
  await page
    .getByRole("button", { name: "Open Pi session", exact: true })
    .click();
  await page
    .getByText("Task completed and verified.", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Issue", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Build the Issue workspace", exact: true })
    .waitFor();
  await page.screenshot({ path: "/tmp/catcoon-list.png", fullPage: true });
  await page
    .getByRole("textbox", { name: "Search issues" })
    .fill("nothing matches");
  await page.getByText("No matching issues", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("textbox", { name: "Search issues" }).fill("");
  await page
    .getByRole("button", { name: "Build the Issue workspace", exact: true })
    .click();
  await page.locator(".metadata .badge").filter({ hasText: "Done" }).waitFor();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Mobile page must not overflow",
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
  await page.screenshot({
    path: "/tmp/catcoon-binding-approval.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Bind agent", exact: true }).click();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page
    .locator(".metadata .badge")
    .filter({ hasText: "Stopped" })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Approve", exact: true }).count(),
    0,
  );
  await page
    .getByRole("button", { name: "Edit Codex binding", exact: true })
    .click();
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
  await page.getByRole("button", { name: "Save binding", exact: true }).click();
  await page.reload();
  await page
    .getByRole("button", { name: "Edit Codex binding", exact: true })
    .click();
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
  await page.locator(".metadata .badge").filter({ hasText: "Done" }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "Browser happy path passed: create → bind Codex/Pi → Start → approval → Stop/Start → approve → handoff → Done; independent directories, validation, failed-submit retention, loading, edit/cancel, persistence, locked sessions, mobile dialog; approval settings, history and search.",
  );
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise((r) => server.once("exit", r));
  }
  await rm(temp, { recursive: true, force: true });
}
