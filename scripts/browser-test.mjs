import { chromium, expect } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
let browser;
async function waitServer() {
  for (let n = 0; n < 100; n++) {
    try {
      if ((await fetch(url + "/api/health")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Server failed: " + logs);
}
const action = async (type, payload) => {
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
};
try {
  await waitServer();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.getByText("Create your first issue").waitFor();
  assert.equal(await page.getByText("JEV-142").count(), 0);
  await page
    .getByRole("button", { name: "New issue", exact: true })
    .first()
    .click();
  await page
    .getByRole("dialog")
    .getByPlaceholder("Issue title")
    .fill("Browser collaboration");
  await page
    .getByPlaceholder("Add description…")
    .fill("Keep this text unchanged when switching languages.");
  await page.getByRole("button", { name: "Create issue", exact: true }).click();
  await page.getByText("No assignments").waitFor();
  const project = await action("project.create", {
    name: "Browser Project",
    path: repo,
  });
  const tree = await action("worktree.create", {
    projectId: project.id,
    name: "Main",
    branch: "main",
    path: repo,
    specName: "Browser spec",
    specDir: "docs",
  });
  await page.getByRole("button", { name: "Bind agent", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Agent", { exact: true }).selectOption("codex");
  await dialog.getByLabel("Project", { exact: true }).selectOption(project.id);
  await dialog.getByLabel("Worktree", { exact: true }).selectOption(tree.id);
  await dialog
    .getByLabel("Triage routing description")
    .fill("Own backend implementation and contract questions");
  await dialog.getByRole("button", { name: "Bind agent", exact: true }).click();
  await page.getByText("Browser Project", { exact: true }).last().waitFor();
  let state = await (await fetch(url + "/api/state")).json();
  const issue = state.issues[0];
  assert.equal(state.runs.length, 0);
  assert.equal(issue.status, "Todo");
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
    .getByText("Approve frozen review", { exact: true })
    .first()
    .waitFor();
  await page
    .getByRole("button", { name: "Inbox", exact: false })
    .first()
    .click();
  await page.getByRole("button", { name: /Approve frozen review/ }).click();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.getByText("Approved", { exact: true }).first().waitFor();
  await page.getByRole("button", { name: /Open issue/ }).click();
  await page.getByText("Approved", { exact: true }).waitFor();
  state = await (await fetch(url + "/api/state")).json();
  assert.equal(state.requests.find((x) => x.id === q.id).status, "Approved");
  assert.equal(state.issues[0].status, "Todo");
  await page
    .getByRole("button", { name: "Projects", exact: false })
    .first()
    .click();
  await page
    .getByRole("button", { name: /Browser Project/ })
    .first()
    .click();
  await page.getByRole("textbox", { name: "PRODUCT.md" }).waitFor();
  await page
    .getByRole("textbox", { name: "PRODUCT.md" })
    .fill("# Browser saved product");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Saved locally", { exact: true }).waitFor();
  await page.getByRole("button", { name: "TECH.md", exact: true }).click();
  await page.getByRole("textbox", { name: "TECH.md" }).waitFor();
  await expect(page.getByRole("textbox", { name: "TECH.md" })).toHaveValue(
    "# Browser tech",
  );
  await page
    .getByRole("textbox", { name: "TECH.md" })
    .fill("Unsaved tech draft");
  await page.getByRole("button", { name: "PRODUCT.md", exact: true }).click();
  await page.getByRole("textbox", { name: "PRODUCT.md" }).waitFor();
  await expect(page.getByRole("textbox", { name: "PRODUCT.md" })).toHaveValue(
    "# Browser saved product",
  );
  await page.getByRole("button", { name: "TECH.md", exact: true }).click();
  await page.getByRole("textbox", { name: "TECH.md" }).waitFor();
  await expect(page.getByRole("textbox", { name: "TECH.md" })).toHaveValue(
    "Unsaved tech draft",
  );
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page
    .getByPlaceholder("Search by number, title or project")
    .fill("browser project");
  await page
    .getByRole("button", { name: /REL-1.*Browser collaboration/ })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: /REL-1.*Browser collaboration/ })
      .count(),
    1,
  );
  await page.getByRole("button", { name: "Toggle theme" }).click();
  await page.getByRole("button", { name: "Switch language" }).click();
  await page.reload();
  await page.getByRole("button", { name: "搜索", exact: true }).waitFor();
  assert.equal(await page.locator("html").getAttribute("lang"), "zh");
  assert.match(await page.locator("html").getAttribute("class"), /dark/);
  await page
    .getByPlaceholder("按编号、标题或关联项目搜索")
    .fill("Browser collaboration");
  await page
    .getByRole("button", { name: /REL-1.*Browser collaboration/ })
    .click();
  await page
    .getByText("Keep this text unchanged when switching languages.")
    .waitFor();
  await page.screenshot({
    path: "/tmp/relay-browser-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "绑定 Agent", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  assert.ok(await page.getByRole("dialog").isVisible());
  await page.screenshot({
    path: "/tmp/relay-browser-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "Browser checks passed: empty state, create/bind, approval sync, spec save/drafts, search dedup, preferences, responsive controls.",
  );
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await new Promise((r) => server.once("exit", r));
  rmSync(dir, { recursive: true, force: true });
}
