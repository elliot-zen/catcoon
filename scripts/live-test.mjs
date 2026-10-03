import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fixture } from "../tests/helpers.ts";
import { createApp } from "../server/index.ts";
import { find, id } from "../server/store.ts";
import { makeRequest, artifact } from "../server/domain.ts";
const key =
  process.env.TYPESAFE_API_KEY ||
  JSON.parse(
    readFileSync(join(process.env.DATA_DIR || "data", "secret.json"), "utf8"),
  ).apiKey;
const f = fixture("codex"),
  other = f.secondTree(),
  app = createApp(f.store.dir, { worker: false });
app.runtime.recovered = true;
app.store.saveKey(key);
app.runtime.refresh(true);
await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
const url = "http://127.0.0.1:" + app.server.address().port,
  state = () => app.store.read();
let browser;
const evidence = {
  scenarios: [],
  evaluations: [],
  runs: [],
  issues: [],
  files: {},
  verification: "",
};
try {
  app.domain.action("issue.update", {
    issueId: f.issue.id,
    revision: state().issues[0].revision,
    title: "Live greeting",
    description:
      "Deliver a tiny Node ESM library in this repository: export greet(name) from greet.mjs. Trim name whitespace. Return Hello, <name>! for nonempty names and Hello, world! for missing or whitespace-only names. Include greet.test.mjs using node:test for normal, trimmed, missing and blank inputs. Verify by executing node --test greet.test.mjs. No packages, no install, no network, no merge/deploy. Plan the system Spec first, propose an explicit upgrade of your assigned Worktree, then implement the approved Spec and report actual test results.",
  });
  app.domain.action("binding.save", {
    ...find(state().bindings, f.binding.id),
    description:
      "Own this greeting Spec, library implementation and Node tests in main Worktree. No UI changes are needed.",
  });
  app.domain.action("binding.save", {
    issueId: f.issue.id,
    projectId: f.project.id,
    worktreeId: other.id,
    agentId: "pi",
    description:
      "Own user-facing web UI only. This greeting library task has no UI scope; do not implement library or Node tests.",
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await page.goto(url);
  await page.getByRole("button", { name: /REL-1.*Live greeting/ }).click();
  await page
    .getByRole("button", { name: "Issue actions", exact: true })
    .click();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  const execute = async (issueId, label) => {
    let confirmations = 0;
    const deadline = Date.now() + 12 * 60 * 1000;
    let last = "";
    while (Date.now() < deadline) {
      await app.runtime.tick();
      const s = state(),
        issue = find(s.issues, issueId),
        signature = JSON.stringify([
          s.evaluations.length,
          s.runs.map((r) => r.status),
          s.requests.map((q) => [q.kind, q.status]),
        ]);
      if (last !== signature) {
        last = signature;
        console.log(
          label,
          JSON.stringify({
            status: issue.status,
            runs: s.runs
              .filter((r) => r.issueId === issueId)
              .map((r) => ({ mode: r.mode, status: r.status })),
            evaluations: s.evaluations
              .filter((e) => e.issueId === issueId)
              .map((e) => ({
                status: e.status,
                action: e.answer?.next_action?.choice,
                mode: e.answer?.dispatch_mode?.choice,
                goal: e.answer?.goal_complete?.noul,
              })),
          }),
        );
      }
      const pending = s.requests.filter(
        (q) =>
          q.issueId === issueId &&
          q.status === "Pending" &&
          q.recipient === "Human",
      );
      for (const q of pending) {
        if (
          q.kind === "approval" &&
          ["approve_spec", "approve_spec_and_upgrade"].includes(q.action?.type)
        ) {
          const v = find(s.specVersions, q.action.specVersionId);
          assert.ok(v.product.trim() && v.tech.trim());
          assert.ok(v.product.includes("greet") || v.tech.includes("greet"));
          if (label === "P21") {
            assert.equal(q.action.type, "approve_spec_and_upgrade");
            assert.ok(q.action.targets.some((t) => t.worktreeId === f.tree.id));
          }
          const row = page.locator('[data-activity-id="request:' + q.id + '"]');
          await row.waitFor();
          await row
            .getByRole("button", { name: "Approve", exact: true })
            .click();
        } else if (q.kind === "final") {
          const verification = execFileSync(
            process.execPath,
            ["--test", "greet.test.mjs"],
            { cwd: f.repo, encoding: "utf8" },
          );
          assert.match(verification, /fail 0/);
          evidence.verification = verification;
          await page
            .locator('[data-activity-id="request:' + q.id + '"]')
            .getByRole("button", { name: "Approve", exact: true })
            .click();
        } else if (q.routeTask && confirmations++ < 3) {
          const candidate = s.bindings.find(
            (b) => b.issueId === issueId && !b.removed && b.agentId === "codex",
          );
          const row = page.locator('[data-activity-id="request:' + q.id + '"]');
          await row
            .getByRole("textbox", { name: "Approval reply" })
            .fill(candidate.id);
          await row.getByRole("button", { name: "Submit answer" }).click();
          evidence.scenarios.push(
            label +
              ": Human confirmed the existing Codex work scope after low-confidence routing",
          );
        } else if (
          q.kind === "input" &&
          q.inputClass === "business" &&
          !q.routeTask &&
          existsSync(join(f.repo, "greet.test.mjs")) &&
          confirmations++ < 4
        ) {
          const verification = execFileSync(
            process.execPath,
            ["--test", "greet.test.mjs"],
            { cwd: f.repo, encoding: "utf8" },
          );
          assert.match(verification, /fail 0/);
          const row = page.locator('[data-activity-id="request:' + q.id + '"]');
          await row
            .getByRole("textbox", { name: "Approval reply" })
            .fill(
              "I independently inspected greet.mjs and greet.test.mjs and ran node --test greet.test.mjs. All greeting requirements are covered: normal name, trimmed name, missing and blank name. The actual command passed with zero failures. No behavior or business clarification remains. Ready to review a final acceptance request. Actual independent verification:\n" +
                verification +
                "\nSource:\n" +
                readFileSync(join(f.repo, "greet.mjs"), "utf8") +
                "\nTests:\n" +
                readFileSync(join(f.repo, "greet.test.mjs"), "utf8"),
            );
          await row.getByRole("button", { name: "Submit answer" }).click();
          evidence.scenarios.push(
            label +
              ": Human supplied independently executed verification after low-confidence completion judgment",
          );
        } else
          throw new Error(
            "Unexpected Human block " + q.title + ": " + q.body.slice(0, 800),
          );
      }
      if (find(state().issues, issueId).status === "Done") return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(label + " timed out");
  };
  await execute(f.issue.id, "P21");
  assert.ok(
    state().runs.some((r) => r.mode === "spec" && r.status === "completed"),
  );
  assert.ok(
    state().runs.some(
      (r) => r.mode === "implement" && r.status === "completed",
    ),
  );
  assert.equal(
    find(state().worktrees, other.id).specVersionId,
    other.specVersionId,
  );
  evidence.scenarios.push(
    "P21: browser Start, real Jev, real Codex system Spec, explicit Human approval+upgrade, automatic implementation/test, final acceptance",
  );
  const second = app.domain.action("issue.create", {
    title: "Live approved greeting",
    description:
      "Verify and finish the existing greet.mjs feature according to its exact approved system Spec. Execute node --test greet.test.mjs and report actual results. No new Spec is required.",
  });
  const binding = app.domain.action("binding.save", {
    issueId: second.id,
    projectId: f.project.id,
    worktreeId: f.tree.id,
    agentId: "codex",
    description:
      "Own greeting code and verification; use the supplied approved fixed Spec.",
  });
  const versionId = state().worktrees.find(
    (w) => w.id === f.tree.id,
  ).specVersionId;
  const approval = app.store.change((s) => {
    const v = find(s.specVersions, versionId),
      a = artifact(s, {
        issueId: second.id,
        title: "Fixed Spec",
        content: v.product + "\n" + v.tech,
        specVersionId: v.id,
      });
    return makeRequest(s, {
      issueId: second.id,
      kind: "approval",
      title: "Approve fixed version",
      artifactIds: [a.id],
      scope: "issue",
      action: {
        type: "approve_spec",
        specVersionId: v.id,
        worktreeIds: [f.tree.id],
        allowedModes: ["implement", "verify", "revise"],
      },
    });
  });
  app.domain.action("request.decide", {
    requestId: approval.id,
    revision: 0,
    decision: "approve",
  });
  await page.goto(url);
  await page
    .getByRole("button", { name: /REL-2.*Live approved greeting/ })
    .click();
  await page
    .getByRole("button", { name: "Issue actions", exact: true })
    .click();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await execute(second.id, "P22");
  assert.ok(
    !state()
      .runs.filter((r) => r.issueId === second.id)
      .some((r) => r.mode === "spec"),
  );
  assert.notEqual(
    find(state().bindings, binding.id).activeSessionId,
    find(state().bindings, f.binding.id).activeSessionId,
  );
  evidence.scenarios.push(
    "P22: existing approved pin directly executes verification/implementation; new Issue has independent session",
  );
  evidence.evaluations = state().evaluations;
  evidence.runs = state().runs;
  evidence.issues = state().issues;
  evidence.specs = state().specVersions;
  evidence.requests = state().requests;
  evidence.artifacts = state().artifacts;
  for (const name of ["greet.mjs", "greet.test.mjs"])
    if (existsSync(join(f.repo, name)))
      evidence.files[name] = readFileSync(join(f.repo, name), "utf8");
  await page.screenshot({ path: "/tmp/relay-live.png", fullPage: true });
  console.log("Live model scenarios P21 and P22 passed.");
} finally {
  evidence.evaluations = state().evaluations;
  evidence.runs = state().runs;
  evidence.issues = state().issues;
  evidence.specs = state().specVersions;
  evidence.artifacts = state().artifacts;
  evidence.requests = state().requests;
  writeFileSync(
    "/tmp/relay-live-evidence.json",
    JSON.stringify(evidence, null, 2),
    { mode: 0o600 },
  );
  await browser?.close();
  await app.close();
  f.close();
}
