#!/usr/bin/env node
let buffer = "";
const emit = (m) => process.stdout.write(JSON.stringify(m) + "\n");
process.stdin.on("data", (c) => {
  buffer += c;
  let n;
  while ((n = buffer.indexOf("\n")) >= 0) {
    const m = JSON.parse(buffer.slice(0, n));
    buffer = buffer.slice(n + 1);
    if (m.type === "prompt") {
      emit({ id: m.id, type: "response", success: true });
      emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: "Plan ready\u2028Unicode preserved.",
        },
      });
      emit({
        type: "tool_execution_start",
        approvalLevel: process.env.CATCOON_APPROVAL_LEVEL,
      });
      if (process.env.CATCOON_APPROVAL_LEVEL === "automatic") {
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "Automatic work finished." }],
          },
        });
        emit({ type: "agent_settled" });
      } else
        emit({
          type: "extension_ui_request",
          id: "approve",
          method: "confirm",
          title: "Approve write",
          message: "Exact tool input",
        });
    } else if (m.type === "extension_ui_response") {
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [
            {
              type: "text",
              text: m.confirmed
                ? "Approved work finished."
                : "Rejected; no tool executed.",
            },
          ],
        },
      });
      emit({ type: "agent_end", willRetry: false });
      setTimeout(() => emit({ type: "agent_settled" }), 100);
    } else if (m.type === "clear_queue" || m.type === "abort") {
      emit({ id: m.id, type: "response", success: true });
      if (m.type === "abort") emit({ type: "agent_settled" });
    }
  }
});
