import { test } from "node:test";
import assert from "node:assert/strict";
import {
  codexMcpResponse,
  mcpElicitationKind,
} from "../server/runtime/codex-mcp.js";

test("MCP confirmation supports native empty schemas and boolean consent, preserving arbitrary forms", () => {
  for (const mode of ["form", "openai/form", "openaiForm"]) {
    const empty = { mode, requestedSchema: { type: "object", properties: {} } };
    assert.equal(mcpElicitationKind(empty), "approval");
    assert.deepEqual(codexMcpResponse(empty, "", true), {
      action: "accept",
      content: {},
    });
    assert.deepEqual(codexMcpResponse(empty, "", false), {
      action: "decline",
      content: null,
    });
    const consent = {
      mode,
      requestedSchema: {
        type: "object",
        properties: { confirmed: { type: "boolean" } },
        required: ["confirmed"],
      },
    };
    assert.deepEqual(codexMcpResponse(consent, "", true), {
      action: "accept",
      content: { confirmed: true },
    });
    const input = {
      mode,
      requestedSchema: {
        type: "object",
        properties: { subscribe: { type: "boolean" } },
        required: ["subscribe"],
      },
    };
    assert.equal(mcpElicitationKind(input), "input");
    assert.deepEqual(codexMcpResponse(input, '{"subscribe":false}', false), {
      action: "accept",
      content: { subscribe: false },
    });
  }
});

test("MCP URL verification needs explicit user confirmation; unsupported verification cannot be accepted", () => {
  const params = { mode: "url", url: "https://example.com/verify" };
  assert.equal(mcpElicitationKind(params), "approval");
  assert.deepEqual(codexMcpResponse(params, "", true), {
    action: "accept",
    content: null,
  });
  assert.deepEqual(codexMcpResponse(params, "", false), {
    action: "decline",
    content: null,
  });
  assert.equal(mcpElicitationKind({ mode: "openai/userVerification" }), null);
  assert.throws(
    () => codexMcpResponse({ mode: "openai/userVerification" }, "", true),
    /Unsupported MCP/,
  );
});
