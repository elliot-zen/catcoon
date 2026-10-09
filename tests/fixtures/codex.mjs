#!/usr/bin/env node
let buffer = "",
  policy = "",
  sandbox = "",
  scenario = "";
const emit = (m) => process.stdout.write(JSON.stringify(m) + "\n");
process.stdin.on("data", (c) => {
  buffer += c;
  let n;
  while ((n = buffer.indexOf("\n")) >= 0) {
    const m = JSON.parse(buffer.slice(0, n));
    buffer = buffer.slice(n + 1);
    if (m.method === "initialize") {
      if (!m.params.capabilities.mcpServerOpenaiFormElicitation)
        process.exit(2);
      emit({ id: m.id, result: {} });
    } else if (m.method === "thread/start" || m.method === "thread/resume") {
      if (
        m.params.approvalsReviewer !== "user" ||
        !["workspace-write", "read-only", "danger-full-access"].includes(
          m.params.sandbox,
        )
      )
        process.exit(2);
      policy = m.params.approvalPolicy;
      sandbox = m.params.sandbox;
      emit({
        method: "item/completed",
        params: { item: { type: "commandExecution", configuration: m.params } },
      });
      emit({ id: m.id, result: { thread: { id: "test-thread" } } });
    } else if (m.method === "turn/start") {
      emit({ id: m.id, result: { turn: { id: "test-turn" } } });
      emit({
        method: "item/agentMessage/delta",
        params: { delta: "Plan ready\u2028Unicode preserved." },
      });
      scenario = m.params.input[0].text;
      if (scenario === "Chat prompt") {
        // Keep the native turn open until the test sends a follow-up.
      } else if (scenario.startsWith("MCP")) {
        const input = scenario === "MCP input";
        emit({
          id: "mcp",
          method: "mcpServer/elicitation/request",
          params: {
            serverName: "test-figma",
            threadId: "test-thread",
            turnId: "test-turn",
            mode: input ? "openai/form" : "form",
            message: "Allow this tool?",
            requestedSchema: {
              type: "object",
              properties: input
                ? { target: { type: "string", minLength: 1 } }
                : { confirmed: { type: "boolean" } },
              required: [input ? "target" : "confirmed"],
            },
          },
        });
      } else if (policy === "never") {
        emit({
          method: "turn/completed",
          params: {
            turn:
              sandbox === "danger-full-access"
                ? { status: "completed" }
                : {
                    status: "failed",
                    error: {
                      message:
                        "MCP tool call requires approval, but approval policy is never",
                    },
                  },
          },
        });
      } else
        emit({
          id: "approve",
          method: "item/commandExecution/requestApproval",
          params: {
            turnId: "test-turn",
            threadId: "test-thread",
            reason: "Run verification",
            command: "npm test",
          },
        });
    } else if (m.method === "turn/steer") {
      if (
        m.params.threadId !== "test-thread" ||
        m.params.expectedTurnId !== "test-turn"
      )
        process.exit(2);
      if (m.params.input[0].text === "Reject steer") {
        emit({ id: m.id, error: { code: -32000, message: "Steer rejected" } });
      } else {
        emit({ id: m.id, result: { turnId: "test-turn" } });
        emit({
          method: "item/agentMessage/delta",
          params: { delta: `Received: ${m.params.input[0].text}` },
        });
        emit({
          method: "turn/completed",
          params: { turn: { status: "completed" } },
        });
      }
    } else if (m.id === "mcp" && m.result) {
      if (
        m.result.action === "accept" &&
        scenario === "MCP input" &&
        m.result.content.target !== "canvas"
      )
        process.exit(2);
      if (
        m.result.action === "accept" &&
        scenario !== "MCP input" &&
        m.result.content.confirmed !== true
      )
        process.exit(2);
      emit({
        method: "item/completed",
        params: { item: { type: "mcpToolCall", response: m.result } },
      });
      emit({
        method: "turn/completed",
        params: { turn: { status: "completed" } },
      });
    } else if (m.id === "approve" && m.result) {
      emit({
        method: "item/completed",
        params: {
          item: {
            type: "commandExecution",
            command: "npm test",
            status: m.result.decision === "accept" ? "completed" : "declined",
          },
        },
      });
      emit({
        method: "turn/completed",
        params: { turn: { status: "completed" } },
      });
    } else if (m.method === "turn/interrupt") {
      emit({ id: m.id, result: {} });
      emit({
        method: "turn/completed",
        params: { turn: { status: "interrupted" } },
      });
    }
  }
});
