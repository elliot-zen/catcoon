import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer, type WebSocket } from "ws";
import { fixture } from "./helpers.ts";
import { Codex } from "../server/agents/codex.ts";
import { Pi } from "../server/agents/pi.ts";
import { Rpc } from "../server/agents/rpc.ts";
import { Runtime } from "../server/runtime.ts";
import { find, id } from "../server/store.ts";
import { relayTools } from "../server/agents/tools.ts";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
async function until(predicate: () => boolean) {
  for (let n = 0; n < 300; n++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(predicate(), "Expected native state did not arrive");
}
async function peer() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => server.once("listening", r));
  const endpoint = "ws://127.0.0.1:" + (server.address() as any).port,
    clients: WebSocket[] = [],
    calls: any[] = [],
    replies: any[] = [];
  const thread: any = { id: "thread-1", status: { type: "idle" }, turns: [] };
  const notify = (method: string, params: any) =>
    clients.forEach((c) => {
      if (c.readyState === 1)
        c.send(
          JSON.stringify({
            method,
            params: { threadId: thread.id, ...params },
          }),
        );
    });
  const finish = (status = "completed") => {
    const turn = thread.turns.at(-1);
    turn.status = status;
    turn.items = [
      {
        id: "answer-1",
        type: "agentMessage",
        text: "Inspected real result; natural answer.",
      },
    ];
    thread.status = { type: "idle" };
    notify("item/completed", { turnId: turn.id, item: turn.items[0] });
    notify("turn/completed", { turn });
  };
  server.on("connection", (c) => {
    clients.push(c);
    c.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (!m.method) {
        replies.push(m);
        return;
      }
      calls.push(m);
      let result: any = {};
      if (["thread/start", "thread/read", "thread/resume"].includes(m.method))
        result = { thread };
      if (m.method === "turn/start") {
        const turn = {
          id: "turn-" + (thread.turns.length + 1),
          status: "inProgress",
          items: [],
        };
        thread.turns.push(turn);
        thread.status = { type: "active" };
        notify("turn/started", { turn });
        result = { turn };
      }
      if (m.method === "turn/interrupt")
        setTimeout(() => finish("interrupted"), 5);
      if (m.id !== undefined) c.send(JSON.stringify({ id: m.id, result }));
    });
  });
  return {
    endpoint,
    calls,
    replies,
    notify,
    finish,
    thread,
    request(method: string, params: any, requestId = "server-call") {
      clients[0].send(
        JSON.stringify({
          id: requestId,
          method,
          params: {
            threadId: thread.id,
            turnId: thread.turns.at(-1).id,
            ...params,
          },
        }),
      );
    },
    close() {
      clients.forEach((c) => c.terminate());
      server.close();
    },
  };
}
async function connect(
  f: ReturnType<typeof fixture>,
  p: Awaited<ReturnType<typeof peer>>,
) {
  const c = new Codex(f.store.dir, p.endpoint);
  f.runtime.codex = c;
  c.on("message", (m) => f.runtime.codexMessage(m));
  c.on("disconnect", (reason) => {
    for (const r of f
      .state()
      .runs.filter((r) =>
        ["starting", "running", "stopping"].includes(r.status),
      ))
      f.runtime.unknown(r.id, reason);
  });
  await f.runtime.prepareCodex(f.binding.id, f.repo);
  f.start();
  const r = f.runtime.begin(f.state().tasks[0].id, f.binding.id, "spec")!;
  await Runtime.prototype.launchNative.call(f.runtime, r);
  await until(() => find(f.state().runs, r.id).status === "running");
  return r;
}
test("RPC server request IDs never consume a pending client response", async () => {
  const rpc = new Rpc(() => {});
  let request = false;
  rpc.on("message", () => (request = true));
  const pending = rpc.call("initialize");
  rpc.receive({ id: "relay-1", method: "item/tool/call", params: {} });
  assert.equal(rpc.pending.size, 1);
  assert.ok(request);
  rpc.receive({ id: "relay-1", result: { ok: true } });
  assert.deepEqual(await pending, { ok: true });
});
test("Codex early notifications correlate exact thread/turn and natural completion is ingested once", async () => {
  const f = fixture("codex"),
    p = await peer();
  try {
    const r = await connect(f, p);
    assert.equal(find(f.state().runs, r.id).nativeTurnId, "turn-1");
    assert.deepEqual(
      p.calls.find((m) => m.method === "thread/start").params.dynamicTools,
      relayTools,
    );
    const start = p.calls.find((m) => m.method === "turn/start");
    assert.equal(start.params.sandboxPolicy.type, "readOnly");
    assert.equal(start.params.summary, "detailed");
    p.notify("item/agentMessage/delta", {
      turnId: "turn-1",
      itemId: "answer-1",
      delta: "Streaming answer",
    });
    assert.equal(find(f.state().runs, r.id).status, "running");
    p.finish();
    await until(() => find(f.state().runs, r.id).status === "completed");
    p.finish();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      f.state().artifacts.filter((a) => a.title === "Codex result").length,
      1,
    );
    assert.equal(f.state().issues[0].triage.dirty, true);
    assert.equal(
      f.runtime.streams.items(r.id).filter((i) => i.kind === "answer").length,
      1,
    );
    assert.equal(f.state().issues[0].sessions[0].threadId, p.thread.id);
  } finally {
    f.close();
    p.close();
  }
});
test("Codex dynamic report is scoped and idempotent; tool report doesn't terminate a native turn", async () => {
  const f = fixture("codex"),
    p = await peer();
  try {
    const r = await connect(f, p),
      args = {
        artifacts: [
          { kind: "report", title: "Readable", content: "Observed source." },
        ],
      };
    p.request(
      "item/tool/call",
      { tool: "relay_report", arguments: args, callId: "dynamic-1" },
      "host-1",
    );
    await until(() => p.replies.length === 1);
    assert.equal(p.replies[0].result.success, true);
    assert.equal(find(f.state().runs, r.id).status, "running");
    p.request(
      "item/tool/call",
      { tool: "relay_report", arguments: args, callId: "dynamic-1" },
      "host-2",
    );
    await until(() => p.replies.length === 2);
    assert.equal(f.state().artifacts.length, 1);
    p.finish();
    await until(() => find(f.state().runs, r.id).status === "completed");
  } finally {
    f.close();
    p.close();
  }
});
test("Native approvals are separate requests and write permissions cannot bypass Spec approval", async () => {
  const f = fixture("codex"),
    p = await peer();
  try {
    const r = await connect(f, p);
    p.request("item/commandExecution/requestApproval", {
      itemId: "exec",
      reason: "Write output",
      command: "touch greeting",
    });
    await until(() => f.state().requests.length === 1);
    const q = f.state().requests[0];
    await assert.rejects(
      f.runtime.decideNative(
        { requestId: q.id, revision: 0, decision: "approve" },
        id(),
      ),
      /fixed Spec/,
    );
    assert.equal(find(f.state().requests, q.id).status, "Pending");
    await f.runtime.decideNative(
      {
        requestId: q.id,
        revision: 0,
        decision: "changes",
        answer: "Do not write before the Spec is approved.",
      },
      id(),
    );
    await until(() => p.replies.length === 1);
    assert.deepEqual(p.replies[0].result, { decision: "decline" });
    assert.equal(find(f.state().runs, r.id).status, "running");
    p.finish();
    await until(() => find(f.state().runs, r.id).status === "completed");
  } finally {
    f.close();
    p.close();
  }
});
test("Unknown recovery reads the exact saved native turn and does not send another turn/start", async () => {
  const f = fixture("codex"),
    p = await peer();
  try {
    const r = await connect(f, p);
    f.runtime.unknown(r.id, "disconnect");
    await f.runtime.recoverNative();
    assert.equal(find(f.state().runs, r.id).status, "running");
    assert.equal(p.calls.filter((m) => m.method === "turn/start").length, 1);
    p.finish();
    await until(() => find(f.state().runs, r.id).status === "completed");
    assert.equal(f.state().requests[0].status, "Resolved");
    assert.equal(f.store.db.prepare("SELECT * FROM locks").get(), undefined);
  } finally {
    f.close();
    p.close();
  }
});
test("Terminal-only turns are observed but cannot submit platform reports or satisfy the goal", async () => {
  const f = fixture("codex"),
    p = await peer();
  try {
    await connect(f, p);
    p.finish();
    await until(() => f.state().runs[0].status === "completed");
    p.thread.turns.push({
      id: "terminal-turn",
      status: "inProgress",
      items: [],
    });
    p.notify("turn/started", { turn: p.thread.turns.at(-1) });
    await until(() => f.state().runs.length === 2);
    const r = f.state().runs[1];
    assert.equal(r.origin, "terminal");
    assert.equal(r.taskId, undefined);
    p.request("item/tool/call", {
      tool: "relay_report",
      arguments: { artifacts: [{ title: "Forged", content: "terminal" }] },
      callId: "terminal-report",
    });
    await until(() => p.replies.length === 1);
    assert.equal(p.replies[0].result.success, false);
    p.finish();
    await until(() => find(f.state().runs, r.id).status === "completed");
    assert.equal(
      f.state().artifacts.some((a) => a.title === "Forged"),
      false,
    );
    assert.equal(f.state().tasks[0].status, "pending");
  } finally {
    f.close();
    p.close();
  }
});
test("Installed Codex app-server accepts experimental dynamic tools and preserves a thread for a second local client", async () => {
  const f = fixture("codex"),
    home = join(f.root, "codex-home");
  mkdirSync(home);
  const http = createServer((_req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Offline protocol probe" } }));
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  writeFileSync(
    join(home, "config.toml"),
    'model_provider="probe"\n[model_providers.probe]\nname="Probe"\nbase_url="http://127.0.0.1:' +
      (http.address() as any).port +
      '/v1"\nwire_api="responses"\nrequires_openai_auth=false\n',
  );
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  const c = new Codex(f.store.dir);
  let second: Codex | undefined;
  try {
    await c.connect();
    const { thread } = await c.call("thread/start", {
      cwd: f.repo,
      sandbox: "read-only",
      ephemeral: false,
      dynamicTools: relayTools,
      approvalPolicy: "on-request",
    });
    assert.ok(thread.id);
    await c.call("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "Offline protocol probe only." }],
    });
    await new Promise((r) => setTimeout(r, 600));
    second = new Codex(f.store.dir, c.endpoint);
    await second.connect();
    const resumed = await second.call("thread/resume", {
      threadId: thread.id,
      cwd: f.repo,
    });
    assert.equal(resumed.thread.id, thread.id);
    const read = await c.call("thread/read", {
      threadId: thread.id,
      includeTurns: true,
    });
    assert.equal(read.thread.id, thread.id);
  } finally {
    second?.shutdown();
    const exited = c.child
      ? new Promise((r) => c.child!.once("exit", r))
      : Promise.resolve();
    c.shutdown();
    await exited;
    http.closeAllConnections();
    await new Promise<void>((r) => http.close(() => r()));
    if (previousHome) process.env.CODEX_HOME = previousHome;
    else delete process.env.CODEX_HOME;
    f.close();
  }
});
test("Installed Pi 1.0 RPC loads the Relay extension and reports a reusable native session", async () => {
  const f = fixture(),
    pi = new Pi(join(f.root, "pi", "native.jsonl"), f.repo, {
      RELAY_WORKTREE: f.repo,
      RELAY_WRITE_APPROVED: "0",
    });
  let stderr = "";
  pi.child.stderr?.on("data", (x) => (stderr += String(x)));
  try {
    const state = await pi.call("get_state");
    assert.ok(state.sessionId);
    assert.match(state.sessionFile, /native.jsonl$/);
    assert.ok(
      !/Failed to load|extension.*error|SyntaxError/i.test(stderr),
      stderr,
    );
  } finally {
    pi.shutdown();
    f.close();
  }
});
