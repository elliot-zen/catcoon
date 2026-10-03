import { realpathSync, existsSync } from "node:fs";
import { resolve, relative, dirname, isAbsolute } from "node:path";
import { relayTools } from "./tools.ts";
export default function relay(pi: any) {
  const write = process.env.RELAY_WRITE_APPROVED === "1";
  const root = realpathSync(process.env.RELAY_WORKTREE!);
  const allowed = new Set([
    "read",
    "relay_spec_read",
    "relay_report",
    ...(write ? ["bash", "write", "edit", "grep", "find", "ls"] : []),
  ]);
  for (const tool of relayTools)
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      async execute(callId: string, args: any) {
        const response = await fetch(
          process.env.RELAY_API_URL +
            "/api/runs/" +
            process.env.RELAY_RUN_ID +
            "/tool",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + process.env.RELAY_RUN_TOKEN,
              "Idempotency-Key": crypto.randomUUID(),
            },
            body: JSON.stringify({ tool: tool.name, args, callId }),
          },
        );
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error?.message || "Relay tool failed");
        return {
          content: [{ type: "text", text: JSON.stringify(data) }],
          details: data,
        };
      },
    });
  pi.on("session_start", () => pi.setActiveTools([...allowed]));
  pi.on("tool_call", (e: any) => {
    if (!allowed.has(e.toolName))
      return {
        block: true,
        reason: "Tool is outside this turn's approved scope",
      };
    if (
      ["read", "write", "edit", "ls", "find", "grep"].includes(e.toolName) &&
      e.input?.path
    ) {
      let path = resolve(root, e.input.path);
      while (!existsSync(path)) path = dirname(path);
      const rel = relative(root, realpathSync(path));
      if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
        return { block: true, reason: "Path is outside the assigned Worktree" };
    }
  });
}
