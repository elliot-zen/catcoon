import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import { Orchestrator } from "../server/orchestrator.js";
import { createApp } from "../server/app.js";

test("directory API rejects invalid paths without saving and persists independent editable directories", async () => {
  const temp = mkdtempSync(join(tmpdir(), "catcoon-directory-"));
  const first = join(temp, "project with spaces");
  const second = join(temp, "other-project");
  const file = join(temp, "file.txt");
  const denied = join(temp, "denied");
  for (const path of [first, second, denied]) mkdirSync(path);
  writeFileSync(file, "file");
  chmodSync(denied, 0);
  const database = join(temp, "test.sqlite");
  let store = new Store(database);
  let executions = 0;
  const engine = new Orchestrator(store, undefined, () => {
    executions++;
    throw new Error("Binding must not execute");
  });
  const id = engine.createIssue("Directory", "Configure directories").id;
  const server = createApp(engine).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/issues/${id}/bindings`;
  const data = { name: "Codex", runtime: "codex", role: "Build", model: "" };
  const send = (cwd: unknown, binding = "", extra = {}) =>
    fetch(base + (binding ? "/" + binding : ""), {
      method: binding ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...data, cwd, ...extra }),
    });
  try {
    const invalid: [unknown, string][] = [
      ["", "Working directory is required."],
      ["  ", "Working directory is required."],
      [".", "Enter an absolute path on the agent’s machine."],
      ["~/project", "Enter an absolute path on the agent’s machine."],
      [first + "\0", "Enter an absolute path on the agent’s machine."],
      [
        join(temp, "missing"),
        "Directory not found. Enter an existing directory.",
      ],
      [file, "This path is a file. Enter a directory."],
      [
        join(file, "child"),
        "Directory not found. Enter an existing directory.",
      ],
    ];
    if (process.getuid?.() !== 0 && process.platform !== "win32")
      invalid.push([denied, "The agent cannot access this directory."]);
    for (const [cwd, error] of invalid) {
      const response = await send(cwd);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error, field: "cwd" });
      assert.equal(store.bindings(id).length, 0);
      assert.equal(store.issue(id)?.status, "waiting_binding");
      assert.equal(store.detail(id)?.activities.length, 1);
    }
    for (const cwd of [null, undefined, 42]) {
      const response = await send(cwd);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).field, "cwd");
    }
    assert.equal(
      (await send(`  ${first}/../project with spaces/  `)).status,
      201,
    );
    const binding = store.bindings(id)[0];
    assert.equal(binding.cwd, first);
    assert.equal(store.issue(id)?.status, "ready");
    assert.equal(
      (await send(second, "", { name: "Pi", runtime: "pi" })).status,
      201,
    );
    assert.equal((await send(second, binding.id)).status, 200);
    assert.equal(store.bindings(id)[0].cwd, second);
    const snapshot = store.detail(id);
    assert.equal((await send(file, binding.id)).status, 400);
    assert.deepEqual(
      store.detail(id),
      snapshot,
      "Invalid edit must not mutate persisted state",
    );
    assert.equal(executions, 0);
    assert.match(store.detail(id)!.activities[0].detail, /Working directory:/);
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    store = new Store(database);
    assert.deepEqual(
      store.bindings(id).map((b) => b.cwd),
      [second, second],
    );
  } finally {
    if (server.listening)
      await new Promise<void>((r) => server.close(() => r()));
    store.close();
    chmodSync(denied, 0o700);
    rmSync(temp, { recursive: true, force: true });
  }
});

test("sessions and execution history lock directory changes while role and approval edits preserve history", () => {
  const temp = mkdtempSync(join(tmpdir(), "catcoon-locked-directory-"));
  const store = new Store(":memory:");
  const engine = new Orchestrator(store);
  try {
    for (const withSession of [true, false]) {
      const id = engine.createIssue("Lock directory", "Preserve session").id;
      const data = {
        name: "Codex",
        runtime: "codex" as const,
        role: "Build",
        cwd: temp,
        model: "",
      };
      engine.bind(id, data);
      const binding = store.bindings(id)[0];
      if (withSession)
        store.update("bindings", binding.id, { sessionId: "existing-thread" });
      else
        store.insert("turns", {
          id: "turn",
          issueId: id,
          bindingId: binding.id,
          generation: 1,
          status: "failed",
          input: "Build",
          output: "Failed before session creation",
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
        });
      const snapshot = store.detail(id);
      assert.throws(
        () => engine.bind(id, { ...data, cwd: process.cwd() }, binding.id),
        (error: any) => error.status === 409 && error.field === "cwd",
      );
      assert.deepEqual(store.detail(id), snapshot);
      engine.bind(
        id,
        { ...data, role: "Updated", approvalLevel: "automatic" },
        binding.id,
      );
      assert.equal(store.bindings(id)[0].cwd, temp);
      assert.equal(
        store.bindings(id)[0].sessionId,
        withSession ? "existing-thread" : null,
      );
      assert.equal(store.bindings(id)[0].approvalLevel, "automatic");
      assert.deepEqual(store.turns(id), snapshot!.turns);
      store.status(id, "running");
      assert.throws(
        () =>
          engine.bind(
            id,
            { ...data, role: "Cannot edit while running" },
            binding.id,
          ),
        (error: any) =>
          error.status === 409 && /Stop the issue/.test(error.message),
      );
      assert.equal(store.bindings(id)[0].role, "Updated");
      store.status(id, "stopped");
    }
    rmSync(temp, { recursive: true });
    const issue = store.list()[0];
    const binding = store.bindings(issue.id)[0];
    engine.bind(
      issue.id,
      { ...binding, role: "Edit after directory removal" },
      binding.id,
    );
    assert.equal(
      store.bindings(issue.id)[0].role,
      "Edit after directory removal",
    );
  } finally {
    store.close();
    rmSync(temp, { recursive: true, force: true });
  }
});
