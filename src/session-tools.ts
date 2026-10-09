import type { Message } from "../server/types";

export interface SessionTool {
  id: string;
  label: string;
  status: "running" | "completed" | "failed" | "blocked";
  detail: string;
}

// Codex emits items, Pi emits tool start/end, and Kimi emits ACP tool updates.
// Keep one row per native call, retaining the name from its start event.
export function sessionTools(messages: Message[]): SessionTool[] {
  const calls = new Map<
    string,
    { data: Record<string, any>; row: SessionTool }
  >();
  for (const message of messages) {
    if (message.kind !== "tool") continue;
    let data: Record<string, any>;
    try {
      const parsed = JSON.parse(message.text);
      data =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed
          : {};
    } catch {
      data = {};
    }
    const id = String(data.toolCallId || data.id || `message-${message.id}`);
    const previous = calls.get(id);
    const merged = { ...previous?.data, ...data };
    const state = String(merged.status || "").toLowerCase();
    const status: SessionTool["status"] =
      data.isError ||
      (typeof data.exitCode === "number" && data.exitCode !== 0) ||
      ["failed", "error"].includes(state)
        ? "failed"
        : ["declined", "rejected", "cancelled", "canceled"].includes(state)
          ? "blocked"
          : data.type === "tool_execution_start" ||
              ["pending", "running", "inprogress", "in_progress"].includes(
                state,
              )
            ? "running"
            : "completed";
    const label =
      merged.toolName ||
      merged.command ||
      (merged.tool
        ? `${merged.server ? `${merged.server} · ` : ""}${merged.tool}`
        : null) ||
      (
        {
          commandExecution: "Command",
          fileChange: "File changes",
          mcpToolCall: "MCP tool",
        } as Record<string, string>
      )[merged.type] ||
      message.text;
    calls.set(id, {
      data: merged,
      row: {
        id,
        label: String(label),
        status,
        detail: Object.keys(merged).length
          ? JSON.stringify(merged, null, 2)
          : message.text,
      },
    });
  }
  return [...calls.values()].map((call) => call.row);
}
