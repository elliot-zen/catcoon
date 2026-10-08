import { resolve } from "node:path";
import type { Binding, RuntimeCallbacks, RuntimeHandle } from "../types.js";
import { JsonProcess } from "./process.js";
export function pi(
  binding: Binding,
  prompt: string,
  cb: RuntimeCallbacks,
): RuntimeHandle {
  const session =
    binding.sessionId ||
    resolve(process.env.DATA_DIR || ".data", "sessions", `${binding.id}.jsonl`);
  const args = [
    "--mode",
    "rpc",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--session",
    session,
    "--extension",
    resolve("server/runtime/pi-approval.ts"),
  ];
  if (binding.model) args.push("--model", binding.model);
  const rpc = new JsonProcess(process.env.PI_BIN || "pi", args, binding.cwd);
  let finished = false,
    stopping = false,
    output = "",
    lastError = "";
  cb.session(session);
  if (rpc.child.pid) cb.spawned(rpc.child.pid);
  rpc.onError = (e) => {
    if (!finished && !stopping) {
      finished = true;
      cb.error(e);
      void rpc.terminate();
    }
  };
  rpc.onClose = () => {
    if (!finished && !stopping)
      cb.error(new Error("Pi disconnected before settling. " + rpc.stderr));
    cb.closed();
  };
  rpc.onMessage = (m) => {
    if (
      m.type === "message_update" &&
      m.assistantMessageEvent?.type === "text_delta"
    ) {
      const text = m.assistantMessageEvent.delta;
      cb.message("assistant_delta", text);
    }
    if (m.type === "message_end" && m.message?.role === "assistant") {
      if (
        m.message.stopReason === "error" ||
        m.message.stopReason === "aborted"
      )
        lastError = m.message.errorMessage || m.message.stopReason;
      else lastError = "";
      output = (m.message.content || [])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      cb.message("assistant", output);
    }
    if (m.type === "tool_execution_end" || m.type === "tool_execution_start")
      cb.message("tool", JSON.stringify(m, null, 2));
    if (
      m.type === "extension_ui_request" &&
      ["confirm", "select", "input", "editor"].includes(m.method)
    ) {
      if (m.timeout) {
        rpc.onError(
          new Error(
            "Timed runtime dialogs cannot guarantee a stable approval window.",
          ),
        );
        return;
      }
      cb.request({
        kind: m.method === "confirm" ? "approval" : "input",
        title: m.title || "Pi needs your decision",
        detail: m.message || m.prefill || m.placeholder || "",
        options: m.options || [],
        native: m,
      });
    }
    if (m.type === "agent_settled" && !finished) {
      finished = true;
      if (!stopping) {
        if (lastError) cb.error(new Error(lastError));
        else cb.complete(output);
      }
      void rpc.terminate();
    }
  };
  void rpc
    .request("prompt", { message: prompt }, true)
    .catch((e) => rpc.onError(e));
  return {
    stop: async () => {
      stopping = true;
      try {
        await rpc.request("clear_queue", {}, true);
        await rpc.request("abort", {}, true);
      } finally {
        await rpc.terminate();
      }
    },
    respond: (r, answer, approved) => {
      const n = r.native!;
      rpc.send({
        type: "extension_ui_response",
        id: n.id,
        ...(n.method === "confirm"
          ? { confirmed: approved }
          : { value: answer }),
      });
    },
    dispose: () => {
      stopping = true;
      void rpc.terminate();
    },
  };
}
