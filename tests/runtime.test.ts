import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { codex } from "../server/runtime/codex.js";
import { pi } from "../server/runtime/pi.js";
import type {
  Binding,
  ApprovalLevel,
  HumanRequest,
  RuntimeCallbacks,
} from "../server/types.js";
for (const [name, factory] of [
  ["codex", codex],
  ["pi", pi],
] as const) {
  test(
    `${name}: chat waits for startup, reports steer errors and accepts follow-ups`,
    { timeout: 5000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "catcoon-chat-"));
      const bin = join(dir, name);
      copyFileSync(resolve(`tests/fixtures/${name}.mjs`), bin);
      chmodSync(bin, 0o755);
      const env = name === "codex" ? "CODEX_BIN" : "PI_BIN";
      const previous = process.env[env];
      process.env[env] = bin;
      let handle: ReturnType<typeof codex> | undefined;
      try {
        const messages: string[] = [];
        let completed = false;
        let close!: () => void;
        let fail!: (e: Error) => void;
        const closed = new Promise<void>((resolve, reject) => {
          close = resolve;
          fail = reject;
        });
        handle = factory(
          {
            id: "b",
            issueId: "i",
            name,
            runtime: name,
            role: "Chat",
            cwd: process.cwd(),
            model: "",
            approvalLevel: "on-request",
            sessionId: "existing-session",
          },
          "Chat prompt",
          {
            spawned() {},
            session() {},
            message: (_kind, text) => messages.push(text),
            request: () => fail(new Error("Unexpected human request")),
            complete: () => {
              completed = true;
            },
            error: fail,
            closed: close,
          },
        );
        await assert.rejects(handle.send("Reject steer"), /Steer rejected/);
        await handle.send("Follow-up 中文");
        await closed;
        assert.ok(completed);
        assert.ok(
          messages.some((message) =>
            message.includes("Received: Follow-up 中文"),
          ),
        );
        await assert.rejects(handle.send("Too late"), /turn ended/);
      } finally {
        handle?.dispose();
        if (previous === undefined) delete process.env[env];
        else process.env[env] = previous;
        rmSync(dir, { recursive: true });
      }
    },
  );
}
for (const [name, factory] of [
  ["codex", codex],
  ["pi", pi],
] as const) {
  for (const [approvalLevel, approved] of [
    ["strict", true],
    ["on-request", true],
    ["strict", false],
    ["automatic", true],
  ] as [ApprovalLevel, boolean][]) {
    test(`${name}: ${approvalLevel}, ${approved ? "accept" : "reject"}, subprocess policy and completion`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "catcoon-runtime-"));
      const bin = join(dir, name);
      copyFileSync(resolve(`tests/fixtures/${name}.mjs`), bin);
      chmodSync(bin, 0o755);
      const env = name === "codex" ? "CODEX_BIN" : "PI_BIN";
      const previous = process.env[env];
      process.env[env] = bin;
      try {
        const binding: Binding = {
          id: "binding",
          issueId: "issue",
          name,
          runtime: name,
          approvalLevel,
          role: "Test",
          cwd: process.cwd(),
          model: "",
          sessionId: approvalLevel !== "strict" ? "existing-session" : null,
        };
        let request!: HumanRequest;
        let output = "",
          session = "",
          complete = false;
        const messages: string[] = [];
        let approvedAt = 0;
        let close!: (v?: unknown) => void;
        let fail!: (e: Error) => void;
        const closed = new Promise((resolve, reject) => {
          close = resolve;
          fail = reject;
        });
        const cb: RuntimeCallbacks = {
          spawned: (pid) => assert.ok(pid > 0),
          message: (_kind, text) => messages.push(text),
          session: (id) => (session = id),
          request: (r) => {
            request = {
              ...r,
              id: "r",
              issueId: "issue",
              turnId: "turn",
              status: "pending",
              answer: null,
              createdAt: new Date().toISOString(),
            };
          },
          complete: (text) => {
            complete = true;
            output = text;
            if (name === "pi" && approvalLevel !== "automatic")
              assert.ok(
                Date.now() - approvedAt >= 80,
                "Pi must wait for agent_settled rather than agent_end",
              );
          },
          error: fail,
          closed: close,
        };
        const handle = factory(binding, "Test prompt", cb);
        for (let i = 0; i < 100 && !request && !complete; i++)
          await new Promise((r) => setTimeout(r, 10));
        if (approvalLevel !== "automatic") {
          assert.ok(request, "Runtime approval must arrive");
          assert.equal(complete, false);
          approvedAt = Date.now();
          handle.respond(
            request,
            approved ? "Approved" : "Revise this operation",
            approved,
          );
        } else
          assert.equal(request, undefined, "Automatic mode must not prompt");
        assert.ok(
          messages.some((m) => m.includes("\u2028")),
          "JSON strings must retain Unicode line separators",
        );
        await closed;
        assert.ok(complete);
        assert.ok(session);
        if (name === "pi") {
          assert.equal(
            output,
            approvalLevel === "automatic"
              ? "Automatic work finished."
              : approved
                ? "Approved work finished."
                : "Rejected; no tool executed.",
          );
          assert.ok(
            messages
              .filter((m) => m.startsWith("{"))
              .some((m) => JSON.parse(m).approvalLevel === approvalLevel),
          );
        } else {
          const configuration = messages
            .filter((m) => m.startsWith("{"))
            .map((m) => JSON.parse(m))
            .find((m) => m.configuration)?.configuration;
          assert.equal(
            configuration.sandbox,
            approvalLevel === "automatic"
              ? "danger-full-access"
              : approvalLevel === "strict"
                ? "read-only"
                : "workspace-write",
          );
          assert.equal(
            configuration.approvalPolicy,
            approvalLevel === "automatic" ? "never" : "on-request",
          );
          assert.equal(configuration.approvalsReviewer, "user");
          if (approvalLevel !== "strict")
            assert.equal(configuration.threadId, "existing-session");
          if (approvalLevel !== "automatic")
            assert.ok(
              messages.some((m) =>
                m.includes(approved ? '"completed"' : '"declined"'),
              ),
            );
        }
      } finally {
        if (previous === undefined) delete process.env[env];
        else process.env[env] = previous;
        rmSync(dir, { recursive: true });
      }
    });
  }
}

test("Codex multi-question answers are validated before replying to a native request", async () => {
  const { codexAnswers } = await import("../server/runtime/codex.js");
  assert.throws(
    () => codexAnswers([{ id: "target" }, { id: "mode" }], "plain answer"),
    /every question/,
  );
  assert.throws(
    () =>
      codexAnswers([{ id: "target" }, { id: "mode" }], '{"target":["server"]}'),
    /every question/,
  );
  assert.deepEqual(
    codexAnswers(
      [{ id: "target" }, { id: "mode" }],
      '{"target":["server"],"mode":["local"]}',
    ),
    { target: { answers: ["server"] }, mode: { answers: ["local"] } },
  );
});

for (const [level, scenario, approved] of [
  ["strict", "MCP approval", true],
  ["on-request", "MCP approval", false],
  ["automatic", "MCP approval", true],
  ["automatic", "MCP input", false],
] as const) {
  test(`Codex MCP: ${level}, ${scenario}, ${approved ? "accept" : "decline/input"}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "catcoon-mcp-"));
    const bin = join(dir, "codex");
    copyFileSync(resolve("tests/fixtures/codex.mjs"), bin);
    chmodSync(bin, 0o755);
    const previous = process.env.CODEX_BIN;
    process.env.CODEX_BIN = bin;
    let handle: ReturnType<typeof codex> | undefined;
    try {
      const binding: Binding = {
        id: "b",
        issueId: "i",
        name: "Codex",
        runtime: "codex",
        approvalLevel: level,
        role: "Build",
        cwd: process.cwd(),
        model: "",
        sessionId: null,
      };
      const messages: string[] = [];
      let requests = 0,
        completed = false;
      await new Promise<void>((resolve, reject) => {
        handle = codex(binding, scenario, {
          spawned() {},
          session() {},
          message: (_kind, text) => messages.push(text),
          request: (r) => {
            requests++;
            try {
              assert.equal(
                r.kind,
                scenario === "MCP input" ? "input" : "approval",
              );
              handle!.respond(
                {
                  ...r,
                  id: "r",
                  issueId: "i",
                  turnId: "t",
                  status: "pending",
                  answer: null,
                  createdAt: new Date().toISOString(),
                },
                scenario === "MCP input"
                  ? '{"target":"canvas"}'
                  : "Use another tool",
                approved,
              );
            } catch (e) {
              reject(e);
            }
          },
          complete: () => {
            completed = true;
          },
          error: reject,
          closed: resolve,
        });
      });
      assert.equal(completed, true);
      assert.equal(
        requests,
        level === "automatic" && scenario === "MCP approval" ? 0 : 1,
      );
      const response = messages
        .filter((m) => m.startsWith("{"))
        .map((m) => JSON.parse(m))
        .find((m) => m.type === "mcpToolCall")?.response;
      assert.deepEqual(
        response,
        scenario === "MCP input"
          ? { action: "accept", content: { target: "canvas" } }
          : approved
            ? { action: "accept", content: { confirmed: true } }
            : { action: "decline", content: null },
      );
    } finally {
      handle?.dispose();
      if (previous === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = previous;
      rmSync(dir, { recursive: true });
    }
  });
}
