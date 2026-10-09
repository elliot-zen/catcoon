import type { Binding, RuntimeCallbacks, RuntimeHandle } from "../types.js";
import { JsonProcess } from "./process.js";
import { codexApprovalSettings, defaultApprovalLevel } from "../approval.js";
import { codexMcpResponse, mcpElicitationKind } from "./codex-mcp.js";
export function codexAnswers(questions: { id: string }[], answer: string) {
  let values: Record<string, string[]>;
  try {
    values = JSON.parse(answer);
  } catch {
    if (questions.length !== 1)
      throw new Error("Answer every question before submitting.");
    values = { [questions[0].id]: [answer] };
  }
  if (
    !values ||
    typeof values !== "object" ||
    questions.some(
      (q) =>
        !Array.isArray(values[q.id]) ||
        !values[q.id].length ||
        values[q.id].some((v) => typeof v !== "string" || !v.trim()),
    )
  ) {
    throw new Error("A non-empty answer is required for every question.");
  }
  return Object.fromEntries(
    questions.map((q) => [q.id, { answers: values[q.id] }]),
  );
}
export function codex(
  binding: Binding,
  prompt: string,
  cb: RuntimeCallbacks,
): RuntimeHandle {
  const rpc = new JsonProcess(
    process.env.CODEX_BIN || "codex",
    ["app-server", "--stdio"],
    binding.cwd,
  );
  let threadId = "",
    turnId = "",
    finished = false,
    stopping = false,
    awaitingHuman = false;
  let output = "";
  const proposedItems = new Map<string, unknown>();
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
      cb.error(
        new Error("Codex disconnected before turn completion. " + rpc.stderr),
      );
    cb.closed();
  };
  rpc.onMessage = (m) => {
    if (m.method === "item/started") {
      proposedItems.set(m.params.item.id, m.params.item);
      if (
        ["commandExecution", "fileChange", "mcpToolCall"].includes(
          m.params.item.type,
        )
      )
        cb.message(
          "tool",
          JSON.stringify({ ...m.params.item, status: "inProgress" }, null, 2),
        );
    }
    if (m.method === "turn/started") turnId = m.params.turn.id;
    if (m.method === "item/agentMessage/delta") {
      output += m.params.delta;
      cb.message("assistant_delta", m.params.delta);
    } else if (m.method === "item/completed") {
      const item = m.params.item;
      if (["commandExecution", "fileChange", "mcpToolCall"].includes(item.type))
        cb.message("tool", JSON.stringify(item, null, 2));
    }
    if (m.id !== undefined && m.method) {
      const native = { id: m.id, method: m.method, params: m.params };
      if (
        [
          "item/commandExecution/requestApproval",
          "item/fileChange/requestApproval",
          "item/permissions/requestApproval",
        ].includes(m.method)
      ) {
        awaitingHuman = true;
        cb.request({
          kind: "approval",
          title: m.params.reason || "Approve proposed operation",
          detail: JSON.stringify(
            { ...m.params, proposedItem: proposedItems.get(m.params.itemId) },
            null,
            2,
          ),
          options: [],
          native,
        });
      } else if (m.method === "item/tool/requestUserInput") {
        awaitingHuman = true;
        cb.request({
          kind: "input",
          title: "Codex needs your decision",
          detail: JSON.stringify(m.params.questions, null, 2),
          options: [],
          native,
        });
      } else if (m.method === "mcpServer/elicitation/request") {
        const kind = mcpElicitationKind(m.params);
        if (!kind) {
          rpc.send({ id: m.id, result: { action: "cancel", content: null } });
          cb.message(
            "tool",
            `MCP request cancelled: unsupported elicitation mode ${m.params.mode}. Complete verification in the tool's own interface.`,
          );
        } else if (
          kind === "approval" &&
          m.params.mode !== "url" &&
          binding.approvalLevel === "automatic"
        ) {
          rpc.send({ id: m.id, result: codexMcpResponse(m.params, "", true) });
          cb.message(
            "tool",
            `MCP permission automatically approved for ${m.params.serverName}: ${m.params.message}`,
          );
        } else {
          awaitingHuman = true;
          cb.request({
            kind,
            title:
              m.params.mode === "url"
                ? "Complete MCP verification, then approve"
                : m.params.message || "MCP needs your decision",
            detail: JSON.stringify(m.params, null, 2),
            options: [],
            native,
          });
        }
      } else {
        rpc.send({
          id: m.id,
          error: {
            code: -32601,
            message: "Unsupported request; no automatic approval.",
          },
        });
        rpc.onError(new Error(`Unsupported Codex request: ${m.method}`));
      }
    }
    if (m.method === "turn/completed" && !finished) {
      finished = true;
      const t = m.params.turn;
      if (!stopping) {
        if (t.status === "completed") cb.complete(output);
        else cb.error(new Error(t.error?.message || `Codex turn ${t.status}`));
      }
      void rpc.terminate();
    }
  };
  const ready = (async () => {
    await rpc.request("initialize", {
      clientInfo: { name: "catcoon", title: "Catcoon", version: "0.1.0" },
      capabilities: {
        experimentalApi: true,
        mcpServerOpenaiFormElicitation: true,
      },
    });
    rpc.send({ method: "initialized", params: {} });
    if (stopping) return;
    const params = {
      cwd: binding.cwd,
      ...codexApprovalSettings(
        binding.approvalLevel ?? defaultApprovalLevel("codex"),
      ),
      ...(binding.model ? { model: binding.model } : {}),
    };
    const r = await rpc.request(
      binding.sessionId ? "thread/resume" : "thread/start",
      {
        ...params,
        ...(binding.sessionId ? { threadId: binding.sessionId } : {}),
      },
    );
    threadId = r.thread.id;
    cb.session(threadId);
    if (stopping) return;
    const result = await rpc.request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
    });
    turnId = result.turn.id;
  })();
  void ready.catch((e) => rpc.onError(e));
  return {
    send: async (message) => {
      await ready;
      if (finished || stopping || awaitingHuman)
        throw new Error(
          "The turn ended or is waiting for a human decision. Review the issue before sending again.",
        );
      await rpc.request("turn/steer", {
        threadId,
        expectedTurnId: turnId,
        input: [{ type: "text", text: message, text_elements: [] }],
      });
    },
    stop: async () => {
      stopping = true;
      try {
        if (threadId && turnId)
          await rpc.request("turn/interrupt", { threadId, turnId });
      } finally {
        await rpc.terminate();
      }
    },
    respond: (r, answer, approved) => {
      awaitingHuman = false;
      const n = r.native!;
      let result: any;
      if (n.method === "item/permissions/requestApproval")
        result = {
          permissions: approved ? n.params.permissions : {},
          scope: "turn",
        };
      else if (n.method === "item/tool/requestUserInput") {
        result = {
          answers: codexAnswers(n.params.questions || [], answer),
        };
      } else if (n.method === "mcpServer/elicitation/request")
        result = codexMcpResponse(n.params, answer, approved);
      else result = { decision: approved ? "accept" : "decline" };
      rpc.send({ id: n.id, result });
    },
    dispose: () => {
      stopping = true;
      void rpc.terminate();
    },
  };
}
