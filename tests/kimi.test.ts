import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { kimi, kimiModes, kimiResponse } from "../server/runtime/kimi.js";
import { JsonProcess } from "../server/runtime/process.js";
import { Orchestrator } from "../server/orchestrator.js";
import { Store } from "../server/store.js";
import { createApp } from "../server/app.js";
import { sessionTools } from "../src/session-tools.js";
import type {
  ApprovalLevel,
  Binding,
  HumanRequest,
  Message,
  RuntimeCallbacks,
  RuntimeHandle,
} from "../server/types.js";

const pause = () => new Promise((r) => setTimeout(r, 10));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 250; i++) {
    if (predicate()) return;
    await pause();
  }
  assert.fail("Kimi fixture did not reach the expected state");
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "catcoon-kimi-"));
  const cwd = join(dir, "project 中文");
  mkdirSync(cwd);
  const bin = join(dir, "kimi");
  copyFileSync(resolve("tests/fixtures/kimi.mjs"), bin);
  chmodSync(bin, 0o755);
  const previous = process.env.KIMI_BIN;
  process.env.KIMI_BIN = bin;
  return {
    dir,
    cwd,
    bin,
    cleanup: () => {
      if (previous === undefined) delete process.env.KIMI_BIN;
      else process.env.KIMI_BIN = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function run(
  cwd: string,
  scenario: string,
  approvalLevel: ApprovalLevel = "strict",
  sessionId: string | null = null,
) {
  const requests: HumanRequest[] = [],
    messages: Message[] = [];
  let output: string | undefined,
    error: Error | undefined,
    session = "",
    completedAt = 0;
  let close!: () => void;
  const closed = new Promise<void>((r) => {
    close = r;
  });
  const callbacks: RuntimeCallbacks = {
    spawned: (pid) => assert.ok(pid > 0),
    session: (id) => {
      session = id;
    },
    message: (kind, text) =>
      messages.push({
        id: messages.length + 1,
        kind,
        text,
        turnId: "t",
        createdAt: new Date().toISOString(),
      }),
    request: (request) =>
      requests.push({
        ...request,
        id: `r${requests.length}`,
        issueId: "i",
        turnId: "t",
        status: "pending",
        answer: null,
        createdAt: new Date().toISOString(),
      }),
    complete: (text) => {
      output = text;
      completedAt = Date.now();
    },
    error: (e) => {
      error = e;
    },
    closed: close,
  };
  const binding: Binding = {
    id: "b",
    issueId: "i",
    name: "Kimi Code",
    runtime: "kimi",
    role: "Implement",
    cwd,
    model: "kimi-code/test-model",
    approvalLevel,
    sessionId,
  };
  const handle = kimi(binding, `KIMI_SCENARIO=${scenario}`, callbacks);
  return {
    handle,
    closed,
    requests,
    messages,
    state: () => ({ output, error, session, completedAt }),
  };
}

for (const [level, approved] of [
  ["strict", true],
  ["strict", false],
  ["on-request", true],
  ["automatic", true],
] as [ApprovalLevel, boolean][]) {
  test(
    `Kimi ACP: ${level}, ${approved ? "approve" : "reject"}, native policy and lifecycle`,
    { timeout: 5000 },
    async () => {
      const f = fixture();
      const r = run(
        f.cwd,
        "approval",
        level,
        level === "strict" ? null : "saved-kimi-session",
      );
      try {
        await until(
          () => !!r.requests.length || !!r.state().output || !!r.state().error,
        );
        if (level === "automatic") assert.equal(r.requests.length, 0);
        else {
          assert.equal(r.requests.length, 1);
          assert.equal(r.state().output, undefined);
          await assert.rejects(r.handle.send("Do more"), /waiting for a human/);
          r.handle.respond(
            r.requests[0],
            approved ? "" : "Revise the operation",
            approved,
          );
        }
        await r.closed;
        assert.equal(r.state().error, undefined);
        assert.match(
          r.state().output!,
          approved ? /Approved work finished/ : /Rejected; no tool executed/,
        );
        assert.match(r.state().output!, /\u2028/);
        assert.equal(
          r.state().session,
          level === "strict" ? "test-kimi-session" : "saved-kimi-session",
        );
        const data = r.messages
          .filter((m) => m.kind === "tool" && m.text.startsWith("{"))
          .map((m) => JSON.parse(m.text))
          .find((m) => m.toolCallId === "configuration").rawInput;
        assert.equal(data.mode, kimiModes[level]);
        assert.equal(data.model, "kimi-code/test-model");
        assert.equal(data.processCwd, f.cwd);
        const tools = sessionTools(r.messages);
        assert.equal(
          tools.some((t) => t.id === "replayed-tool"),
          false,
        );
        const operation = tools.find((t) => t.id === "operation")!;
        assert.equal(operation.label, "Bash");
        assert.equal(operation.status, approved ? "completed" : "failed");
        const response = JSON.parse(operation.detail).rawOutput[0].result;
        assert.equal(
          response.outcome.optionId,
          approved ? "approve_once" : "reject",
        );
        await assert.rejects(r.handle.send("Too late"), /turn ended/);
      } finally {
        await r.handle.stop();
        f.cleanup();
      }
    },
  );
}

test(
  "Kimi ACP queues concurrent permissions and waits for the final prompt response",
  { timeout: 5000 },
  async () => {
    const f = fixture();
    const r = run(f.cwd, "parallel");
    try {
      await until(() => r.requests.length > 0);
      await pause();
      assert.equal(r.requests.length, 1);
      r.handle.respond(r.requests[0], "", true);
      await until(() => r.requests.length === 2);
      assert.equal(r.state().output, undefined);
      assert.notEqual(r.requests[0].native!.id, r.requests[1].native!.id);
      r.handle.respond(r.requests[1], "", true);
      await until(() =>
        r.messages.some((m) => m.text === "Approved work finished."),
      );
      assert.equal(
        r.state().output,
        undefined,
        "Text stream ending must not complete the turn",
      );
      await r.closed;
      assert.equal(r.state().error, undefined);
      assert.match(r.state().output!, /Approved work finished/);
    } finally {
      await r.handle.stop();
      f.cleanup();
    }
  },
);

for (const scenario of ["question", "choices", "form", "url"]) {
  test(
    `Kimi ACP preserves ${scenario} human decisions even in automatic mode`,
    { timeout: 5000 },
    async () => {
      const f = fixture();
      const r = run(f.cwd, scenario, "automatic");
      try {
        await until(() => r.requests.length > 0 || !!r.state().error);
        assert.equal(r.state().error, undefined);
        const request = r.requests[0];
        assert.equal(request.kind, scenario === "url" ? "approval" : "input");
        if (scenario === "form") {
          assert.throws(
            () => r.handle.respond(request, '{"q0":"Server"}', false),
            /Invalid Kimi form/,
          );
          assert.throws(
            () =>
              r.handle.respond(request, '{"q0":"Other","q1":["API"]}', false),
            /Invalid Kimi form/,
          );
          r.handle.respond(request, '{"q0":"Server","q1":["API","UI"]}', false);
        } else
          r.handle.respond(
            request,
            scenario === "question"
              ? "Server"
              : scenario === "choices"
                ? "Plan B"
                : "Verified",
            true,
          );
        await r.closed;
        assert.equal(r.state().error, undefined);
        assert.match(r.state().output!, /Approved work finished/);
      } finally {
        await r.handle.stop();
        f.cleanup();
      }
    },
  );
}

test(
  "Kimi ACP falls back to load and ignores replayed messages",
  { timeout: 5000 },
  async () => {
    const f = fixture();
    process.env.KIMI_FIXTURE_LOAD = "1";
    const r = run(f.cwd, "finish", "strict", "saved-session");
    delete process.env.KIMI_FIXTURE_LOAD;
    try {
      await r.closed;
      assert.equal(r.state().error, undefined);
      assert.equal(r.state().session, "saved-session");
      assert.doesNotMatch(r.state().output!, /Old answer/);
      assert.equal(
        r.messages.some((m) => m.text.includes("Old tool")),
        false,
      );
    } finally {
      await r.handle.stop();
      f.cleanup();
    }
  },
);

for (const [scenario, pattern] of [
  ["error", /Authentication required/],
  ["disconnect", /disconnected/],
  ["unknown", /Unsupported Kimi request/],
  ["refusal", /refusal/],
  ["empty", /without an answer/],
] as const) {
  test(`Kimi ACP fails visibly on ${scenario}`, { timeout: 5000 }, async () => {
    const f = fixture();
    const r = run(f.cwd, scenario);
    try {
      await r.closed;
      assert.equal(r.state().output, undefined);
      assert.match(r.state().error!.message, pattern);
    } finally {
      await r.handle.stop();
      f.cleanup();
    }
  });
}

test(
  "Kimi ACP rejects unavailable permission modes before running tools",
  { timeout: 5000 },
  async () => {
    const f = fixture();
    process.env.KIMI_FIXTURE_BAD_MODE = "1";
    const r = run(f.cwd, "approval");
    delete process.env.KIMI_FIXTURE_BAD_MODE;
    try {
      await r.closed;
      assert.match(r.state().error!.message, /configured approval mode/);
      assert.equal(r.requests.length, 0);
      assert.equal(r.messages.length, 0);
    } finally {
      await r.handle.stop();
      f.cleanup();
    }
  },
);

test(
  "Kimi ACP stops an active turn and rejects unsupported steering",
  { timeout: 5000 },
  async () => {
    const f = fixture();
    const r = run(f.cwd, "wait");
    try {
      await assert.rejects(
        r.handle.send("Follow-up"),
        /does not support messages during an active turn/,
      );
      await r.handle.stop();
      await r.closed;
      assert.equal(r.state().error, undefined);
      assert.equal(r.state().output, undefined);
    } finally {
      await r.handle.stop();
      f.cleanup();
    }
  },
);

test(
  "ACP long-running prompt requests have no control-RPC timeout",
  { timeout: 5000 },
  async () => {
    const f = fixture();
    const rpc = new JsonProcess(f.bin, ["acp"], f.cwd, process.env, true);
    try {
      const prompt = rpc
        .request("unanswered-prompt", {}, false, null)
        .catch((e: Error) => e);
      assert.equal(rpc.pending.get(String(rpc.seq))!.timer, undefined);
      await rpc.terminate();
      assert.match((await prompt).message, /process exited/);
      assert.equal(rpc.pending.size, 0);
    } finally {
      await rpc.terminate();
      f.cleanup();
    }
  },
);

test(
  "Kimi binding API, default factory, approval queue, Stop/Start and session chat",
  { timeout: 10000 },
  async () => {
    const f = fixture();
    const store = new Store(join(f.dir, "workflow.sqlite"));
    const engine = new Orchestrator(store, {
      route: async (d) =>
        d.turns.some((t) => t.status === "completed")
          ? { action: "done", detail: "Verified Kimi result" }
          : {
              action: "agent",
              bindingId: d.bindings[0].id,
              detail: "KIMI_SCENARIO=parallel",
            },
    });
    const id = engine.createIssue(
      "Integrate Kimi",
      "Verify native approvals",
    ).id;
    const server = createApp(engine).listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const config = await (await fetch(base + "/api/config")).json();
      assert.deepEqual(config.runtimes, ["codex", "pi", "kimi"]);
      assert.equal(config.runtimeAvailable.kimi, true);
      const response = await fetch(`${base}/api/issues/${id}/bindings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Kimi Code",
          runtime: "kimi",
          role: "Implement",
          cwd: f.cwd,
        }),
      });
      assert.equal(response.status, 201);
      const binding = store.bindings(id)[0];
      assert.equal(binding.approvalLevel, "strict");
      assert.equal(store.turns(id).length, 0, "Binding must not spawn Kimi");
      engine.start(id);
      await until(() => store.issue(id)?.status === "waiting_human");
      const first = store.pending(id)!;
      engine.stop(id);
      assert.equal(store.issue(id)?.status, "stopped");
      assert.throws(
        () => engine.respond(id, first.id, "", true),
        /Start the issue/,
      );
      engine.start(id);
      engine.respond(id, first.id, "", true);
      await until(
        () =>
          store.pending(id)?.id !== first.id &&
          store.issue(id)?.status === "waiting_human",
      );
      engine.respond(id, store.pending(id)!.id, "", true);
      await until(() => store.issue(id)?.status === "done");
      assert.equal(store.turns(id).length, 1);
      assert.equal(store.turns(id)[0].status, "completed");
      assert.equal(store.bindings(id)[0].sessionId, "test-kimi-session");
      await engine.message(id, binding.id, "KIMI_SCENARIO=finish", null);
      await until(() =>
        ["done", "stopped", "waiting_human"].includes(store.issue(id)!.status),
      );
      assert.equal(
        store.issue(id)?.status,
        "done",
        store.issue(id)?.stopReason || "Chat should preserve Done",
      );
      assert.equal(store.turns(id).length, 2);
      assert.equal(store.bindings(id)[0].sessionId, "test-kimi-session");
      assert.match(store.turns(id)[1].output, /Task completed/);
    } finally {
      await engine.shutdown();
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
      f.cleanup();
    }
  },
);

test(
  "invalid Kimi form submission remains pending in the orchestrator",
  { timeout: 5000 },
  async () => {
    const f = fixture();
    const store = new Store(":memory:");
    const engine = new Orchestrator(store, {
      route: async (d) => ({
        action: "agent",
        bindingId: d.bindings[0].id,
        detail: "KIMI_SCENARIO=form",
      }),
    });
    const id = engine.createIssue("Question", "Need real input").id;
    engine.bind(id, {
      name: "Kimi Code",
      runtime: "kimi",
      role: "Implement",
      cwd: f.cwd,
      model: "",
    });
    try {
      engine.start(id);
      await until(() => store.issue(id)?.status === "waiting_human");
      const request = store.pending(id)!;
      assert.throws(
        () => engine.respond(id, request.id, "invalid", false),
        /JSON object/,
      );
      assert.equal(store.issue(id)?.status, "waiting_human");
      assert.equal(store.pending(id)?.id, request.id);
      engine.stop(id);
    } finally {
      await engine.shutdown();
      store.close();
      f.cleanup();
    }
  },
);

test("Kimi permission decisions are one-time and never grant session-wide access", () => {
  const native = {
    method: "session/request_permission",
    params: {
      options: [
        { optionId: "all", name: "Always", kind: "allow_always" },
        { optionId: "once", name: "Once", kind: "allow_once" },
      ],
    },
  };
  assert.deepEqual(kimiResponse(native, "", true), {
    outcome: { outcome: "selected", optionId: "once" },
  });
  assert.deepEqual(kimiResponse(native, "Revise", false), {
    outcome: { outcome: "cancelled" },
  });
});
