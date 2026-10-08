import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { rows, detail } from "../tests/fixtures/design.mjs";
const temp = await mkdtemp(join(tmpdir(), "catcoon-design-"));
const port = 3138,
  base = `http://localhost:${port}`;
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
let browser;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + "/api/issues")).ok) break;
    } catch {}
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
  let stopped = false;
  let binding = false;
  await page.route("**/api/issues**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/stop")) {
      stopped = true;
      return route.fulfill({ json: { ...detail, status: "stopped" } });
    }
    const d = binding
      ? { ...detail, status: "ready" }
      : stopped
        ? {
            ...detail,
            status: "stopped",
            currentTurnId: null,
            activities: [
              {
                id: "stopped",
                issueId: detail.id,
                actor: "Elliot",
                type: "stop",
                summary: "Stopped Issue workflow",
                detail:
                  "Automatic dispatch is stopped. Checklist and Agent sessions are preserved.",
                createdAt: detail.createdAt,
              },
              ...detail.activities,
            ],
          }
        : detail;
    return route.fulfill({ json: url.pathname === "/api/issues" ? rows : d });
  });
  await page.goto(base);
  await page.getByText("8 issues", { exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(500, 315);
  await page.screenshot({ path: "/tmp/catcoon-ui-list.png" });
  await page
    .getByRole("button", { name: "Build the Issue workspace", exact: true })
    .click();
  await page.getByRole("button", { name: "Open chat", exact: true }).waitFor();
  await page.mouse.move(1400, 900);
  await page.screenshot({ path: "/tmp/catcoon-ui-detail.png" });
  const geometry = await page.evaluate(() =>
    Object.fromEntries(
      [
        ".sidebar",
        ".topbar",
        ".detail-layout",
        ".title-row",
        ".metadata",
        ".description",
        ".running-card",
        ".activity-heading",
        ".binding-card",
      ].map((s) => {
        const r = document.querySelector(s).getBoundingClientRect();
        return [s, { x: r.x, y: r.y, width: r.width, height: r.height }];
      }),
    ),
  );
  console.log(JSON.stringify(geometry));
  assert.equal(geometry[".sidebar"].width, 232);
  assert.equal(geometry[".topbar"].height, 64);
  assert.equal(geometry[".title-row"].x, 256);
  assert.equal(geometry[".title-row"].y, 88);
  assert.equal(geometry[".binding-card"].width, 336);
  assert.equal(geometry[".binding-card"].x, 1080);
  binding = true;
  await page.reload();
  await page.getByRole("button", { name: "+ Add", exact: true }).click();
  await page.getByLabel("Agent runtime").selectOption("pi");
  await page
    .getByLabel("Agent description")
    .fill("Import API design into Apifox.");
  await page.mouse.move(1400, 900);
  await page.screenshot({ path: "/tmp/catcoon-ui-bind.png" });
  const box = await page.locator("dialog").boundingBox();
  console.log("Binding dialog", box);
  assert.equal(box.width, 560);
  assert.equal(box.x, 440);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  binding = false;
  await page.reload();
  await page
    .getByRole("button", {
      name: "Inspect Assigned backend implementation to Codex",
      exact: true,
    })
    .click();
  await page.screenshot({ path: "/tmp/catcoon-ui-decision.png" });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Open chat", exact: true }).click();
  await page.evaluate(async () => {
    await Promise.all(
      [...document.images].map((i) => i.decode().catch(() => {})),
    );
  });
  assert.ok(
    await page
      .locator(".session-page img")
      .evaluateAll((imgs) =>
        imgs.every((i) => i.complete && i.naturalWidth > 0),
      ),
    "Design icons must load",
  );
  await page.screenshot({ path: "/tmp/catcoon-ui-session.png" });
  assert.equal(await page.locator("dialog").count(), 0);
  const chatBox = await page.locator(".session-page").boundingBox();
  assert.equal(chatBox.width, 800);
  assert.equal(chatBox.x, 436);
  await page.locator(".breadcrumb").click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page
    .locator(".metadata .badge")
    .filter({ hasText: "Stopped" })
    .waitFor();
  await page.screenshot({ path: "/tmp/catcoon-ui-stopped.png" });
  assert.equal(await page.locator(".running-card").count(), 0);
  assert.equal(
    await page
      .locator(
        ".notice,.setup-banner,.status-dot,.sessions-card,.sidebar-bottom",
      )
      .count(),
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Figma layout verification passed for List, Detail, Bind agent, Jev decision, Agent session, and Stopped.",
  );
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise((r) => server.once("exit", r));
  }
  await rm(temp, { recursive: true, force: true });
}
