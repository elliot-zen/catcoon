import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.ts";
import { groupActivity } from "../src/activity.ts";
import { artifact, makeRequest } from "../server/domain.ts";
import { find, id } from "../server/store.ts";
import { createApp } from "../server/index.ts";
test("One native run has one collapsed activity; requests retain separate entries", () => {
  const f = fixture();
  try {
    f.start();
    const r = f.runtime.begin(f.state().tasks[0].id, f.binding.id, "spec")!;
    f.runtime.started(r.id, r.sessionId, "turn");
    for (let n = 0; n < 50; n++)
      f.runtime.streams.codex(find(f.state().runs, r.id), {
        method: "item/agentMessage/delta",
        params: { itemId: "answer", delta: "word " },
      });
    f.store.change((s) => {
      const a = artifact(s, {
        issueId: f.issue.id,
        runId: r.id,
        title: "Spec draft",
        content: "Readable",
      });
      makeRequest(s, {
        issueId: f.issue.id,
        runId: r.id,
        kind: "approval",
        title: "Review",
        artifactIds: [a.id],
        action: { type: "review", description: "Review" },
        scope: "issue",
      });
    });
    f.runtime.complete(r.id, true, "Completed answer.", "");
    const entries = groupActivity(f.state(), f.issue.id);
    assert.equal(entries.filter((e) => e.kind === "run").length, 1);
    assert.equal(entries.filter((e) => e.kind === "request").length, 1);
    assert.equal(f.runtime.streams.items(r.id).length, 1);
    assert.equal(f.runtime.streams.items(r.id)[0].content, "word ".repeat(50));
  } finally {
    f.close();
  }
});
test("Codex Read, Exec, public thinking and answer stream in order; final snapshots replace deltas", () => {
  const f = fixture();
  try {
    f.start();
    const run = f.runtime.begin(f.state().tasks[0].id, f.binding.id, "spec")!;
    f.runtime.started(run.id, run.sessionId, "turn");
    const r = find(f.state().runs, run.id);
    const stream = (method: string, params: any) =>
      f.runtime.streams.codex(r, { method, params });
    stream("item/reasoning/textDelta", {
      itemId: "private",
      delta: "private reasoning never shared",
    });
    assert.equal(f.runtime.streams.items(r.id).length, 0);
    stream("item/started", {
      item: {
        id: "read",
        type: "commandExecution",
        command: "cat README.md",
        commandActions: [{ type: "read", path: "README.md" }],
      },
    });
    stream("item/completed", {
      item: {
        id: "read",
        type: "commandExecution",
        command: "cat README.md",
        commandActions: [{ type: "read", path: "README.md" }],
        aggregatedOutput: "file",
        exitCode: 0,
      },
    });
    stream("item/started", {
      item: { id: "exec", type: "commandExecution", command: "node --test" },
    });
    stream("item/commandExecution/outputDelta", {
      itemId: "exec",
      delta: "pass",
    });
    stream("item/completed", {
      item: {
        id: "exec",
        type: "commandExecution",
        command: "node --test",
        aggregatedOutput: "failed test",
        exitCode: 1,
      },
    });
    stream("item/reasoning/summaryTextDelta", {
      itemId: "think",
      summaryIndex: 0,
      delta: "Public summary",
    });
    stream("item/agentMessage/delta", { itemId: "answer", delta: "Partial" });
    stream("item/completed", {
      item: { id: "answer", type: "agentMessage", text: "Full answer" },
    });
    stream("item/completed", {
      item: { id: "answer", type: "agentMessage", text: "Full answer" },
    });
    const items = f.runtime.streams.items(r.id);
    assert.deepEqual(
      items.map((i) => i.kind),
      ["tool", "tool", "thinking", "answer"],
    );
    assert.equal(items[0].metadata.title, "Read README.md");
    assert.equal(items[1].metadata.title, "Exec node --test");
    assert.equal(items[1].status, "failed");
    assert.equal(items[3].content, "Full answer");
    const replay = f.runtime.streams.replay(f.issue.id, 0);
    assert.equal(
      replay.filter((e) => e.operation === "replace" && e.kind === "answer")
        .length,
      1,
    );
    const snapshot = f.runtime.streams.snapshot(f.issue.id);
    assert.equal(
      f.runtime.streams.replay(f.issue.id, snapshot.lastSeq).length,
      0,
    );
  } finally {
    f.close();
  }
});
test("Pi assistant messages and nested tool calls keep unique ordered identities", () => {
  const f = fixture();
  try {
    f.start();
    const r = f.runtime.begin(f.state().tasks[0].id, f.binding.id, "spec")!;
    f.runtime.started(r.id, r.sessionId, "pi-turn");
    const send = (m: any) =>
      f.runtime.streams.pi(find(f.state().runs, r.id), m);
    send({ type: "message_start" });
    send({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "Plan",
      },
    });
    send({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 1,
        delta: "Hello",
      },
    });
    send({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Plan complete" },
          { type: "text", text: "Hello world" },
        ],
      },
    });
    send({
      type: "tool_execution_start",
      toolCallId: "nested",
      toolName: "read",
      args: { path: "README.md" },
      parentToolCallId: "parent",
    });
    send({
      type: "tool_execution_end",
      isError: true,
      toolCallId: "nested",
      toolName: "read",
      result: { content: [{ type: "text", text: "file" }] },
      parentToolCallId: "parent",
    });
    send({ type: "message_start" });
    send({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Second answer" }],
      },
    });
    const items = f.runtime.streams.items(r.id);
    assert.equal(items.length, 4);
    assert.equal(items[1].content, "Hello world");
    assert.equal(items[2].metadata.parentToolCallId, "parent");
    assert.equal(items[2].status, "failed");
    assert.equal(items[3].content, "Second answer");
  } finally {
    f.close();
  }
});
test("Stream limits are explicit, credentials redacted, token events do not mutate business revision", () => {
  const f = fixture();
  try {
    const r = (() => {
      f.start();
      return f.runtime.begin(f.state().tasks[0].id, f.binding.id, "spec")!;
    })();
    const rev = f.state().revision;
    f.store.saveKey("private-key");
    f.runtime.streams.write(
      r,
      "out",
      "tool",
      "replace",
      "private-key " + "X".repeat(70000),
      { title: "Exec" },
    );
    assert.equal(f.state().revision, rev);
    const item = f.runtime.streams.items(r.id)[0];
    assert.equal(item.metadata.truncated, true);
    assert.ok(!item.content.includes("private-key"));
    assert.match(item.content, /Truncated/);
  } finally {
    f.close();
  }
});
test("HTTP Spec CAS, same-origin enforcement, narrow tool authorization and SSE reconnect replay", async () => {
  const f = fixture(),
    app = createApp(f.store.dir, { worker: false });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const url = "http://127.0.0.1:" + (app.server.address() as any).port;
  const mutation = (path: string, body: any, origin?: string, key = id()) =>
    fetch(url + path, {
      method: path === "/api/spec" ? "PUT" : "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
        ...(origin ? { Origin: origin } : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    const saved = await mutation(
      "/api/spec",
      {
        specId: f.tree.specId,
        document: "product",
        content: "HTTP draft",
        draftRevision: 0,
      },
      url,
    );
    assert.equal(saved.status, 200);
    assert.equal(
      (
        await mutation("/api/spec", {
          specId: f.tree.specId,
          document: "product",
          content: "stale",
          draftRevision: 0,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await mutation(
          "/api/actions",
          { type: "issue.create", payload: { title: "Bad" } },
          "https://outside.invalid",
        )
      ).status,
      403,
    );
    assert.equal(
      (await mutation("/api/runs/missing/report", { artifacts: [] })).status,
      403,
    );
    app.domain.action("issue.control", {
      issueId: f.issue.id,
      command: "start",
    });
    const r = app.runtime.begin(
      app.store.read().tasks[0].id,
      f.binding.id,
      "spec",
    )!;
    const before = app.runtime.streams.snapshot(f.issue.id);
    app.runtime.streams.write(r, "answer", "answer", "append", "first");
    const controller = new AbortController(),
      response = await fetch(url + "/api/stream?issueId=" + f.issue.id, {
        headers: { "Last-Event-ID": String(before.lastSeq) },
        signal: controller.signal,
      }),
      reader = response.body!.getReader();
    const first = await reader.read(),
      chunk = new TextDecoder().decode(first.value);
    assert.match(chunk, /event: stream/);
    assert.match(chunk, /first/);
    controller.abort();
    const state = await (await fetch(url + "/api/state")).json();
    assert.ok(!("sessions" in state));
    assert.equal(state.issues[0].sessions.length, 1);
    assert.equal(
      (
        await mutation("/api/actions", {
          type: "task.create",
          payload: { issueId: f.issue.id, text: "obsolete" },
        })
      ).status,
      400,
    );
  } finally {
    await app.close();
    f.close();
  }
});

test("Recovery backfills authoritative native items and replaces interrupted stream fragments", () => {
  const f = fixture("codex");
  try {
    f.start();
    const r = f.runtime.begin(f.state().tasks[0].id, f.binding.id, "spec")!;
    f.runtime.started(r.id, r.sessionId, "turn");
    f.runtime.streams.codex(find(f.state().runs, r.id), {
      method: "item/agentMessage/delta",
      params: { itemId: "answer", delta: "partial" },
    });
    f.domain.recover();
    f.runtime.turnResult(r.id, {
      id: "turn",
      status: "completed",
      items: [
        {
          id: "read",
          type: "commandExecution",
          command: "cat README.md",
          commandActions: [{ type: "read", path: "README.md" }],
          aggregatedOutput: "authoritative file",
          exitCode: 0,
        },
        {
          id: "answer",
          type: "agentMessage",
          text: "Complete recovered answer",
        },
      ],
    });
    const items = f.runtime.streams.items(r.id);
    assert.equal(
      items.find((x) => x.kind === "answer")!.content,
      "Complete recovered answer",
    );
    assert.equal(
      items.find((x) => x.kind === "tool")!.content,
      "authoritative file",
    );
    assert.equal(find(f.state().runs, r.id).status, "completed");
    assert.equal(f.store.db.prepare("SELECT * FROM locks").all().length, 0);
    assert.ok(
      !f
        .state()
        .requests.some(
          (q) => q.inputClass === "recovery" && q.status === "Pending",
        ),
    );
    const count = f.runtime.streams.replay(f.issue.id, 0).length;
    f.runtime.turnResult(r.id, { id: "turn", status: "completed", items: [] });
    assert.equal(f.runtime.streams.replay(f.issue.id, 0).length, count);
  } finally {
    f.close();
  }
});
test("Native tool metadata is redacted and oversized titles cannot bypass event bounds", () => {
  const f = fixture();
  try {
    f.start();
    const r = f.runtime.begin(f.state().tasks[0].id, f.binding.id, "spec")!;
    f.store.saveKey("private-key");
    f.runtime.streams.write(
      r,
      "call",
      "tool",
      "replace",
      "\u0001".repeat(70000),
      {
        title: "X".repeat(70000),
        parameters: {
          Authorization: "Bearer private-key",
          apiKey: "secret-value",
        },
      },
    );
    f.runtime.streams.write(r, "call", "tool", "append", "done");
    const item = f.runtime.streams.items(r.id)[0];
    assert.equal(item.metadata.truncated, true);
    const replay = f.runtime.streams.replay(f.issue.id, 0);
    assert.ok(
      replay.every((e) => Buffer.byteLength(JSON.stringify(e)) <= 65536),
    );
    assert.ok(!JSON.stringify(replay).includes("private-key"));
    assert.ok(!JSON.stringify(replay).includes("secret-value"));
  } finally {
    f.close();
  }
});
