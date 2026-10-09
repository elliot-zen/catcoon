#!/usr/bin/env node
import assert from "node:assert/strict";

if (process.argv.includes("--version")) {
  console.log("2.1.1");
  process.exit(0);
}
assert.deepEqual(process.argv.slice(2), ["acp"]);
let sessionId = "",
  mode = "",
  model = "",
  promptId,
  scenario = "";
const decisions = [];
const emit = (data) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...data }) + "\n");
const result = (id, data) => emit({ id, result: data });
const update = (data) =>
  emit({ method: "session/update", params: { sessionId, update: data } });
const text = (value) =>
  update({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: value },
  });
const finish = (answer, stopReason = "end_turn") => {
  if (answer) text(answer);
  // An answer is not a completion signal. Leave time for the client to
  // demonstrate that it waits for the session/prompt response.
  setTimeout(() => result(promptId, { stopReason }), 60);
};
const permission = (id, question = false, choices = false) =>
  emit({
    id,
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall: {
        toolCallId: id,
        title: question ? "AskUserQuestion" : "Bash",
        kind: "execute",
        rawInput: { command: "npm test" },
      },
      options: question
        ? [
            { optionId: "q0_opt_0", name: "Server", kind: "allow_once" },
            { optionId: "q0_opt_1", name: "Client", kind: "allow_once" },
            { optionId: "q0_skip", name: "Skip", kind: "reject_once" },
          ]
        : choices
          ? [
              { optionId: "plan_opt_0", name: "Plan A", kind: "allow_once" },
              { optionId: "plan_opt_1", name: "Plan B", kind: "allow_once" },
              { optionId: "plan_revise", name: "Revise", kind: "reject_once" },
            ]
          : [
              {
                optionId: "approve_once",
                name: "Approve once",
                kind: "allow_once",
              },
              {
                optionId: "approve_always",
                name: "Approve for session",
                kind: "allow_always",
              },
              { optionId: "reject", name: "Reject", kind: "reject_once" },
            ],
    },
  });
// JSONL splits on LF only. readline also splits Unicode line separators
// inside JSON strings, which would corrupt restored conversation history.
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    receive(line);
  }
});
function receive(line) {
  const m = JSON.parse(line);
  assert.equal(m.jsonrpc, "2.0");
  if (m.method === "initialize") {
    assert.equal(m.params.protocolVersion, 1);
    assert.deepEqual(m.params.clientCapabilities, {
      elicitation: { form: {} },
    });
    setTimeout(
      () =>
        result(m.id, {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: process.env.KIMI_FIXTURE_LOAD
              ? {}
              : { resume: {} },
          },
        }),
      30,
    );
  } else if (
    ["session/new", "session/resume", "session/load"].includes(m.method)
  ) {
    assert.equal(m.params.cwd, process.cwd());
    assert.deepEqual(m.params.mcpServers, []);
    sessionId = m.params.sessionId || "test-kimi-session";
    if (m.method === "session/load")
      text("Old answer from history; must not appear in this turn.");
    result(m.id, {
      ...(m.method === "session/new" ? { sessionId } : {}),
      modes: {
        currentModeId: "yolo",
        availableModes: process.env.KIMI_FIXTURE_BAD_MODE
          ? []
          : ["default", "auto", "yolo"].map((id) => ({ id })),
      },
    });
    update({
      sessionUpdate: "tool_call",
      toolCallId: "replayed-tool",
      title: "Old tool",
      status: "completed",
    });
  } else if (m.method === "session/set_mode") {
    assert.equal(m.params.sessionId, sessionId);
    mode = m.params.modeId;
    result(m.id, {});
  } else if (m.method === "session/set_config_option") {
    assert.equal(m.params.configId, "model");
    model = m.params.value;
    result(m.id, {});
  } else if (m.method === "session/prompt") {
    assert.equal(m.params.sessionId, sessionId);
    assert.ok(mode, "Must reset saved permission mode before the prompt");
    promptId = m.id;
    scenario =
      /KIMI_SCENARIO=(\w+)/.exec(m.params.prompt[0].text)?.[1] || "approval";
    update({
      sessionUpdate: "tool_call",
      toolCallId: "configuration",
      title: "Runtime configuration",
      status: "completed",
      rawInput: {
        mode,
        model,
        sessionId,
        processCwd: process.cwd(),
        prompt: m.params.prompt,
      },
    });
    if (scenario !== "empty") text("Plan ready\u2028Unicode preserved.\n");
    if (scenario === "error")
      emit({
        id: promptId,
        error: {
          code: -32000,
          message: "Authentication required: run kimi login",
        },
      });
    else if (scenario === "disconnect") process.exit(0);
    else if (scenario === "unknown")
      emit({
        id: "unknown",
        method: "fs/write_text_file",
        params: { sessionId },
      });
    else if (scenario === "refusal") finish("Blocked by provider.", "refusal");
    else if (scenario === "wait") {
      /* Wait for session/cancel. */
    } else if (scenario === "question") permission("question", true);
    else if (scenario === "choices") permission("choices", false, true);
    else if (scenario === "form" || scenario === "url")
      emit({
        id: scenario,
        method: "elicitation/create",
        params: {
          sessionId,
          mode: scenario,
          message: "Choose workspace and targets",
          ...(scenario === "url"
            ? { url: "https://example.com/verify" }
            : {
                requestedSchema: {
                  type: "object",
                  properties: {
                    q0: {
                      type: "string",
                      oneOf: [{ const: "Server" }, { const: "Client" }],
                    },
                    q1: {
                      type: "array",
                      minItems: 1,
                      items: { anyOf: [{ const: "API" }, { const: "UI" }] },
                    },
                  },
                  required: ["q0", "q1"],
                },
              }),
        },
      });
    else if (scenario === "finish" || scenario === "empty") {
      if (scenario === "empty") result(promptId, { stopReason: "end_turn" });
      else finish("Task completed.");
    } else {
      update({
        sessionUpdate: "tool_call",
        toolCallId: "operation",
        title: "Bash",
        status: "pending",
      });
      permission("approval-1");
      if (scenario === "parallel") permission("approval-2");
    }
  } else if (m.method === "session/cancel") {
    assert.equal(m.id, undefined, "ACP cancel is a notification");
    result(promptId, { stopReason: "cancelled" });
  } else if (!m.method && m.id) {
    decisions.push({ id: m.id, result: m.result, error: m.error });
    if (m.id === "unknown") process.exit(0);
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "operation",
      status: m.result?.outcome?.optionId === "reject" ? "failed" : "completed",
      rawOutput: decisions,
    });
    if (scenario === "parallel" && decisions.length < 2) return;
    finish(
      m.result?.outcome?.optionId === "reject"
        ? "Rejected; no tool executed."
        : "Approved work finished.",
    );
  }
}
