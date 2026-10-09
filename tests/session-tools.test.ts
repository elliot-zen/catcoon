import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionTools } from "../src/session-tools.js";
import type { Message } from "../server/types.js";

function message(id: number, data: unknown): Message {
  return {
    id,
    turnId: "t",
    kind: "tool",
    text: typeof data === "string" ? data : JSON.stringify(data),
    createdAt: new Date().toISOString(),
  };
}

test("tool rows merge Codex and Pi lifecycle events while preserving distinct calls and names", () => {
  const rows = sessionTools([
    message(1, {
      id: "codex-call",
      type: "mcpToolCall",
      tool: "list_issues",
      server: "project",
      status: "inProgress",
    }),
    message(2, { id: "codex-call", type: "mcpToolCall", status: "completed" }),
    message(3, {
      toolCallId: "pi-call",
      type: "tool_execution_start",
      toolName: "read",
      args: { path: "README.md" },
    }),
    message(4, {
      toolCallId: "pi-call",
      type: "tool_execution_end",
      result: { text: "File contents" },
      isError: false,
    }),
    message(5, {
      id: "another-call",
      type: "commandExecution",
      command: "npm test",
      status: "inProgress",
    }),
  ]);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => [row.label, row.status]),
    [
      ["project · list_issues", "completed"],
      ["read", "completed"],
      ["npm test", "running"],
    ],
  );
  assert.match(rows[1].detail, /README.md/);
  assert.match(rows[1].detail, /File contents/);
});

test("failed and rejected tool calls remain visible with their status and raw details", () => {
  const rows = sessionTools([
    message(1, {
      id: "command",
      type: "commandExecution",
      command: "npm test",
      status: "completed",
      exitCode: 1,
    }),
    message(2, {
      toolCallId: "write",
      type: "tool_execution_end",
      toolName: "write",
      isError: true,
    }),
    message(3, {
      id: "approval",
      type: "commandExecution",
      status: "declined",
    }),
    message(4, "MCP verification is needed"),
  ]);
  assert.deepEqual(
    rows.map((row) => row.status),
    ["failed", "failed", "blocked", "completed"],
  );
  assert.equal(rows[3].label, "MCP verification is needed");
  assert.equal(rows[3].detail, "MCP verification is needed");
});
