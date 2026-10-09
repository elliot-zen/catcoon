import { z } from "zod";
import { defaultApprovalLevel } from "../approval.js";
import type {
  ApprovalLevel,
  Binding,
  RuntimeCallbacks,
  RuntimeHandle,
} from "../types.js";
import { JsonProcess } from "./process.js";

// ACP mode IDs differ from the similarly named CLI switches in Kimi 2.x.
export const kimiModes: Record<ApprovalLevel, string> = {
  strict: "default",
  "on-request": "auto",
  automatic: "yolo",
};

type Native = Record<string, any>;
function permissionIsInput(params: Native) {
  return (
    params.toolCall?.title === "AskUserQuestion" ||
    params.options?.some((o: Native) => /^q\d+_/.test(o.optionId)) ||
    params.options?.filter((o: Native) => o.kind === "allow_once").length > 1
  );
}

// Validate before the orchestrator persists a decision or resumes the turn.
export function kimiResponse(
  native: Native,
  answer: string,
  approved: boolean,
) {
  const params = native.params;
  if (native.method === "elicitation/create") {
    if (params.mode === "url")
      return { action: approved ? "accept" : "decline" };
    if (params.mode !== "form")
      throw new Error("Unsupported Kimi elicitation mode.");
    let content: unknown;
    try {
      content = JSON.parse(answer);
    } catch {
      throw new Error("Enter the Kimi form answer as a JSON object.");
    }
    const parsed = z.fromJSONSchema(params.requestedSchema).safeParse(content);
    if (!parsed.success)
      throw new Error(
        `Invalid Kimi form answer: ${parsed.error.issues.map((i) => `${i.path.join(".") || "answer"}: ${i.message}`).join("; ")}`,
      );
    return { action: "accept", content };
  }
  if (native.method !== "session/request_permission")
    throw new Error(`Unsupported Kimi request: ${native.method}`);
  const option = permissionIsInput(params)
    ? params.options.find((o: Native) => o.name === answer)
    : params.options.find(
        (o: Native) => o.kind === (approved ? "allow_once" : "reject_once"),
      );
  if (!option) {
    if (!approved && !permissionIsInput(params))
      return { outcome: { outcome: "cancelled" } };
    throw new Error("Choose one of the Kimi request's listed options.");
  }
  return { outcome: { outcome: "selected", optionId: option.optionId } };
}

export function kimi(
  binding: Binding,
  prompt: string,
  cb: RuntimeCallbacks,
): RuntimeHandle {
  const rpc = new JsonProcess(
    process.env.KIMI_BIN || "kimi",
    ["acp"],
    binding.cwd,
    process.env,
    true,
  );
  const level = binding.approvalLevel ?? defaultApprovalLevel("kimi");
  let sessionId = binding.sessionId || "",
    finished = false,
    stopping = false,
    running = false,
    output = "",
    pending: Native | undefined;
  // Kimi may request permissions for several parallel tool calls. Present one
  // at a time, matching the application's single pending-human-request rule.
  const requests: Native[] = [];
  const reply = (id: unknown, result: unknown) => rpc.send({ id, result });
  const present = () => {
    if (pending || stopping || finished) return;
    pending = requests.shift();
    if (!pending) return;
    const { method, params } = pending;
    const input =
      method === "elicitation/create"
        ? params.mode === "form"
        : permissionIsInput(params);
    cb.request({
      kind: input ? "input" : "approval",
      title:
        method === "elicitation/create"
          ? params.mode === "url"
            ? "Complete Kimi verification, then approve"
            : params.message || "Kimi needs your decision"
          : params.toolCall?.title || "Approve Kimi operation",
      detail: JSON.stringify(params, null, 2),
      options:
        method === "session/request_permission" && input
          ? params.options.map((o: Native) => o.name)
          : [],
      native: pending,
    });
  };
  if (rpc.child.pid) cb.spawned(rpc.child.pid);
  rpc.onError = (error) => {
    if (finished || stopping) return;
    finished = true;
    cb.error(error);
    void rpc.terminate();
  };
  rpc.onClose = () => {
    if (!finished && !stopping) {
      finished = true;
      cb.error(
        new Error("Kimi disconnected before turn completion. " + rpc.stderr),
      );
    }
    cb.closed();
  };
  rpc.onMessage = (message) => {
    if (finished) return;
    if (message.method === "session/update") {
      // session/load replays history before responding. Catcoon already keeps
      // that history in SQLite; only persist updates from this new turn.
      if (!running || message.params?.sessionId !== sessionId || stopping)
        return;
      const update = message.params.update;
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content?.type === "text"
      ) {
        output += update.content.text;
        cb.message("assistant_delta", update.content.text);
      } else if (
        ["tool_call", "tool_call_update"].includes(update.sessionUpdate)
      ) {
        cb.message(
          "tool",
          JSON.stringify(
            {
              ...update,
              ...(update.title ? { toolName: update.title } : {}),
              ...(update.sessionUpdate === "tool_call" && !update.status
                ? { status: "in_progress" }
                : {}),
            },
            null,
            2,
          ),
        );
      }
      return;
    }
    if (message.id === undefined || !message.method) return;
    if (stopping) {
      if (message.method === "session/request_permission")
        reply(message.id, { outcome: { outcome: "cancelled" } });
      else reply(message.id, { action: "cancel" });
      return;
    }
    if (
      !["session/request_permission", "elicitation/create"].includes(
        message.method,
      )
    ) {
      rpc.send({
        id: message.id,
        error: {
          code: -32601,
          message: `Unsupported Kimi request: ${message.method}`,
        },
      });
      rpc.onError(new Error(`Unsupported Kimi request: ${message.method}`));
      return;
    }
    if (message.params?.sessionId !== sessionId) {
      rpc.onError(new Error("Kimi request refers to an unexpected session."));
      return;
    }
    const native = {
      runtime: "kimi",
      id: message.id,
      method: message.method,
      params: message.params,
    };
    if (
      message.method === "elicitation/create" &&
      !["form", "url"].includes(message.params.mode)
    ) {
      reply(message.id, { action: "cancel" });
      cb.message(
        "tool",
        "Kimi request cancelled: unsupported elicitation mode.",
      );
    } else if (
      level === "automatic" &&
      message.method === "session/request_permission" &&
      !permissionIsInput(message.params)
    ) {
      reply(message.id, kimiResponse(native, "", true));
      cb.message(
        "tool",
        `Kimi permission automatically approved: ${message.params.toolCall?.title || "operation"}`,
      );
    } else {
      requests.push(native);
      present();
    }
  };
  const ready = (async () => {
    const init = await rpc.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "catcoon", version: "0.1.0" },
      clientCapabilities: { elicitation: { form: {} } },
    });
    if (init.protocolVersion !== 1)
      throw new Error("Unsupported Kimi ACP protocol version.");
    if (stopping || finished) return;
    const method = !sessionId
      ? "session/new"
      : init.agentCapabilities?.sessionCapabilities?.resume
        ? "session/resume"
        : "session/load";
    if (method === "session/load" && !init.agentCapabilities?.loadSession)
      throw new Error("This Kimi runtime cannot restore the saved session.");
    const session = await rpc.request(method, {
      cwd: binding.cwd,
      mcpServers: [],
      ...(sessionId ? { sessionId } : {}),
    });
    sessionId = session.sessionId || sessionId;
    if (!sessionId) throw new Error("Kimi did not return a session ID.");
    cb.session(sessionId);
    if (stopping || finished) return;
    if (
      !session.modes?.availableModes?.some(
        (m: Native) => m.id === kimiModes[level],
      )
    )
      throw new Error(
        `Kimi does not support the configured approval mode: ${kimiModes[level]}. Use Kimi Code 2.x.`,
      );
    // Reset persisted permission/plan modes on every turn, including resumes.
    await rpc.request("session/set_mode", {
      sessionId,
      modeId: kimiModes[level],
    });
    if (binding.model)
      await rpc.request("session/set_config_option", {
        sessionId,
        configId: "model",
        value: binding.model,
      });
    if (stopping || finished) return;
    running = true;
    void rpc
      .request(
        "session/prompt",
        { sessionId, prompt: [{ type: "text", text: prompt }] },
        false,
        null,
      )
      .then((result) => {
        if (finished || stopping) return;
        if (pending || requests.length)
          throw new Error(
            "Kimi ended the turn with unresolved human requests.",
          );
        if (result.stopReason !== "end_turn")
          throw new Error(`Kimi turn ended: ${result.stopReason}`);
        if (!output.trim())
          throw new Error(
            "Kimi ended the turn without an answer. Check the Kimi CLI logs for provider errors.",
          );
        finished = true;
        cb.complete(output);
        void rpc.terminate();
      })
      .catch((error) => rpc.onError(error));
  })();
  void ready.catch((error) => rpc.onError(error));
  return {
    send: async () => {
      await ready;
      if (finished || stopping || pending || requests.length)
        throw new Error(
          "The turn ended or is waiting for a human decision. Review the issue before sending again.",
        );
      // ACP has no steer method; a second prompt is rejected by Kimi. Do not
      // create a parallel turn or pretend that a follow-up was delivered.
      throw new Error(
        "Kimi Code ACP does not support messages during an active turn. Stop the turn or wait for it to finish, then send your message.",
      );
    },
    stop: async () => {
      stopping = true;
      try {
        if (sessionId && !rpc.exited && !rpc.child.stdin.destroyed)
          rpc.send({ method: "session/cancel", params: { sessionId } });
      } finally {
        await rpc.terminate();
      }
    },
    respond: (request, answer, approved) => {
      if (finished || stopping || !pending || request.native?.id !== pending.id)
        throw new Error("This Kimi request is no longer pending.");
      const result = kimiResponse(pending, answer, approved);
      reply(pending.id, result);
      pending = undefined;
      queueMicrotask(present);
    },
    dispose: () => {
      stopping = true;
      void rpc.terminate();
    },
  };
}
