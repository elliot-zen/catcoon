import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import { createApp } from "../server/app.js";
import {
  Orchestrator,
  type Factory,
  type Router,
} from "../server/orchestrator.js";
import type { Binding, Decision, RuntimeCallbacks } from "../server/types.js";
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});
const tick = () => new Promise((r) => setTimeout(r, 15));
function harness(decisions: Decision[] = []) {
  const store = new Store(":memory:");
  stores.push(store);
  const executions: {
    binding: Binding;
    cb: RuntimeCallbacks;
    stops: number;
    responses: any[];
    messages: string[];
  }[] = [];
  const router: Router = {
    route: async () =>
      decisions.shift() || { action: "done", detail: "All goals met" },
  };
  const factory: Factory = (_b, _p, cb) => {
    const run = {
      binding: _b,
      cb,
      stops: 0,
      responses: [] as any[],
      messages: [] as string[],
    };
    executions.push(run);
    return {
      send: async (message) => {
        run.messages.push(message);
      },
      stop: async () => {
        run.stops++;
        cb.closed();
      },
      respond: (...args) => run.responses.push(args),
      dispose: () => cb.closed(),
    };
  };
  const e = new Orchestrator(store, router, factory);
  const d = e.createIssue("Build an API", "Implement and verify an API");
  e.bind(d.id, {
    name: "Codex",
    runtime: "codex",
    role: "Implementation",
    cwd: process.cwd(),
    model: "",
  });
  const binding = store.bindings(d.id)[0];
  return { e, store, id: d.id, binding, executions, decisions };
}
test("creating and binding never executes; final turn completion requires routing", async () => {
  const h = harness();
  assert.equal(h.store.issue(h.id)?.status, "ready");
  assert.equal(h.executions.length, 0);
  h.decisions.push(
    { action: "agent", bindingId: h.binding.id, detail: "Implement" },
    { action: "done", detail: "Verified" },
  );
  h.e.start(h.id);
  await tick();
  assert.equal(h.store.issue(h.id)?.status, "running");
  h.e.start(h.id);
  assert.equal(h.executions.length, 1);
  h.executions[0].cb.complete("Verified implementation");
  assert.equal(
    h.store.issue(h.id)?.status,
    "running",
    "Must wait for process shutdown before dispatching another turn",
  );
  h.executions[0].cb.closed();
  await tick();
  assert.equal(h.store.issue(h.id)?.status, "done");
});
test("session chat resumes its binding, persists Human messages and finishes without routing", async () => {
  const h = harness();
  h.store.update("bindings", h.binding.id, { sessionId: "existing-session" });
  await h.e.message(
    h.id,
    h.binding.id,
    "  Explain the current implementation  ",
    null,
  );
  const turn = h.store.turns(h.id)[0];
  assert.equal(h.executions[0].binding.sessionId, "existing-session");
  assert.equal(h.executions[0].binding.approvalLevel, "on-request");
  assert.equal(h.store.issue(h.id)?.status, "running");
  assert.deepEqual(
    h.e.require(h.id).messages.map((m) => [m.kind, m.text]),
    [["user", "Explain the current implementation"]],
  );
  assert.match(turn.input, /Explain the current implementation/);
  h.executions[0].cb.complete("Implementation explained");
  h.executions[0].cb.closed();
  await tick();
  assert.equal(h.store.issue(h.id)?.status, "stopped");
  assert.equal(h.store.turns(h.id)[0].status, "completed");
  await h.e.message(h.id, h.binding.id, "One more question", null);
  h.executions[1].cb.complete("Answered");
  h.executions[1].cb.closed();
  assert.equal(h.store.turns(h.id).length, 2);
  h.store.status(h.id, "done", { completedAt: "2026-10-09T00:00:00.000Z" });
  await h.e.message(h.id, h.binding.id, "Explain the completed result", null);
  h.executions[2].cb.complete("Explained");
  h.executions[2].cb.closed();
  assert.equal(h.store.issue(h.id)?.status, "done");
  assert.equal(h.store.issue(h.id)?.completedAt, "2026-10-09T00:00:00.000Z");
});

test("chat steers only the active binding and retains only accepted messages", async () => {
  const h = harness();
  h.decisions.push({
    action: "agent",
    bindingId: h.binding.id,
    detail: "Build",
  });
  h.e.start(h.id);
  await tick();
  const turnId = h.store.issue(h.id)!.currentTurnId!;
  const run = h.executions[0];
  run.cb.message("assistant_delta", "Initial reply");
  await h.e.message(h.id, h.binding.id, "Focus on tests", turnId);
  assert.deepEqual(run.messages, ["Focus on tests"]);
  assert.equal(h.store.turns(h.id).length, 1);
  assert.deepEqual(
    h.e.require(h.id).messages.map((m) => m.kind),
    ["assistant_delta", "user_steer"],
  );
  await assert.rejects(
    h.e.message(h.id, h.binding.id, "Stale", "old-turn"),
    /active turn changed/,
  );
  h.store.insert("bindings", { ...h.binding, id: "other-binding" });
  await assert.rejects(
    h.e.message(h.id, "other-binding", "Other agent", turnId),
    /current agent/,
  );
  h.e.active.get(turnId)!.handle.send = async () => {
    throw new Error("Steer failed");
  };
  await assert.rejects(
    h.e.message(h.id, h.binding.id, "Rejected message", turnId),
    /Steer failed/,
  );
  assert.equal(
    h.e.require(h.id).messages.some((m) => m.text === "Rejected message"),
    false,
  );
  assert.equal(h.store.issue(h.id)?.status, "running");
  run.cb.complete("Tested");
  run.cb.closed();
  await tick();
  assert.equal(
    h.store.issue(h.id)?.status,
    "done",
    "Steering an automatic workflow keeps its routing behavior",
  );
});

test("chat honors pending human requests, Stop and execution state guards", async () => {
  const h = harness();
  await h.e.message(h.id, h.binding.id, "Make a change");
  const run = h.executions[0];
  run.cb.request({
    kind: "approval",
    title: "Write files",
    detail: "Exact operation",
    options: [],
    native: { id: "approve" },
  });
  const pending = h.store.pending(h.id)!;
  await assert.rejects(
    h.e.message(h.id, h.binding.id, "Approved in chat"),
    /human request/,
  );
  assert.equal(run.responses.length, 0);
  h.e.stop(h.id);
  await assert.rejects(
    h.e.message(h.id, h.binding.id, "Skip the request"),
    /human request/,
  );
  h.e.start(h.id);
  h.e.respond(h.id, pending.id, "", true);
  run.cb.complete("Changed");
  run.cb.closed();
  assert.equal(h.store.issue(h.id)?.status, "stopped");
  await h.e.message(h.id, h.binding.id, "Next change");
  h.e.stop(h.id);
  assert.equal(h.store.turns(h.id)[1].status, "interrupted");
  for (const status of ["routing", "stopping", "waiting_human"] as const) {
    h.store.status(h.id, status);
    await assert.rejects(
      h.e.message(h.id, h.binding.id, "Blocked"),
      /execution to end/,
    );
  }
  await assert.rejects(
    h.e.message(h.id, "missing", "Test"),
    /Binding not found/,
  );
  await assert.rejects(
    h.e.message(h.id, h.binding.id, "  "),
    /Enter a message/,
  );
  assert.equal(h.store.turns(h.id).length, 2);
});

test("chat HTTP endpoint validates messages, turn preconditions and pending approvals", async () => {
  const h = harness();
  const server = createApp(h.e).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const path = `http://127.0.0.1:${address.port}/api/issues/${h.id}/bindings/${h.binding.id}/messages`;
  const post = (body: unknown) =>
    fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post({ message: "  ", turnId: null })).status, 400);
    assert.equal((await post({ message: "Hello" })).status, 400);
    const response = await post({ message: "Hello", turnId: null });
    assert.equal(response.status, 201);
    const detail = await response.json();
    assert.equal(detail.messages[0].text, "Hello");
    assert.equal((await post({ message: "Stale", turnId: null })).status, 409);
    h.executions[0].cb.request({
      kind: "input",
      title: "Choose target",
      detail: "Which target?",
      options: [],
      native: { id: "question" },
    });
    assert.equal(
      (await post({ message: "Target", turnId: detail.currentTurnId })).status,
      409,
    );
    assert.equal(h.store.pending(h.id)?.status, "pending");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
test("Codex and Pi hand off serially using binding responsibilities", async () => {
  const h = harness();
  h.e.bind(h.id, {
    name: "Pi",
    runtime: "pi",
    role: "Review",
    cwd: process.cwd(),
    model: "",
  });
  const pi = h.store.bindings(h.id)[1];
  h.decisions.push(
    { action: "agent", bindingId: h.binding.id, detail: "Build" },
    { action: "agent", bindingId: pi.id, detail: "Review" },
    { action: "done", detail: "Reviewed" },
  );
  h.e.start(h.id);
  await tick();
  h.executions[0].cb.complete("Built");
  h.executions[0].cb.closed();
  await tick();
  assert.equal(h.executions.length, 2);
  assert.equal(h.store.turns(h.id)[1].bindingId, pi.id);
  assert.equal(
    h.store.turns(h.id).filter((t) => t.status === "running").length,
    1,
  );
  h.executions[1].cb.complete("Reviewed");
  h.executions[1].cb.closed();
  await tick();
  assert.equal(h.store.issue(h.id)?.status, "done");
});
test("native approval pauses execution, survives Stop/Start, and submits once", async () => {
  const h = harness([{ action: "human", detail: "unused" }]);
  h.decisions.splice(0, 1, {
    action: "agent",
    bindingId: h.binding.id,
    detail: "Build",
  });
  h.e.start(h.id);
  await tick();
  const run = h.executions[0];
  run.cb.request({
    kind: "approval",
    title: "Modify files",
    detail: "Exact proposed change",
    options: [],
    native: { id: 1, method: "approval" },
  });
  assert.equal(h.store.issue(h.id)?.status, "waiting_human");
  const r = h.store.pending(h.id)!;
  assert.equal(run.responses.length, 0);
  h.e.stop(h.id);
  assert.throws(() => h.e.respond(h.id, r.id, "", true), /Start/);
  h.e.start(h.id);
  assert.equal(h.store.issue(h.id)?.status, "waiting_human");
  h.e.respond(h.id, r.id, "", true);
  h.e.respond(h.id, r.id, "", true);
  assert.equal(run.responses.length, 1);
  assert.equal(h.store.issue(h.id)?.status, "running");
  run.cb.complete("Changed");
  run.cb.closed();
  await tick();
  assert.equal(h.store.issue(h.id)?.status, "done");
});
test("stopped bindings allow policy changes with a suspended request, applied to the next turn", async () => {
  const h = harness();
  h.decisions.push(
    { action: "agent", bindingId: h.binding.id, detail: "Build" },
    { action: "agent", bindingId: h.binding.id, detail: "Verify" },
    { action: "done", detail: "Verified" },
  );
  h.store.update("bindings", h.binding.id, { sessionId: "kept-session" });
  h.e.start(h.id);
  await tick();
  const run = h.executions[0];
  run.cb.request({
    kind: "approval",
    title: "Command",
    detail: "Exact operation",
    options: [],
    native: { id: 1, method: "approval" },
  });
  const request = h.store.pending(h.id)!;
  const data = {
    name: h.binding.name,
    runtime: h.binding.runtime,
    role: h.binding.role,
    cwd: h.binding.cwd,
    model: h.binding.model,
    approvalLevel: "automatic" as const,
  };
  assert.throws(() => h.e.bind(h.id, data, h.binding.id), /Stop the issue/);
  h.e.stop(h.id);
  h.e.bind(h.id, data, h.binding.id);
  assert.equal(h.store.bindings(h.id)[0].approvalLevel, "automatic");
  assert.equal(h.store.bindings(h.id)[0].sessionId, "kept-session");
  assert.equal(h.store.issue(h.id)?.status, "stopped");
  assert.deepEqual(h.store.pending(h.id), request);
  assert.equal(run.responses.length, 0);
  assert.equal(run.binding.approvalLevel, "on-request");
  assert.throws(
    () => h.e.bind(h.id, { ...data, role: "Changed task" }, h.binding.id),
    /Only the approval level/,
  );
  assert.throws(
    () => h.e.bind(h.id, { ...data, runtime: "pi" }, h.binding.id),
    /Only the approval level/,
  );
  assert.throws(() => h.e.bind(h.id, data), /Only the approval level/);
  h.e.start(h.id);
  assert.equal(h.store.issue(h.id)?.status, "waiting_human");
  h.e.respond(h.id, request.id, "", true);
  run.cb.complete("Built");
  run.cb.closed();
  await tick();
  assert.equal(h.executions[1].binding.approvalLevel, "automatic");
  h.executions[1].cb.complete("Verified");
  h.executions[1].cb.closed();
  await tick();
  assert.equal(h.store.issue(h.id)?.status, "done");
});

test("rejection requires feedback and cannot be recorded as approval", async () => {
  const h = harness();
  h.decisions.push({
    action: "agent",
    bindingId: h.binding.id,
    detail: "Build",
  });
  h.e.start(h.id);
  await tick();
  h.executions[0].cb.request({
    kind: "approval",
    title: "Command",
    detail: "command snapshot",
    options: [],
    native: { id: 1 },
  });
  const r = h.store.pending(h.id)!;
  assert.throws(() => h.e.respond(h.id, r.id, "", false), /Explain/);
  h.e.respond(h.id, r.id, "Use another approach", false);
  assert.equal(h.store.requests(h.id)[0].status, "rejected");
  assert.equal(h.executions[0].responses[0][2], false);
});
test("Stop aborts an in-flight route; late decisions do not dispatch", async () => {
  const h = harness();
  let finish!: (d: Decision) => void;
  (h.e as any).router = {
    route: () => new Promise((resolve) => (finish = resolve)),
  };
  h.e.start(h.id);
  h.e.stop(h.id);
  finish({ action: "agent", bindingId: h.binding.id, detail: "Late" });
  await tick();
  assert.equal(h.store.issue(h.id)?.status, "stopped");
  assert.equal(h.executions.length, 0);
});

test("invalid MCP form answers remain pending and never reach the runtime", async () => {
  const h = harness();
  h.decisions.push({
    action: "agent",
    bindingId: h.binding.id,
    detail: "Build",
  });
  h.e.start(h.id);
  await tick();
  const run = h.executions[0];
  run.cb.request({
    kind: "input",
    title: "Choose canvas",
    detail: "Form fields",
    options: [],
    native: {
      id: "mcp",
      method: "mcpServer/elicitation/request",
      params: {
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: { canvas: { type: "string", enum: ["main", "review"] } },
          required: ["canvas"],
          additionalProperties: false,
        },
      },
    },
  });
  const r = h.store.pending(h.id)!;
  for (const answer of [
    "plain text",
    "{}",
    '{"canvas":"missing"}',
    '{"canvas":"main","extra":true}',
  ]) {
    assert.throws(
      () => h.e.respond(h.id, r.id, answer, false),
      /JSON object|Invalid MCP form/,
    );
    assert.equal(h.store.pending(h.id)?.id, r.id);
    assert.equal(h.store.issue(h.id)?.status, "waiting_human");
    assert.equal(run.responses.length, 0);
  }
  h.e.respond(h.id, r.id, '{"canvas":"main"}', false);
  assert.equal(run.responses.length, 1);
  assert.equal(h.store.requests(h.id)[0].status, "answered");
  run.cb.complete("Done");
  run.cb.closed();
  await tick();
});
test("Stop waits for runtime exit and a late completion cannot mark done", async () => {
  const h = harness();
  h.decisions.push({
    action: "agent",
    bindingId: h.binding.id,
    detail: "Build",
  });
  h.e.start(h.id);
  await tick();
  h.e.active.get(h.store.issue(h.id)!.currentTurnId!)!.handle.stop =
    async () => {};
  h.e.stop(h.id);
  assert.equal(h.store.issue(h.id)?.status, "stopping");
  h.e.start(h.id);
  assert.equal(h.store.issue(h.id)?.status, "stopping");
  h.executions[0].cb.complete("Late result");
  h.executions[0].cb.closed();
  await tick();
  assert.equal(h.store.issue(h.id)?.status, "stopped");
  assert.equal(h.store.turns(h.id)[0].status, "interrupted");
});
test("routing failure, unbound selection, and premature completion stop safely", async () => {
  for (const decision of [
    { action: "agent", bindingId: "missing", detail: "Bad" },
    { action: "done", detail: "No evidence" },
  ] as Decision[]) {
    const h = harness([decision]);
    h.e.start(h.id);
    await tick();
    assert.equal(h.store.issue(h.id)?.status, "stopped");
    assert.equal(h.executions.length, 0);
  }
});
test("SQLite survives reopening and restart preserves unresolved human requests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "catcoon-db-"));
  const db = join(dir, "test.sqlite");
  let s = new Store(db);
  const e = new Orchestrator(s, {
    route: async () => ({ action: "human", detail: "Choose a target" }),
  });
  const d = e.createIssue("Test", "Goal");
  e.bind(d.id, {
    name: "Pi",
    runtime: "pi",
    role: "Execute",
    cwd: process.cwd(),
    model: "",
  });
  e.start(d.id);
  await tick();
  assert.equal(s.issue(d.id)?.status, "waiting_human");
  s.close();
  s = new Store(db);
  const recovered = new Orchestrator(s);
  recovered.recover();
  assert.equal(s.issue(d.id)?.status, "stopped");
  assert.equal(s.pending(d.id)?.detail, "Choose a target");
  recovered.start(d.id);
  assert.equal(s.issue(d.id)?.status, "waiting_human");
  s.close();
  rmSync(dir, { recursive: true });
});
test("chat history survives reopening and uncertain sends are never replayed on recovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "catcoon-chat-db-"));
  const db = join(dir, "chat.sqlite");
  let store = new Store(db);
  try {
    const engine = new Orchestrator(
      store,
      {
        route: async () => {
          throw new Error("Must not route");
        },
      },
      (_binding, _prompt, cb) => ({
        send: async () => {},
        stop: async () => cb.closed(),
        respond: () => {},
        dispose: () => {},
      }),
    );
    const issue = engine.createIssue("Chat", "Discuss implementation");
    engine.bind(issue.id, {
      name: "Pi",
      runtime: "pi",
      role: "Discuss",
      cwd: process.cwd(),
      model: "",
    });
    const binding = store.bindings(issue.id)[0];
    await engine.message(issue.id, binding.id, "Persist this question");
    const turnId = store.issue(issue.id)!.currentTurnId!;
    store.message(turnId, "assistant_delta", "Persisted reply");
    store.message(turnId, "user_pending", "Uncertain follow-up");
    store.close();
    store = new Store(db);
    const recovered = new Orchestrator(store);
    recovered.recover();
    assert.equal(store.issue(issue.id)?.status, "stopped");
    assert.deepEqual(
      recovered.require(issue.id).messages.map((m) => [m.kind, m.text]),
      [
        ["user", "Persist this question"],
        ["assistant_delta", "Persisted reply"],
        ["user_unconfirmed", "Uncertain follow-up"],
      ],
    );
    assert.equal(recovered.active.size, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});
test("editing is disabled while running; removing last unused binding resets ready", async () => {
  const h = harness();
  h.e.unbind(h.id, h.binding.id);
  assert.equal(h.store.issue(h.id)?.status, "waiting_binding");
  assert.equal(h.e.start(h.id).status, "waiting_binding");
});
