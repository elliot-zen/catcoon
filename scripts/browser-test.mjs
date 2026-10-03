import { chromium, expect } from "@playwright/test";
import { fixture } from "../tests/helpers.ts";
import { createApp } from "../server/index.ts";
import { find, id } from "../server/store.ts";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join, resolve, extname } from "node:path";
import { createServer } from "node:http";
import assert from "node:assert/strict";
const f = fixture(),
  app = createApp(join(f.root, "browser-data"), { worker: false });
app.runtime.recovered = true;
app.store.change((s) => (s.agents = f.state().agents));
await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
const url = "http://127.0.0.1:" + app.server.address().port;
let browser, reference;
const state = () => app.store.read();
const geometry = async (page, selector) => {
  const b = await page.locator(selector).first().boundingBox();
  return selector === "main"
    ? { x: b.x, y: b.y, width: b.width }
    : { x: b.x, y: b.y, width: b.width, height: b.height };
};
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      colorScheme: "light",
    }),
    errors = [],
    dialogs = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    return d.dismiss();
  });
  await page.goto(url);
  await page.getByText("No issues in this view").waitFor();
  await page.getByRole("button", { name: "Create issue", exact: true }).click();
  const create = page.getByRole("dialog");
  await create.getByPlaceholder("Issue title").fill("Browser collaboration");
  await create
    .getByPlaceholder("Add description…")
    .fill("Shared Spec and automatic progress.");
  await create
    .getByRole("button", { name: "Create issue", exact: true })
    .click();
  await page.getByText("No assignments").waitFor();
  for (const name of [
    "Submit task",
    "Publish artifact",
    "Request approval",
    "Request human input",
  ])
    assert.equal(
      await page.getByRole("button", { name, exact: true }).count(),
      0,
    );
  await page
    .locator('textarea[placeholder="Leave a comment…"]')
    .fill("Actual browser comment");
  await page
    .locator('textarea[placeholder="Leave a comment…"]')
    .locator("..")
    .getByRole("button")
    .last()
    .click();
  await page
    .getByText("Actual browser comment", { exact: true })
    .first()
    .waitFor();
  await page
    .getByRole("button", { name: /^Projects/ })
    .first()
    .click();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const projectDialog = page.getByRole("dialog");
  await projectDialog.getByPlaceholder("ab-gateway").fill("Browser Project");
  await projectDialog
    .getByRole("textbox", { name: "Choose a repository folder" })
    .fill(f.repo);
  await projectDialog.getByRole("button", { name: "Browse" }).click();
  await projectDialog
    .getByRole("button", { name: f.repo, exact: true })
    .click();
  await projectDialog.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("button", { name: "New worktree" }).click();
  const wt = page.getByRole("dialog");
  await wt.getByPlaceholder("Retry policy", { exact: true }).fill("Main");
  await wt.getByPlaceholder("feature/retry-policy").fill("main");
  await wt.getByPlaceholder("Agent retry policy").fill("Browser spec");
  await wt.getByRole("textbox", { name: "Choose directory" }).fill(f.repo);
  await wt.getByRole("button", { name: "Create worktree" }).click();
  const product = page.getByRole("textbox", { name: "PRODUCT.md" });
  await expect(product).toHaveValue("");
  await product.fill("# Browser saved product");
  await page.getByText("Saved", { exact: true }).waitFor();
  const spec = state().specs[0];
  assert.equal(spec.draft.product, "# Browser saved product");
  assert.equal(state().specVersions[0].product, "");
  assert.ok(!existsSync(join(f.repo, "docs/PRODUCT.md")));
  await page.getByRole("button", { name: "TECH.md", exact: true }).click();
  const tech = page.getByRole("textbox", { name: "TECH.md" });
  await expect(tech).toHaveValue("");
  await tech.fill("# Browser tech");
  await page.getByText("Saved", { exact: true }).waitFor();
  const newRevision = state().specs[0].draft.revision;
  await fetch(url + "/api/spec", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "Idempotency-Key": id() },
    body: JSON.stringify({
      specId: spec.id,
      document: "tech",
      content: "# External shared draft",
      draftRevision: newRevision,
    }),
  });
  await tech.fill("Keep conflict input");
  await page.getByText(/Save failed \/ Conflict/).waitFor();
  assert.equal(state().specs[0].draft.tech, "# External shared draft");
  await page.getByRole("button", { name: "PRODUCT.md", exact: true }).click();
  await expect(product).toHaveValue("# Browser saved product");
  await page.getByRole("button", { name: "TECH.md", exact: true }).click();
  await expect(tech).toHaveValue("Keep conflict input");
  await page.screenshot({ path: "/tmp/relay-project-detail.png" });
  await page
    .getByRole("button", { name: /^Issues/ })
    .first()
    .click();
  await page
    .getByRole("button", { name: /REL-1.*Browser collaboration/ })
    .click();
  await page.getByRole("button", { name: "Bind agent", exact: true }).click();
  const bind = page.getByRole("dialog");
  await bind.getByRole("button", { name: /^Project / }).click();
  await bind.getByRole("combobox").fill("Browser");
  await bind.getByRole("option", { name: /Browser Project/ }).click();
  await bind
    .getByLabel("Routing instructions")
    .fill("Plan, implement and verify greeting");
  const bindGeometry = await bind.boundingBox();
  await page.screenshot({ path: "/tmp/relay-bind-agent.png" });
  await bind.getByRole("button", { name: "Bind agent", exact: true }).click();
  await expect(bind).toHaveCount(0);
  const issue = state().issues[0],
    binding = state().bindings[0],
    tree = state().worktrees[0];
  assert.equal(issue.status, "Todo");
  assert.equal(state().runs.length, 0);
  await page
    .getByRole("button", { name: "Issue actions", exact: true })
    .click();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  const r = app.runtime.begin(state().tasks[0].id, binding.id, "spec");
  app.runtime.started(r.id, r.sessionId, "browser-turn");
  app.runtime.streams.codex(find(state().runs, r.id), {
    method: "item/started",
    params: {
      item: {
        id: "read",
        type: "commandExecution",
        command: "cat README.md",
        commandActions: [{ type: "read", path: "README.md" }],
      },
    },
  });
  app.runtime.streams.codex(find(state().runs, r.id), {
    method: "item/completed",
    params: {
      item: {
        id: "read",
        type: "commandExecution",
        command: "cat README.md",
        commandActions: [{ type: "read", path: "README.md" }],
        aggregatedOutput: "Fixture",
        exitCode: 0,
      },
    },
  });
  app.runtime.streams.codex(find(state().runs, r.id), {
    method: "item/reasoning/summaryTextDelta",
    params: { itemId: "think", summaryIndex: 0, delta: "Public plan" },
  });
  app.runtime.streams.codex(find(state().runs, r.id), {
    method: "item/agentMessage/delta",
    params: { itemId: "answer", delta: "Streaming first sentence." },
  });
  await page.locator('[data-activity-id="run:' + r.id + '"]').waitFor();
  const row = page.locator('[data-activity-id="run:' + r.id + '"]');
  await expect(
    row.getByText("Streaming first sentence.", { exact: true }),
  ).toHaveCount(0);
  await row.getByRole("button", { name: "Expand event" }).click();
  await expect(row.getByText("Read README.md", { exact: false })).toBeVisible();
  await expect(row.getByText("Public plan", { exact: true })).toBeVisible();
  await expect(
    row.getByText("Streaming first sentence.", { exact: true }),
  ).toBeVisible();
  app.runtime.streams.codex(find(state().runs, r.id), {
    method: "item/agentMessage/delta",
    params: { itemId: "answer", delta: " Second sentence." },
  });
  await expect(
    row.getByText("Streaming first sentence. Second sentence.", {
      exact: true,
    }),
  ).toBeVisible();
  assert.equal(await page.locator('[data-activity-id^="run:"]').count(), 1);
  app.domain.report(
    r.id,
    {
      specProposal: {
        specId: spec.id,
        baseVersionId: tree.specVersionId,
        draftRevision: state().specs[0].draft.revision,
        product: "# Greeting\nProvide a greeting",
        tech: "# Function\nVerify greeting",
        upgradeTargets: [
          {
            worktreeId: tree.id,
            fromVersionId: tree.specVersionId,
            worktreeRevision: tree.revision,
          },
        ],
      },
    },
    id(),
  );
  app.runtime.complete(r.id, true, "Spec is ready for Human approval.", "");
  const request = state().requests[0];
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect
    .poll(() => find(state().requests, request.id).status)
    .toBe("Approved");
  assert.notEqual(state().worktrees[0].specVersionId, tree.specVersionId);
  await page.screenshot({ path: "/tmp/relay-browser.png", fullPage: true });
  await page.reload();
  await page.locator('[data-activity-id="run:' + r.id + '"]').waitFor();
  assert.equal(await page.locator('[data-activity-id^="run:"]').count(), 1);
  const design =
      process.env.UI_DESIGN_DIR || "/home/elliot/workspace/tmp/ui-design",
    refRoot = join(f.root, "reference");
  mkdirSync(join(refRoot, "src"), { recursive: true });
  for (const name of ["App.tsx", "index.css", "main.tsx"])
    writeFileSync(
      join(refRoot, "src", name),
      readFileSync(join(design, "src", name)),
    );
  symlinkSync(resolve("node_modules"), join(refRoot, "node_modules"), "dir");
  writeFileSync(
    join(refRoot, "index.html"),
    '<div id="root"></div><script type="module" src="/src/main.tsx"></script>',
  );
  await build({
    root: refRoot,
    configFile: false,
    plugins: [react(), tailwind()],
    logLevel: "error",
  });
  reference = createServer((req, res) => {
    const file = join(
      refRoot,
      "dist",
      req.url === "/" ? "index.html" : req.url,
    );
    if (!existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    res.setHeader(
      "Content-Type",
      { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" }[
        extname(file)
      ] || "text/plain",
    );
    res.end(readFileSync(file));
  });
  await new Promise((r) => reference.listen(0, "127.0.0.1", r));
  const refPage = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    colorScheme: "light",
  });
  await refPage.goto("http://127.0.0.1:" + reference.address().port);
  await refPage
    .getByText("Add retry policies for failed agent tool calls", {
      exact: true,
    })
    .first()
    .waitFor();
  assert.deepEqual(
    await geometry(page, "aside"),
    await geometry(refPage, "aside"),
  );
  assert.deepEqual(
    await geometry(page, "header"),
    await geometry(refPage, "header"),
  );
  await refPage.getByRole("button", { name: /JEV-142.*Add retry/ }).click();
  assert.deepEqual(
    await geometry(page, "main"),
    await geometry(refPage, "main"),
  );
  await refPage
    .getByRole("button", { name: "Bind agent", exact: true })
    .click();
  const refBox = await refPage.getByRole("dialog").boundingBox();
  assert.equal(bindGeometry.width, refBox.width);
  assert.equal(bindGeometry.height, refBox.height);
  await refPage.screenshot({ path: "/tmp/relay-reference-bind.png" });
  await refPage
    .getByRole("button", { name: "Close bind agent dialog" })
    .click();
  await refPage.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  assert.deepEqual(
    await geometry(page, "main"),
    await geometry(refPage, "main"),
  );
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await page.getByRole("button", { name: "Switch to Chinese" }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator("html")).toHaveClass(/dark/);
  assert.deepEqual(errors, []);
  assert.deepEqual(dialogs, []);
  console.log(
    "Browser passed: design geometry, real directories, system Spec CAS/conflicts, binding, single Activity stream, explicit upgrade approval and preferences.",
  );
} finally {
  await browser?.close();
  if (reference) await new Promise((r) => reference.close(r));
  await app.close();
  f.close();
}
