import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const temp = await mkdtemp(join(tmpdir(), "catcoon-browser-"));
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
  await page
    .getByLabel("Agent description", { exact: true })
    .fill("Write the backend logic and verify the API.");
  await page.getByRole("button", { name: "Bind agent", exact: true }).click();
  await page.getByRole("button", { name: "+ Add", exact: true }).click();
  await page.getByLabel("Agent runtime").selectOption("pi");
  await page
    .getByLabel("Agent description")
    .fill("Review the implementation and verify the complete happy path.");
  await page.getByRole("button", { name: "Bind agent", exact: true }).click();
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
  assert.deepEqual(errors, []);
  console.log(
    "Browser happy path passed: create → bind Codex/Pi → Start → approval → Stop/Start → approve → handoff → Done; session history, search, mobile layout.",
  );
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise((r) => server.once("exit", r));
  }
  await rm(temp, { recursive: true, force: true });
}
