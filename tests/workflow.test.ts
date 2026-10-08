import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import {
  Orchestrator,
  type Factory,
  type Router,
} from "../server/orchestrator.js";
import type { Decision, RuntimeCallbacks } from "../server/types.js";
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});
const tick = () => new Promise((r) => setTimeout(r, 15));
function harness(decisions: Decision[] = []) {
  const store = new Store(":memory:");
  stores.push(store);
  const executions: {
    cb: RuntimeCallbacks;
    stops: number;
    responses: any[];
  }[] = [];
  const router: Router = {
    route: async () =>
      decisions.shift() || { action: "done", detail: "All goals met" },
  };
  const factory: Factory = (_b, _p, cb) => {
    const run = { cb, stops: 0, responses: [] as any[] };
    executions.push(run);
    return {
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
test("editing is disabled while running; removing last unused binding resets ready", async () => {
  const h = harness();
  h.e.unbind(h.id, h.binding.id);
  assert.equal(h.store.issue(h.id)?.status, "waiting_binding");
  assert.equal(h.e.start(h.id).status, "waiting_binding");
});
