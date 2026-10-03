import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { Codex } from "../server/agents/codex.ts";
import { Rpc } from "../server/agents/rpc.ts";
import { Store, id, find } from "../server/store.ts";
import { Domain } from "../server/domain.ts";
import { Runtime } from "../server/runtime.ts";
import { groupActivity } from "../src/activity.ts";
import type { Issue, Project, Worktree, Binding } from "../server/types.ts";
async function until(predicate: () => boolean) {
  for (let n = 0; n < 200; n++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(predicate(), "Expected state did not arrive");
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "relay-native-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  const store = new Store(join(root, "data"));
  const domain = new Domain(store);
  store.change((s) =>
    s.agents.push({
      id: "codex",
      name: "Codex",
      command: "codex",
      version: "0.160.0",
      status: "available",
      heartbeat: "",
      reason: "",
    }),
  );
  const issue = domain.action("issue.create", {
    title: "Native work",
  }) as Issue;
  const project = domain.action("project.create", {
    name: "Native",
    path: repo,
  }) as Project;
  const tree = domain.action("worktree.create", {
    projectId: project.id,
    name: "Main",
    path: repo,
    branch: "main",
    specName: "Native",
    specDir: "docs",
  }) as Worktree;
  const binding = domain.action("binding.save", {
    issueId: issue.id,
    projectId: project.id,
    worktreeId: tree.id,
    agentId: "codex",
    description: "Native tools",
  }) as Binding;
  const runtime = new Runtime(store);
  const begin = () => {
    domain.action("issue.control", { issueId: issue.id, command: "start" });
    const task = store.read().tasks[0];
    return runtime.begin(task.id, binding.id, "Return actual evidence", 0)!;
  };
  return {
    root,
    repo,
    store,
    domain,
    runtime,
    binding,
    issue,
    begin,
    close() {
      runtime.shutdown();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function peer() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => server.once("listening", r));
  const endpoint = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  let thread: any = {
    id: "thread-1",
    cwd: "",
    status: { type: "idle" },
    turns: [],
  };
  const calls: string[] = [];
  const replies: any[] = [];
  const clients: WebSocket[] = [];
  let auto = false;
  const notify = (method: string, params: any) => {
    for (const c of clients)
      if (c.readyState === 1)
        c.send(
          JSON.stringify({
            method,
            params: { threadId: thread.id, ...params },
          }),
        );
  };
  const finish = (status = "completed") => {
    const turn = thread.turns.at(-1);
    turn.status = status;
    turn.items = [
      {
        type: "agentMessage",
        text: JSON.stringify({
          summary: "Completed",
          artifacts: [
            {
              kind: "report",
              title: "Native evidence",
              content: "Observed completion",
            },
          ],
        }),
      },
    ];
    thread.status = { type: "idle" };
    notify("item/completed", { turnId: turn.id, item: turn.items[0] });
    notify("turn/completed", { turn });
  };
  server.on("connection", (c) => {
    clients.push(c);
    c.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (!m.method) {
        replies.push(m);
        return;
      }
      calls.push(m.method);
      let result: any = {};
      if (m.method === "thread/start") {
        thread.cwd = m.params.cwd;
        result = { thread };
      }
      if (["thread/resume", "thread/read"].includes(m.method))
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
        if (auto) setTimeout(() => finish(), 25);
      }
      if (m.method === "turn/interrupt")
        setTimeout(() => finish("interrupted"), 20);
      if (m.id !== undefined) c.send(JSON.stringify({ id: m.id, result }));
    });
  });
  return {
    endpoint,
    calls,
    replies,
    notify,
    finish,
    get thread() {
      return thread;
    },
    set auto(value: boolean) {
      auto = value;
    },
    request(method: string, params: any, rpcId = "native-approval") {
      clients[0].send(
        JSON.stringify({
          id: rpcId,
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
      for (const c of clients) c.terminate();
      server.close();
    },
  };
}
test("RPC distinguishes colliding server request IDs from responses", async () => {
  const rpc = new Rpc(() => {});
  let serverRequest = false;
  rpc.on("message", () => (serverRequest = true));
  const call = rpc.call("initialize");
  rpc.receive({ id: "relay-1", method: "approval", params: {} });
  assert.equal(rpc.pending.size, 1);
  assert.ok(serverRequest);
  rpc.receive({ id: "relay-1", result: { ok: true } });
  assert.deepEqual(await call, { ok: true });
});
test("Codex native notification precedes response, shared thread joins, and exact completion ingests once", async () => {
  const f = fixture();
  const p = await peer();
  const old = process.env.CODEX_APP_SERVER_ENDPOINT;
  process.env.CODEX_APP_SERVER_ENDPOINT = p.endpoint;
  let terminal: Codex | undefined;
  try {
    p.auto = true;
    const run = f.begin();
    f.runtime.launch(run);
    await until(() => f.store.read().runs[0].status === "completed");
    const s = f.store.read();
    assert.ok(s.runs[0].nativeTurnId);
    assert.equal(s.sessions[0].threadId, "thread-1");
    assert.equal(s.artifacts.length, 1);
    assert.equal(s.events.filter((e) => e.type === "run.started").length, 1);
    assert.equal(f.store.db.prepare("SELECT * FROM locks").all().length, 0);
    terminal = new Codex(f.root, p.endpoint);
    await terminal.connect();
    const joined = await terminal.call("thread/resume", {
      threadId: s.sessions[0].threadId,
    });
    assert.equal(joined.thread.id, s.sessions[0].threadId);
    assert.equal(joined.thread.turns[0].id, s.runs[0].nativeTurnId);
    p.notify("turn/completed", { turn: p.thread.turns[0] });
    assert.equal(f.store.read().artifacts.length, 1);
    assert.equal(p.calls.filter((c) => c === "turn/start").length, 1);
  } finally {
    terminal?.shutdown();
    f.close();
    p.close();
    if (old) process.env.CODEX_APP_SERVER_ENDPOINT = old;
    else delete process.env.CODEX_APP_SERVER_ENDPOINT;
  }
});
test("native approvals require Human decision, external resolution is not business approval", async () => {
  const f = fixture();
  const p = await peer();
  const old = process.env.CODEX_APP_SERVER_ENDPOINT;
  process.env.CODEX_APP_SERVER_ENDPOINT = p.endpoint;
  try {
    const run = f.begin();
    f.runtime.launch(run);
    await until(() => f.store.read().runs[0].status === "running");
    p.request("item/commandExecution/requestApproval", {
      command: "git status",
      reason: "Inspect repository",
    });
    await until(() => f.store.read().requests.length === 1);
    const q = f.store.read().requests[0];
    assert.equal(q.status, "Pending");
    assert.equal(p.replies.length, 0);
    await f.runtime.decideNative(
      { requestId: q.id, revision: 0, decision: "approve" },
      id(),
    );
    await until(() => p.replies.length === 1);
    assert.deepEqual(p.replies[0].result, { decision: "accept" });
    assert.equal(f.store.read().requests[0].decidedBy, "Human");
    p.request(
      "item/fileChange/requestApproval",
      { reason: "Proposed change" },
      "external",
    );
    await until(() => f.store.read().requests.length === 2);
    p.notify("serverRequest/resolved", { requestId: "external" });
    await until(
      () => f.store.read().requests[1].status === "Resolved externally",
    );
    assert.equal(f.store.read().requests[1].decidedBy, undefined);
    assert.equal(p.replies.length, 1);
    p.finish();
    await until(() => f.store.read().runs[0].status === "completed");
  } finally {
    f.close();
    p.close();
    if (old) process.env.CODEX_APP_SERVER_ENDPOINT = old;
    else delete process.env.CODEX_APP_SERVER_ENDPOINT;
  }
});
test("terminal active turn locks worktree; disconnect preserves unknown and restart collects exact terminal state without replay", async () => {
  const f = fixture();
  const p = await peer();
  const old = process.env.CODEX_APP_SERVER_ENDPOINT;
  process.env.CODEX_APP_SERVER_ENDPOINT = p.endpoint;
  let recovery: Runtime | undefined;
  try {
    const run = f.begin();
    f.runtime.launch(run);
    await until(() => f.store.read().runs[0].status === "running");
    f.runtime.codex!.socket!.terminate();
    await until(() => f.store.read().runs[0].status === "unknown");
    assert.equal(f.store.db.prepare("SELECT * FROM locks").all().length, 1);
    p.finish();
    f.runtime.shutdown();
    recovery = new Runtime(f.store);
    await recovery.recoverNative();
    assert.equal(f.store.read().runs[0].status, "completed");
    assert.equal(p.calls.filter((c) => c === "turn/start").length, 1);
    assert.equal(f.store.read().artifacts.length, 1);
    p.thread.status = { type: "active" };
    p.thread.turns.push({
      id: "terminal-turn",
      status: "inProgress",
      items: [],
    });
    p.notify("turn/started", { turn: p.thread.turns.at(-1) });
    await until(
      () => f.store.read().sessions[0].busyTurnId === "terminal-turn",
    );
    assert.equal(f.store.db.prepare("SELECT * FROM locks").all().length, 1);
    await assert.rejects(
      () => recovery!.prepareCodex(f.binding.id, f.repo),
      /busy/,
    );
    p.notify("item/completed", {
      turnId: "terminal-turn",
      item: { type: "agentMessage", text: "Terminal response" },
    });
    await until(() =>
      f.store
        .read()
        .events.some(
          (e) =>
            e.type === "step" &&
            (e.data as any)?.nativeTurnId === "terminal-turn",
        ),
    );
    p.finish();
    await until(
      () => f.store.db.prepare("SELECT * FROM locks").all().length === 0,
    );
    assert.equal(f.store.read().artifacts.length, 1);
    const terminalRows = groupActivity(f.store.read(), f.issue.id).filter(
      (r) => r.kind === "terminal",
    );
    assert.equal(terminalRows.length, 1);
    assert.equal(terminalRows[0].turnId, "terminal-turn");
    assert.deepEqual(
      terminalRows[0].events.map((e) => e.type),
      ["session.running", "step", "step", "session.completed"],
    );
  } finally {
    recovery?.shutdown();
    f.close();
    p.close();
    if (old) process.env.CODEX_APP_SERVER_ENDPOINT = old;
    else delete process.env.CODEX_APP_SERVER_ENDPOINT;
  }
});
test(
  "installed Codex app-server supports two independent Unix clients on one persisted thread",
  { timeout: 30000 },
  async () => {
    execFileSync("codex", ["--version"], { stdio: "ignore" });
    const root = mkdtempSync(join(tmpdir(), "relay-real-codex-"));
    const home = join(root, "home");
    mkdirSync(home);
    const http = createServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: { message: "Local isolated protocol probe" } }),
      );
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    writeFileSync(
      join(home, "config.toml"),
      `model_provider="probe"\n[model_providers.probe]\nname="Probe"\nbase_url="http://127.0.0.1:${(http.address() as { port: number }).port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`,
    );
    const oldHome = process.env.CODEX_HOME;
    const oldEndpoint = process.env.CODEX_APP_SERVER_ENDPOINT;
    process.env.CODEX_HOME = home;
    delete process.env.CODEX_APP_SERVER_ENDPOINT;
    const a = new Codex(root);
    const b = new Codex(root, a.endpoint);
    try {
      await a.connect();
      const started = await a.call("thread/start", {
        cwd: root,
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        ephemeral: false,
      });
      await a.call("turn/start", {
        threadId: started.thread.id,
        input: [{ type: "text", text: "Local protocol probe only" }],
      });
      await new Promise((r) => setTimeout(r, 600));
      await b.connect();
      const joined = await b.call("thread/resume", {
        threadId: started.thread.id,
      });
      assert.equal(joined.thread.id, started.thread.id);
      assert.equal(joined.thread.cwd, root);
    } finally {
      const child = a.child;
      const exited = child
        ? new Promise((r) => child.once("exit", r))
        : Promise.resolve();
      b.shutdown();
      a.shutdown();
      await exited;
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
      rmSync(root, { recursive: true, force: true });
      if (oldHome) process.env.CODEX_HOME = oldHome;
      else delete process.env.CODEX_HOME;
      if (oldEndpoint) process.env.CODEX_APP_SERVER_ENDPOINT = oldEndpoint;
      else delete process.env.CODEX_APP_SERVER_ENDPOINT;
    }
  },
);
test("schema 1 migration preserves unknown locks and initializes UI metadata without guessing sessions", () => {
  const f = fixture();
  let reopened: Store | undefined;
  try {
    const run = f.begin();
    f.domain.recover();
    f.store.change((s) => {
      s.schemaVersion = 1;
      delete (s as any).sessions;
      delete (s as any).labelCatalog;
    });
    f.runtime.shutdown();
    f.store.close();
    reopened = new Store(join(f.root, "data"));
    const state = reopened.read();
    assert.equal(state.schemaVersion, 2);
    assert.deepEqual(state.sessions, []);
    assert.equal(state.issues[0].priority, 0);
    assert.deepEqual(state.issues[0].labels, []);
    assert.equal(state.runs[0].status, "unknown");
    assert.equal(state.runs[0].nativeTurnId, undefined);
    assert.equal(
      (
        reopened.db.prepare("SELECT * FROM locks").all()[0] as {
          run_id: string;
        }
      ).run_id,
      run.id,
    );
  } finally {
    reopened?.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test("Issue priority/labels validate, persist, and reject obsolete metadata updates", () => {
  const f = fixture();
  try {
    const current = find(f.store.read().issues, f.issue.id);
    const updated = f.domain.action("issue.update", {
      issueId: current.id,
      revision: current.revision,
      priority: 2,
      labels: ["Feature", "New label"],
    }) as Issue;
    assert.equal(updated.priority, 2);
    assert.deepEqual(updated.labels, ["Feature", "New label"]);
    assert.ok(f.store.read().labelCatalog.some((l) => l.name === "New label"));
    assert.throws(
      () =>
        f.domain.action("issue.update", {
          issueId: current.id,
          revision: current.revision,
          priority: 3,
        }),
      /changed/,
    );
    assert.throws(
      () =>
        f.domain.action("issue.update", {
          issueId: current.id,
          revision: updated.revision,
          priority: 5,
        }),
      /priority/,
    );
  } finally {
    f.close();
  }
});
test("Pi settled honors assistant error and zero-exit disconnection stays unknown", async () => {
  const oldPath = process.env.PATH;
  for (const mode of ["error", "exit"]) {
    const f = fixture();
    try {
      f.store.change((s) =>
        s.agents.push({
          id: "pi",
          name: "Pi",
          command: "pi",
          version: "1.0.0",
          status: "available",
          heartbeat: "",
          reason: "",
        }),
      );
      const b = f.domain.action("binding.save", {
        issueId: f.issue.id,
        projectId: f.store.read().projects[0].id,
        worktreeId: f.store.read().worktrees[0].id,
        agentId: "pi",
        description: "Pi error fixture",
      }) as Binding;
      const bin = join(f.root, "bin");
      mkdirSync(bin);
      writeFileSync(
        join(bin, "pi"),
        `#!/usr/bin/env node
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);console.log(JSON.stringify({id:m.id,type:'response',success:true,data:{sessionId:'real-pi'}}));if(m.type==='prompt'){if('${mode}'==='exit')process.exit(0);console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'Provider failed',content:[{type:'text',text:'partial output'}]}}));console.log(JSON.stringify({type:'agent_end',willRetry:true}));setTimeout(()=>console.log(JSON.stringify({type:'agent_settled'})),120);}});
`,
        { mode: 0o755 },
      );
      process.env.PATH = bin + ":" + oldPath;
      f.domain.action("issue.control", {
        issueId: f.issue.id,
        command: "start",
      });
      const t = f.store.read().tasks[0];
      const run = f.runtime.begin(t.id, b.id, "Fixture prompt", 0)!;
      f.runtime.launch(run);
      if (mode === "error") {
        await until(() =>
          f.store
            .read()
            .events.some((e) => (e.data as any)?.type === "agent_end"),
        );
        assert.equal(f.store.read().runs[0].status, "running");
        assert.equal(f.store.db.prepare("SELECT * FROM locks").all().length, 1);
        await until(() => f.store.read().runs[0].status === "failed");
        assert.equal(f.store.read().tasks[0].status, "waiting");
        assert.equal(f.store.db.prepare("SELECT * FROM locks").all().length, 0);
      } else {
        await until(() => f.store.read().runs[0].status === "unknown");
        assert.equal(f.store.read().tasks[0].status, "unknown");
        assert.equal(f.store.db.prepare("SELECT * FROM locks").all().length, 1);
      }
    } finally {
      f.close();
      process.env.PATH = oldPath;
    }
  }
});
test("lost stop acknowledgement remains stopped after precise native recovery, without ingesting follow-ups", async () => {
  const f = fixture();
  const p = await peer();
  const old = process.env.CODEX_APP_SERVER_ENDPOINT;
  process.env.CODEX_APP_SERVER_ENDPOINT = p.endpoint;
  let recovery: Runtime | undefined;
  try {
    f.runtime.launch(f.begin());
    await until(() => f.store.read().runs[0].status === "running");
    f.domain.action("issue.control", {
      issueId: f.issue.id,
      command: "stop",
      text: "Inspect the existing changes",
    });
    f.runtime.codex!.socket!.terminate();
    await until(() => f.store.read().runs[0].status === "unknown");
    assert.equal(f.store.read().runs[0].stopRequested, true);
    p.finish();
    f.runtime.shutdown();
    recovery = new Runtime(f.store);
    await recovery.recoverNative();
    assert.equal(f.store.read().runs[0].status, "stopped");
    assert.ok(
      !f.store.read().artifacts.some((a) => a.title === "Native evidence"),
    );
    assert.equal(f.store.db.prepare("SELECT * FROM locks").all().length, 0);
  } finally {
    recovery?.shutdown();
    f.close();
    p.close();
    if (old) process.env.CODEX_APP_SERVER_ENDPOINT = old;
    else delete process.env.CODEX_APP_SERVER_ENDPOINT;
  }
});
