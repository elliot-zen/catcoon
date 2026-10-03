import { chromium, expect } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { createServer } from "node:http";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import assert from "node:assert/strict";
const dir = mkdtempSync(join(tmpdir(), "relay-browser-"));
const repo = join(dir, "repo");
mkdirSync(repo);
execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
mkdirSync(join(repo, "docs"));
writeFileSync(join(repo, "docs/PRODUCT.md"), "# Browser product");
writeFileSync(join(repo, "docs/TECH.md"), "# Browser tech");
const port = 14310,
  url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["server/index.ts"], {
  env: { ...process.env, DATA_DIR: join(dir, "data"), API_PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
server.stdout.on("data", (x) => (logs += x));
server.stderr.on("data", (x) => (logs += x));
let browser, reference;
async function waitServer() {
  for (let n = 0; n < 100; n++) {
    try {
      if ((await fetch(url + "/api/health")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error(logs);
}
async function action(type, payload) {
  const r = await fetch(url + "/api/actions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({ type, payload }),
  });
  const body = await r.json();
  assert.ok(r.ok, JSON.stringify(body));
  return body.result;
}
const readState = async () => await (await fetch(url + "/api/state")).json();
const geometry = async (page, locator) => {
  const box = await page.locator(locator).first().boundingBox();
  return locator === "main"
    ? { x: box.x, y: box.y, width: box.width }
    : { x: box.x, y: box.y, width: box.width, height: box.height };
};
try {
  await waitServer();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    colorScheme: "light",
  });
  const errors = [];
  const dialogs = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    return dialog.dismiss();
  });
  await page.goto(url);
  await page.getByText("No issues in this view").waitFor();
  assert.equal(await page.getByText("JEV-142").count(), 0);
  await page.getByRole("button", { name: "Create issue", exact: true }).click();
  const createDialog = page.getByRole("dialog");
  await createDialog
    .getByPlaceholder("Issue title")
    .fill("Browser collaboration");
  await createDialog
    .getByPlaceholder("Add description…")
    .fill("Keep this text unchanged when switching languages.");
  await page.screenshot({ path: "/tmp/relay-new-issue.png" });
  await createDialog
    .getByRole("button", { name: "Create issue", exact: true })
    .click();
  await page.getByText("No assignments").waitFor();
  for (const name of [
    "Submit task",
    "Publish artifact",
    "Request approval",
    "Request human input",
    "Edit",
    "Refresh",
  ])
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(
      0,
    );
  await page.getByRole("button", { name: "Issue actions" }).click();
  await expect(
    page.getByRole("button", { name: "Start", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Issue actions" }).click();
  // Persist metadata from the existing property controls.
  await page
    .getByRole("button", { name: /priority/i })
    .first()
    .click();
  await page.getByRole("menuitemradio", { name: /High/ }).click();
  await page.getByRole("button", { name: "Add label" }).click();
  await page.getByRole("button", { name: "Bug", exact: true }).click();
  await page
    .getByPlaceholder("Leave a comment…")
    .fill("Actual browser comment");
  await page
    .locator('textarea[placeholder="Leave a comment…"]')
    .locator("..")
    .getByRole("button")
    .last()
    .click();
  await page.getByText("Actual browser comment", { exact: true }).waitFor();
  // Registration uses the approved same-position absolute directory field.
  await page
    .getByRole("button", { name: /^Projects/ })
    .first()
    .click();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const pd = page.getByRole("dialog");
  await pd.getByPlaceholder("ab-gateway").fill("Browser Project");
  await pd
    .getByRole("textbox", { name: "Choose a repository folder" })
    .fill(repo);
  await pd.getByRole("button", { name: "Browse" }).click();
  await pd.getByRole("button", { name: repo, exact: true }).click();
  await page.screenshot({ path: "/tmp/relay-new-project.png" });
  await pd.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("button", { name: "New worktree" }).click();
  const wd = page.getByRole("dialog");
  await wd.getByPlaceholder("Retry policy", { exact: true }).fill("Main");
  await wd.getByPlaceholder("feature/retry-policy").fill("main");
  await wd.getByPlaceholder("Agent retry policy").fill("Browser spec");
  await wd.getByRole("textbox", { name: "Choose directory" }).fill(repo);
  await wd.getByRole("button", { name: "Create worktree" }).click();
  await page.getByRole("textbox", { name: "PRODUCT.md" }).waitFor();
  await expect(page.getByRole("textbox", { name: "PRODUCT.md" })).toHaveValue(
    "# Browser product",
  );
  await page
    .getByRole("textbox", { name: "PRODUCT.md" })
    .fill("# Browser saved product");
  await page.getByText("Saved locally", { exact: true }).waitFor();
  assert.equal(
    readFileSync(join(repo, "docs/PRODUCT.md"), "utf8"),
    "# Browser saved product",
  );
  await page.getByRole("button", { name: "TECH.md", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "TECH.md" })).toHaveValue(
    "# Browser tech",
  );
  writeFileSync(join(repo, "docs/TECH.md"), "# External change");
  await page
    .getByRole("textbox", { name: "TECH.md" })
    .fill("Keep conflict draft");
  await page.getByText(/Save failed \/ Conflict/).waitFor();
  assert.equal(
    readFileSync(join(repo, "docs/TECH.md"), "utf8"),
    "# External change",
  );
  await page.getByRole("button", { name: "PRODUCT.md", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "PRODUCT.md" })).toHaveValue(
    "# Browser saved product",
  );
  await page.getByRole("button", { name: "TECH.md", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "TECH.md" })).toHaveValue(
    "Keep conflict draft",
  );
  await page.getByText(/Save failed \/ Conflict/).waitFor();
  assert.equal(
    readFileSync(join(repo, "docs/TECH.md"), "utf8"),
    "# External change",
  );
  await page.screenshot({ path: "/tmp/relay-project-detail.png" });
  await page
    .getByRole("button", { name: /^Issues/ })
    .first()
    .click();
  await page
    .getByRole("button", { name: /REL-1.*Browser collaboration/ })
    .click();
  await page.getByRole("button", { name: "Bind agent", exact: true }).click();
  const bindDialog = page.getByRole("dialog");
  await bindDialog.getByRole("button", { name: /^Project / }).click();
  await bindDialog.getByRole("combobox").fill("Browser");
  await bindDialog.getByRole("option", { name: /Browser Project/ }).click();
  await bindDialog
    .getByLabel("Routing instructions")
    .fill("Own backend implementation and contract questions");
  await page.screenshot({ path: "/tmp/relay-bind-agent.png" });
  const bindGeometry = await bindDialog.boundingBox();
  await bindDialog
    .getByRole("button", { name: "Bind agent", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  let state = await readState();
  const issue = state.issues[0];
  assert.equal(state.runs.length, 0);
  assert.equal(issue.status, "Todo");
  assert.equal(issue.priority, 2);
  assert.deepEqual(issue.labels, ["Bug"]);
  assert.equal(state.bindings.length, 1);
  const art = await action("artifact.publish", {
    issueId: issue.id,
    title: "Frozen review",
    content: "Exact evidence to inspect",
    kind: "report",
  });
  const q = await action("request.create", {
    issueId: issue.id,
    title: "Approve frozen review",
    kind: "approval",
    body: "Review exact version",
    action: "Authorize scoped next step",
    artifactIds: [art.id],
    scope: "issue",
  });
  await page
    .getByText("Approve frozen review", { exact: false })
    .first()
    .waitFor();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.getByText("Approved", { exact: false }).first().waitFor();
  assert.equal(
    (await readState()).requests.find((r) => r.id === q.id).status,
    "Approved",
  );
  const routeTask = await action("task.create", {
    issueId: issue.id,
    text: "restart",
  });
  const routing = await action("request.create", {
    issueId: issue.id,
    taskId: routeTask.id,
    title: "Choose a binding for this task",
    body: "Low confidence; confirm the work scope.",
    kind: "input",
    routeTask: true,
    options: [
      {
        value: state.bindings[0].id,
        label:
          "Codex · Browser Project · main · Own backend implementation and contract questions",
      },
    ],
    scope: [routeTask.id],
  });
  await page.getByLabel("Approval reply").fill("Pi");
  const previousDialogs = dialogs.length;
  await page
    .getByRole("button", { name: "Submit answer", exact: true })
    .click();
  await expect.poll(() => dialogs.length).toBe(previousDialogs + 1);
  assert.match(dialogs.at(-1), /full label or value/);
  await expect(page.getByLabel("Approval reply")).toHaveValue("Pi");
  assert.equal(
    (await readState()).requests.find((r) => r.id === routing.id).status,
    "Pending",
  );
  // Reproduce the screenshot: typing only Codex selects the sole Codex binding.
  await page.getByLabel("Approval reply").fill("Codex");
  await page
    .getByRole("button", { name: "Submit answer", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await readState()).requests.find((r) => r.id === routing.id).status,
    )
    .toBe("Answered");
  state = await readState();
  assert.equal(
    state.requests.find((r) => r.id === routing.id).answer,
    state.bindings[0].id,
  );
  assert.equal(
    state.tasks.find((t) => t.id === routeTask.id).bindingId,
    state.bindings[0].id,
  );
  assert.equal(dialogs.length, previousDialogs + 1);
  const input = await action("request.create", {
    issueId: issue.id,
    title: "Choose policy",
    kind: "input",
    body: "Choose one",
    options: [
      { value: "per-agent", label: "Per agent" },
      { value: "global", label: "Global defaults" },
    ],
    scope: "issue",
  });
  await page
    .getByRole("button", { name: /^Inbox/ })
    .first()
    .click();
  await page.getByRole("button", { name: /Choose policy/ }).click();
  await page
    .getByPlaceholder("Provide the details needed to continue…")
    .fill("Per agent");
  assert.equal(
    (await readState()).requests.find((r) => r.id === input.id).status,
    "Pending",
  );
  await page.getByRole("button", { name: "Send response" }).click();
  assert.equal(
    (await readState()).requests.find((r) => r.id === input.id).status,
    "Answered",
  );
  await page.getByRole("button", { name: "Search issues" }).click();
  await page.getByPlaceholder("Search issues…").fill("browser project");
  await expect(
    page.getByRole("button", { name: /REL-1.*Browser collaboration/ }),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: /REL-1.*Browser collaboration/ })
    .click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.screenshot({ path: "/tmp/relay-settings.png" });
  await page
    .getByRole("button", { name: /^Agent/ })
    .first()
    .click();
  await page.screenshot({ path: "/tmp/relay-agent.png" });
  await page
    .getByRole("button", { name: /^Issues/ })
    .first()
    .click();
  await page
    .getByRole("button", { name: /REL-1.*Browser collaboration/ })
    .click();
  await page.screenshot({
    path: "/tmp/relay-browser-desktop.png",
    fullPage: true,
  });
  // Render the actual reference source in an isolated preview and compare invariant layout metrics.
  const design =
    process.env.UI_DESIGN_DIR || "/home/elliot/workspace/tmp/ui-design";
  const refRoot = join(dir, "reference");
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
    const path = join(
      refRoot,
      "dist",
      req.url === "/" ? "index.html" : req.url,
    );
    if (!existsSync(path)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader(
      "Content-Type",
      { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" }[
        extname(path)
      ] || "text/plain",
    );
    res.end(readFileSync(path));
  });
  await new Promise((r) => reference.listen(0, "127.0.0.1", r));
  const refPage = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    colorScheme: "light",
  });
  await refPage.goto(`http://127.0.0.1:${reference.address().port}`);
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
  await refPage.screenshot({ path: "/tmp/relay-reference-settings.png" });
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await page.getByRole("button", { name: "Switch to Chinese" }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByRole("button", { name: /^任务/ }).first().click();
  await page
    .getByRole("button", { name: /REL-1.*Browser collaboration/ })
    .click();
  await page
    .getByText("Keep this text unchanged when switching languages.")
    .waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Bind agent", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({
    path: "/tmp/relay-browser-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "Browser checks passed: reference layout, true directory registration, searchable binding, requests, persisted metadata, autosave/conflicts/drafts, search and preferences.",
  );
} finally {
  await browser?.close();
  if (reference) await new Promise((r) => reference.close(r));
  const exit = new Promise((r) => server.once("exit", r));
  server.kill("SIGTERM");
  await exit;
  rmSync(dir, { recursive: true, force: true });
}
