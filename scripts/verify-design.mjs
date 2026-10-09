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
  let sessionCase = null;
  await page.route("**/api/issues**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/stop")) {
      stopped = true;
      return route.fulfill({ json: { ...detail, status: "stopped" } });
    }
    const d =
      sessionCase ||
      (binding
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
          : detail);
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
        ".properties-card",
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
  assert.equal(geometry[".properties-card"].x, 1080);
  assert.ok(geometry[".properties-card"].y < geometry[".binding-card"].y);
  assert.equal(
    await page.locator(".detail-main .badge").count(),
    0,
    "Issue properties move out of the main column",
  );
  const properties = page.getByRole("region", {
    name: "Issue properties",
    exact: true,
  });
  for (const label of ["Status", "Folder", "Created by", "Created", "Updated"])
    assert.equal(
      await properties
        .locator("dt")
        .filter({ hasText: new RegExp(`^${label}$`) })
        .count(),
      1,
    );
  assert.ok(
    await properties.getByText("Agent platform", { exact: true }).isVisible(),
  );
  const statuses = [
    "waiting_binding",
    "ready",
    "routing",
    "running",
    "waiting_human",
    "stopping",
    "stopped",
    "done",
  ];
  const colors = await page.evaluate((states) => {
    const badge = document.querySelector(".properties-card .badge");
    const original = badge.className;
    const colors = states.map((status) => {
      badge.className = `badge badge-${status}`;
      return getComputedStyle(badge).backgroundColor;
    });
    badge.className = original;
    return colors;
  }, statuses);
  assert.equal(
    new Set(colors).size,
    statuses.length,
    "Each issue state has a distinct badge color",
  );
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
  assert.equal(chatBox.width, 960);
  assert.equal(chatBox.x, 356);
  await page.locator(".breadcrumb").click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page
    .locator(".properties-card .badge")
    .filter({ hasText: "Stopped" })
    .waitFor();
  await page.screenshot({ path: "/tmp/catcoon-ui-stopped.png" });
  await page
    .getByRole("button", { name: "Codex binding actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Edit Codex binding", exact: true })
    .waitFor();
  await page.screenshot({ path: "/tmp/catcoon-ui-binding-menu.png" });
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".running-card").count(), 0);
  assert.equal(
    await page
      .locator(
        ".notice,.setup-banner,.status-dot,.sessions-card,.sidebar-bottom",
      )
      .count(),
    0,
  );
  // Exercise the live response lifecycle and final tool/answer ordering.
  const startedAt = new Date().toISOString();
  const baseTurn = {
    ...detail.turns.at(-1),
    startedAt,
    input: "Task: 查看一下对应 Issue\n\nExecution mode: Test",
    output: "",
    endedAt: null,
  };
  const user = {
    id: 100,
    turnId: baseTurn.id,
    kind: "user",
    text: "查看一下对应 Issue",
    createdAt: startedAt,
  };
  sessionCase = {
    ...detail,
    status: "running",
    currentTurnId: baseTurn.id,
    turns: [baseTurn],
    messages: [user],
  };
  async function openSessionCase() {
    await page.goto(base + "/#" + detail.id);
    await page.reload();
    await page
      .getByRole("button", { name: "Codex binding actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Open Codex session", exact: true })
      .click();
  }
  await openSessionCase();
  await page.getByText("Thinking…", { exact: true }).waitFor();
  assert.equal(
    await page
      .locator(".thinking > span")
      .evaluate((el) => getComputedStyle(el).animationName),
    "thinking-pulse",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await page
      .locator(".thinking > span")
      .evaluate((el) => getComputedStyle(el).animationName),
    "none",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.screenshot({ path: "/tmp/catcoon-session-thinking.png" });
  const toolStart = {
    id: 101,
    turnId: baseTurn.id,
    kind: "tool",
    text: JSON.stringify({
      id: "issues",
      type: "mcpToolCall",
      tool: "Looked at issues",
      status: "inProgress",
    }),
    createdAt: startedAt,
  };
  sessionCase.messages = [user, toolStart];
  await openSessionCase();
  const working = page.locator(".turn-heading");
  await page
    .getByRole("button", { name: /Working for \d+ s, hide tool activity/ })
    .waitFor();
  const before = await working.textContent();
  await page.waitForFunction(
    (text) => document.querySelector(".turn-heading").textContent !== text,
    before,
  );
  await page.screenshot({ path: "/tmp/catcoon-session-working.png" });
  const answer = "Lureplant 目前没有未归档的 issue";
  const endedAt = new Date(Date.parse(startedAt) + 5000).toISOString();
  sessionCase = {
    ...sessionCase,
    status: "stopped",
    currentTurnId: null,
    turns: [{ ...baseTurn, status: "completed", output: answer, endedAt }],
    messages: [
      user,
      toolStart,
      {
        ...toolStart,
        id: 102,
        text: JSON.stringify({
          id: "issues",
          type: "mcpToolCall",
          status: "completed",
        }),
      },
    ],
  };
  await openSessionCase();
  const collapse = page.getByRole("button", {
    name: "Worked for 5 s, hide tool activity",
    exact: true,
  });
  await collapse.waitFor();
  assert.equal(
    await page.locator(".session-tool").count(),
    1,
    "Tool start/end must render as one updated call",
  );
  const toolBounds = await page.locator(".tool-trace").boundingBox();
  const answerBounds = await page
    .getByText(answer, { exact: true })
    .boundingBox();
  assert.ok(
    toolBounds.y < answerBounds.y,
    "Tool activity must precede the answer",
  );
  const bubble = await page.locator(".task-message").boundingBox();
  assert.ok(bubble.width < 400, "Short user messages should fit their content");
  assert.ok(bubble.x + bubble.width > 1200, "User messages align to the right");
  await page.screenshot({ path: "/tmp/catcoon-session-worked.png" });
  await collapse.click();
  assert.equal(await page.locator(".tool-trace").count(), 0);
  assert.ok(
    await page.getByText(answer, { exact: true }).isVisible(),
    "Collapsing tool activity must keep the answer visible",
  );
  await page
    .getByRole("button", {
      name: "Worked for 5 s, show tool activity",
      exact: true,
    })
    .click();
  await page.locator(".session-tool summary").click();
  assert.ok(await page.locator(".session-tool pre").isVisible());
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.__copiedAnswer = text;
        },
      },
    });
  });
  await page.getByRole("button", { name: "Copy answer", exact: true }).click();
  await page
    .getByRole("button", { name: "Answer copied", exact: true })
    .waitFor();
  assert.equal(await page.evaluate(() => window.__copiedAnswer), answer);
  assert.deepEqual(errors, []);
  console.log(
    "Layout verification passed for List, Detail, Bind agent, Jev decision, Agent session, and Stopped; Thinking animation, live Working timer, fixed Worked duration, tool/answer order, collapse and copy.",
  );
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise((r) => server.once("exit", r));
  }
  await rm(temp, { recursive: true, force: true });
}
