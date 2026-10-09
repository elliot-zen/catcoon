import {
  accessSync,
  constants,
  statSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { Store, uid, now } from "./store.js";
import { Jev, routeState } from "./jev.js";
import { codex, codexAnswers } from "./runtime/codex.js";
import { codexMcpResponse } from "./runtime/codex-mcp.js";
import { pi } from "./runtime/pi.js";
import {
  approvalDescriptions,
  approvalLabels,
  defaultApprovalLevel,
} from "./approval.js";
import type {
  Binding,
  Decision,
  Detail,
  HumanRequest,
  RuntimeCallbacks,
  RuntimeHandle,
  Status,
} from "./types.js";
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public field?: string,
  ) {
    super(message);
  }
}
export interface Router {
  route: (detail: Detail, signal: AbortSignal) => Promise<Decision>;
}
export type Factory = (
  binding: Binding,
  prompt: string,
  cb: RuntimeCallbacks,
) => RuntimeHandle;
function birth(pid: number) {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8")
      .split(") ")[1]
      .split(" ")[19];
  } catch {
    return "";
  }
}
const editable: Status[] = ["waiting_binding", "ready", "stopped"];
export class Orchestrator extends EventEmitter {
  active = new Map<
    string,
    {
      handle: RuntimeHandle;
      generation: number;
      issueId: string;
      outcome?: "completed" | "failed";
    }
  >();
  routing = new Map<string, AbortController>();
  closing = false;
  constructor(
    public store: Store,
    private router: Router = new Jev(),
    private factory: Factory = (b, p, c) =>
      b.runtime === "codex" ? codex(b, p, c) : pi(b, p, c),
  ) {
    super();
    mkdirSync(resolve(process.env.DATA_DIR || ".data", "sessions"), {
      recursive: true,
    });
  }
  changed() {
    this.emit("change");
  }
  require(id: string) {
    const d = this.store.detail(id);
    if (!d) throw new HttpError(404, "Issue not found.");
    return d;
  }
  assertEdit(id: string) {
    const d = this.require(id);
    if (!editable.includes(d.status))
      throw new HttpError(409, "Stop the issue before editing.");
    if (this.store.pending(id) && this.store.pending(id)?.native)
      throw new HttpError(
        409,
        "Resolve the pending runtime request before changing bindings.",
      );
    return d;
  }
  createIssue(title: string, description: string) {
    const id = `AGT-${String(this.store.list().length + 1).padStart(3, "0")}`;
    this.store.transaction(() => {
      this.store.insert("issues", {
        id,
        title,
        description,
        status: "waiting_binding",
        generation: 0,
        currentTurnId: null,
        stopReason: null,
        createdAt: now(),
        updatedAt: now(),
        completedAt: null,
      });
      this.store.activity(id, "Human", "created", "Created issue");
    });
    this.changed();
    return this.require(id);
  }
  edit(id: string, title: string, description: string) {
    this.require(id);
    this.store.transaction(() => {
      this.store.update("issues", id, { title, description });
      this.store.activity(id, "Human", "edited", "Updated issue");
    });
    this.changed();
  }
  bind(
    id: string,
    data: Pick<Binding, "name" | "runtime" | "role" | "cwd" | "model"> &
      Partial<Pick<Binding, "approvalLevel">>,
    bindingId?: string,
  ) {
    const d = this.require(id);
    if (!editable.includes(d.status))
      throw new HttpError(409, "Stop the issue before editing.");
    const previous = d.bindings.find((b) => b.id === bindingId);
    if (bindingId && !previous) throw new HttpError(404, "Binding not found.");
    const path = data.cwd.trim();
    if (!path)
      throw new HttpError(400, "Working directory is required.", "cwd");
    if (!isAbsolute(path) || path.includes("\0"))
      throw new HttpError(
        400,
        "Enter an absolute path on the agent’s machine.",
        "cwd",
      );
    const cwd = resolve(path);
    const directoryLocked =
      !!previous &&
      (!!previous.sessionId ||
        d.turns.some((t) => t.bindingId === previous.id));
    if (directoryLocked && cwd !== previous.cwd)
      throw new HttpError(
        409,
        "This session uses the saved directory. Bind a new agent to choose another directory.",
        "cwd",
      );
    // A locked directory belongs to the existing session. Role and approval edits
    // can still be saved if that directory has since become unavailable.
    if (!directoryLocked) {
      try {
        if (!statSync(cwd).isDirectory())
          throw new HttpError(
            400,
            "This path is a file. Enter a directory.",
            "cwd",
          );
        accessSync(cwd, constants.R_OK | constants.X_OK);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        throw new HttpError(
          400,
          code === "ENOENT" || code === "ENOTDIR"
            ? "Directory not found. Enter an existing directory."
            : "The agent cannot access this directory.",
          "cwd",
        );
      }
    }
    if (this.store.pending(id)?.native) {
      const approvalOnly =
        d.status === "stopped" &&
        previous &&
        previous.name === data.name &&
        previous.runtime === data.runtime &&
        previous.role === data.role &&
        previous.cwd === cwd &&
        previous.model === data.model;
      if (!approvalOnly)
        throw new HttpError(
          409,
          "Only the approval level can change while a runtime request is pending. Resolve it before changing other binding settings.",
        );
    }
    const approvalLevel =
      data.approvalLevel ??
      (previous?.runtime === data.runtime
        ? previous.approvalLevel
        : defaultApprovalLevel(data.runtime));
    this.store.transaction(() => {
      if (bindingId) {
        const b = d.bindings.find((b) => b.id === bindingId);
        if (!b) throw new HttpError(404, "Binding not found.");
        this.store.update("bindings", bindingId, {
          ...data,
          approvalLevel,
          cwd,
          sessionId:
            b.runtime === data.runtime && b.cwd === cwd ? b.sessionId : null,
        });
      } else
        this.store.insert("bindings", {
          id: uid(),
          issueId: id,
          ...data,
          approvalLevel,
          cwd,
          sessionId: null,
        });
      if (d.status === "waiting_binding") this.store.status(id, "ready");
      this.store.activity(
        id,
        "Human",
        "binding",
        `${bindingId ? "Updated" : "Bound"} ${data.name}`,
        `${data.role}\nWorking directory: ${cwd}\nApproval level: ${approvalLevel}`,
      );
    });
    this.changed();
  }
  unbind(id: string, bindingId: string) {
    const d = this.assertEdit(id);
    const b = d.bindings.find((b) => b.id === bindingId);
    if (!b) throw new HttpError(404, "Binding not found.");
    if (d.turns.some((t) => t.bindingId === bindingId))
      throw new HttpError(
        409,
        "Bindings with execution history cannot be removed; edit the role instead.",
      );
    this.store.transaction(() => {
      this.store.db.prepare("DELETE FROM bindings WHERE id=?").run(bindingId);
      if (d.status === "ready" && d.bindings.length === 1)
        this.store.status(id, "waiting_binding");
      this.store.activity(id, "Human", "unbound", `Removed ${b.name}`);
    });
    this.changed();
  }
  start(id: string) {
    const d = this.require(id);
    if (!["ready", "stopped"].includes(d.status)) return d;
    if (!d.bindings.length)
      throw new HttpError(409, "Bind an agent before starting.");
    if (d.turns.some((t) => t.status === "running"))
      throw new HttpError(409, "Previous execution has not ended.");
    const request = this.store.pending(id);
    this.store.transaction(() => {
      this.store.status(id, request ? "waiting_human" : "routing", {
        generation: d.generation + 1,
        stopReason: null,
      });
      this.store.activity(
        id,
        "Human",
        "start",
        d.status === "ready" ? "Started workflow" : "Resumed workflow",
      );
    });
    const active = d.currentTurnId
      ? this.active.get(d.currentTurnId)
      : undefined;
    if (active) active.generation = d.generation + 1;
    this.changed();
    if (!request) void this.route(id);
    return this.require(id);
  }
  stop(id: string) {
    const d = this.require(id);
    this.routing.get(id)?.abort();
    if (d.status === "running") {
      const a = d.currentTurnId ? this.active.get(d.currentTurnId) : undefined;
      this.store.status(id, "stopping");
      this.store.activity(id, "Human", "stop", "Stopping workflow");
      this.changed();
      if (a)
        void a.handle.stop().catch((e) => {
          this.store.activity(
            id,
            "System",
            "error",
            "Interrupt failed; waiting for process exit",
            e.message,
          );
          this.changed();
        });
    } else if (["routing", "waiting_human"].includes(d.status)) {
      this.store.status(id, "stopped", { stopReason: "Stopped by Human" });
      this.store.activity(id, "Human", "stop", "Stopped automatic progress");
      this.changed();
    }
    return this.require(id);
  }
  valid(id: string, generation: number, status: Status) {
    const issue = this.store.issue(id);
    return (
      !this.closing &&
      issue?.generation === generation &&
      issue.status === status
    );
  }
  async route(id: string) {
    const d = this.require(id);
    if (d.status !== "routing" || this.closing) return;
    const controller = new AbortController();
    const previous = this.routing.get(id);
    previous?.abort();
    this.routing.set(id, controller);
    try {
      const decision = await this.router.route(d, controller.signal);
      if (controller.signal.aborted || !this.valid(id, d.generation, "routing"))
        return;
      this.store.activity(
        id,
        "Jev",
        "decision",
        decision.action === "agent"
          ? "Selected the next Agent"
          : decision.action === "done"
            ? "Completed the Issue"
            : "Waiting for human decision",
        JSON.stringify({ input: routeState(d), output: decision }, null, 2),
      );
      if (decision.action === "done") {
        if (
          !d.turns.some((t) => t.status === "completed") ||
          this.store.pending(id)
        )
          throw new Error(
            "Completion requires finished work and no pending human request.",
          );
        this.store.status(id, "done", {
          completedAt: now(),
          currentTurnId: null,
        });
      } else if (decision.action === "human")
        this.ask(id, "Review the next step", decision.detail);
      else {
        const binding = d.bindings.find((b) => b.id === decision.bindingId);
        if (!binding) throw new Error("Jev selected an unbound agent.");
        this.dispatch(d, binding, decision.detail);
      }
      this.changed();
    } catch (e) {
      if (
        !controller.signal.aborted &&
        this.valid(id, d.generation, "routing")
      ) {
        this.store.status(id, "stopped", { stopReason: (e as Error).message });
        this.store.activity(
          id,
          "System",
          "error",
          "Routing stopped",
          (e as Error).message,
        );
        this.changed();
      }
    } finally {
      if (this.routing.get(id) === controller) this.routing.delete(id);
    }
  }
  ask(id: string, title: string, detail: string) {
    this.store.transaction(() => {
      this.store.addRequest({
        id: uid(),
        issueId: id,
        turnId: null,
        kind: "input",
        title,
        detail,
        options: [],
        status: "pending",
        answer: null,
        native: null,
        createdAt: now(),
      });
      this.store.status(id, "waiting_human", { currentTurnId: null });
    });
  }
  async message(
    id: string,
    bindingId: string,
    message: string,
    expectedTurnId?: string | null,
  ) {
    const d = this.require(id);
    const b = d.bindings.find((binding) => binding.id === bindingId);
    if (!b) throw new HttpError(404, "Binding not found.");
    message = message.trim();
    if (!message || message.length > 20000)
      throw new HttpError(400, "Enter a message of 1–20000 characters.");
    if (this.closing) throw new HttpError(409, "The server is shutting down.");
    if (this.store.pending(id))
      throw new HttpError(
        409,
        "Resolve the human request at the top of the issue before sending a message.",
      );
    if (expectedTurnId !== undefined && expectedTurnId !== d.currentTurnId)
      throw new HttpError(
        409,
        "The active turn changed. Review the latest reply before sending again.",
      );
    if (d.status === "running") {
      const turn = d.turns.find((t) => t.id === d.currentTurnId);
      const active = turn && this.active.get(turn.id);
      if (!turn || turn.bindingId !== b.id || !active || active.outcome)
        throw new HttpError(
          409,
          "Wait for the current agent to finish, or stop the issue before messaging this agent.",
        );
      // Preserve ordering relative to streamed replies, but only mark accepted
      // messages as sent once the runtime acknowledges them.
      const messageId = this.store.message(turn.id, "user_pending", message);
      this.changed();
      try {
        await active.handle.send(message);
      } catch (e) {
        this.store.db.prepare("DELETE FROM messages WHERE id=?").run(messageId);
        this.changed();
        throw new HttpError(409, (e as Error).message);
      }
      this.store.update("messages", String(messageId), { kind: "user_steer" });
      this.store.activity(
        id,
        "Human",
        "message",
        `Messaged ${b.name}`,
        message,
      );
      this.changed();
      return;
    }
    if (
      !["ready", "stopped", "done"].includes(d.status) ||
      d.turns.some((t) => ["running", "waiting_approval"].includes(t.status))
    )
      throw new HttpError(
        409,
        "Wait for execution to end before sending a message.",
      );
    this.dispatch({ ...d, generation: d.generation + 1 }, b, message, true);
    this.changed();
  }
  dispatch(d: Detail, b: Binding, instruction: string, chat = false) {
    const turnId = uid();
    const level = b.approvalLevel ?? defaultApprovalLevel(b.runtime);
    const prompt = `Issue ${d.id}: ${d.title}\n\nGoal:\n${d.description}\n\nYour role: ${b.role}\n\nTask: ${instruction}\n\nExecution mode: ${approvalLabels[level]}. ${approvalDescriptions[b.runtime][level]}\n\nPrevious turns:\n${JSON.stringify(d.turns.map((t) => ({ agent: d.bindings.find((b) => b.id === t.bindingId)?.name || t.bindingId, status: t.status, output: t.output })))}\n\nHuman decisions:\n${JSON.stringify(d.requests.map((r) => ({ question: r.title, detail: r.detail, status: r.status, answer: r.answer })))}\n\nRespect human rejections. Report results and any remaining work accurately. Follow the configured execution mode for tool permissions. Ask for missing information or required external authentication; do not ask again for tool operations already authorized by this mode.`;
    this.store.transaction(() => {
      this.store.insert("turns", {
        id: turnId,
        issueId: d.id,
        bindingId: b.id,
        generation: d.generation,
        status: "running",
        input: prompt,
        output: "",
        startedAt: now(),
        endedAt: null,
      });
      if (chat) this.store.message(turnId, "user", instruction);
      this.store.status(d.id, "running", {
        currentTurnId: turnId,
        generation: d.generation,
        stopReason: null,
      });
      if (chat)
        this.store.activity(
          d.id,
          "Human",
          "message",
          `Messaged ${b.name}`,
          instruction,
        );
      this.store.activity(
        d.id,
        b.name,
        "turn_started",
        "Started agent turn",
        b.role,
      );
    });
    const isCurrent = () => {
      const i = this.store.issue(d.id);
      const a = this.active.get(turnId);
      return (
        !this.closing &&
        i?.currentTurnId === turnId &&
        i.generation === (a?.generation ?? d.generation)
      );
    };
    const cb: RuntimeCallbacks = {
      spawned: (pid) => {
        this.store.insert("workers", { id: turnId, pid, birth: birth(pid) });
      },
      message: (kind, text) => {
        this.store.message(turnId, kind, text);
        this.changed();
      },
      session: (sessionId) =>
        this.store.update("bindings", b.id, { sessionId }),
      request: (r) => {
        if (!isCurrent() || this.store.issue(d.id)?.status !== "running")
          return;
        this.store.transaction(() => {
          this.store.update("turns", turnId, { status: "waiting_approval" });
          this.store.addRequest({
            ...r,
            id: uid(),
            issueId: d.id,
            turnId,
            status: "pending",
            answer: null,
            createdAt: now(),
          });
          this.store.status(d.id, "routing");
          this.store.activity(
            d.id,
            b.name,
            "human_requested",
            r.title,
            r.detail,
          );
          this.store.activity(
            d.id,
            "System",
            "approval_gate",
            "Waiting for human approval",
            "Runtime request requires Human decision; automatic execution is suspended.",
          );
          this.store.status(d.id, "waiting_human");
        });
        this.changed();
      },
      complete: (output) => {
        const a = this.active.get(turnId);
        if (a) a.outcome = "completed";
        this.store.update("turns", turnId, { output });
      },
      error: (e) => {
        const a = this.active.get(turnId);
        if (a) a.outcome = "failed";
        this.store.update("turns", turnId, { output: e.message });
        this.store.activity(
          d.id,
          "System",
          "error",
          "Agent execution failed",
          e.message,
        );
        this.changed();
      },
      closed: () => {
        this.store.db.prepare("DELETE FROM workers WHERE id=?").run(turnId);
        const a = this.active.get(turnId);
        this.active.delete(turnId);
        const issue = this.store.issue(d.id);
        if (!issue || issue.currentTurnId !== turnId) return;
        const interrupted =
          issue.status === "stopping" || issue.status === "stopped";
        const failed = a?.outcome !== "completed";
        this.store.transaction(() => {
          this.store.update("turns", turnId, {
            status: interrupted
              ? "interrupted"
              : failed
                ? "failed"
                : "completed",
            endedAt: now(),
          });
          if (interrupted)
            this.store.status(d.id, "stopped", {
              currentTurnId: null,
              stopReason: "Stopped by Human",
            });
          else if (failed) {
            this.store.status(d.id, "stopped", {
              currentTurnId: null,
              stopReason:
                this.store.turns(d.id).find((t) => t.id === turnId)?.output ||
                "Agent disconnected",
            });
            const pending = this.store.pending(d.id);
            if (pending?.native)
              this.store.update("requests", pending.id, { native: null });
          } else {
            this.store.status(
              d.id,
              chat ? (d.status === "done" ? "done" : "stopped") : "routing",
              {
                currentTurnId: null,
                stopReason: null,
              },
            );
            this.store.activity(
              d.id,
              b.name,
              "turn_completed",
              "Finished agent turn",
            );
          }
        });
        this.changed();
        if (!interrupted && !failed && !chat) void this.route(d.id);
      },
    };
    try {
      const handle = this.factory(b, prompt, cb);
      this.active.set(turnId, {
        handle,
        generation: d.generation,
        issueId: d.id,
      });
    } catch (e) {
      cb.error(e as Error);
      cb.closed();
    }
  }
  respond(id: string, requestId: string, answer: string, approved: boolean) {
    const d = this.require(id);
    const r = d.requests.find((r) => r.id === requestId);
    if (!r) throw new HttpError(404, "Request not found.");
    if (r.status !== "pending") return;
    if (d.status !== "waiting_human")
      throw new HttpError(409, "Start the issue before responding.");
    if (r.kind === "input" && !answer.trim())
      throw new HttpError(400, "An answer is required.");
    if (r.kind === "approval" && !approved && !answer.trim())
      throw new HttpError(400, "Explain what needs to change.");
    if (r.options.length && !r.options.includes(answer))
      throw new HttpError(400, "Choose one of the listed options.");
    if (r.native?.method === "item/tool/requestUserInput") {
      try {
        codexAnswers(r.native.params.questions, answer);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }
    if (r.native?.method === "mcpServer/elicitation/request") {
      try {
        codexMcpResponse(r.native.params, answer, approved);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }
    const a = r.turnId ? this.active.get(r.turnId) : undefined;
    this.store.transaction(() => {
      this.store.update("requests", r.id, {
        status:
          r.kind === "approval"
            ? approved
              ? "approved"
              : "rejected"
            : "answered",
        answer: answer || "Approved",
      });
      this.store.status(id, "routing");
      this.store.activity(
        id,
        "Human",
        "human_decision",
        r.kind === "approval"
          ? approved
            ? "Approved request"
            : "Requested changes"
          : "Answered question",
        answer,
      );
    });
    if (r.native && a && r.turnId) {
      this.store.transaction(() => {
        this.store.update("turns", r.turnId!, { status: "running" });
        this.store.status(id, "running", { currentTurnId: r.turnId });
        this.store.activity(
          id,
          "System",
          "runtime_resumed",
          "Resumed the requesting Agent",
          "Human decision applies to this exact suspended request.",
        );
      });
      try {
        a.handle.respond(r, answer, approved);
      } catch (e) {
        this.store.status(id, "stopping", { stopReason: (e as Error).message });
        void a.handle.stop();
      }
    } else {
      this.store.status(id, "routing", { currentTurnId: null });
      void this.route(id);
    }
    this.changed();
  }
  recover() {
    // A crash can happen after native acceptance but before its acknowledgement
    // is saved. Retain the message without claiming delivery or replaying it.
    this.store.db.exec(
      "UPDATE messages SET kind='user_unconfirmed' WHERE kind='user_pending'",
    );
    for (const d of this.store.list()) {
      const workers = this.store.db
        .prepare(
          "SELECT w.* FROM workers w JOIN turns t ON t.id=w.id WHERE t.issueId=?",
        )
        .all(d.id) as unknown as { id: string; pid: number; birth: string }[];
      const live = workers.filter((w) => w.birth && birth(w.pid) === w.birth);
      if (
        !["running", "routing", "stopping", "waiting_human"].includes(
          d.status,
        ) &&
        !live.length
      )
        continue;
      const finish = () => {
        this.store.transaction(() => {
          for (const t of this.store.turns(d.id))
            if (["running", "waiting_approval"].includes(t.status))
              this.store.update("turns", t.id, {
                status: "interrupted",
                endedAt: now(),
              });
          for (const r of this.store.requests(d.id))
            if (r.status === "pending" && r.native)
              this.store.update("requests", r.id, { native: null });
          for (const w of workers)
            this.store.db.prepare("DELETE FROM workers WHERE id=?").run(w.id);
          this.store.status(d.id, "stopped", {
            currentTurnId: null,
            stopReason:
              "Server restarted. Previous execution ended; review the results before starting again.",
          });
          this.store.activity(
            d.id,
            "System",
            "recovered",
            "Automatic progress stopped after restart",
          );
        });
        this.changed();
      };
      if (live.length) {
        this.store.status(d.id, "stopping", {
          stopReason: "Verifying previous runtime shutdown after restart.",
        });
        for (const w of live)
          try {
            process.kill(-w.pid, "SIGTERM");
          } catch {}
        const timer = setInterval(() => {
          if (this.closing) {
            clearInterval(timer);
            return;
          }
          if (live.every((w) => birth(w.pid) !== w.birth)) {
            clearInterval(timer);
            finish();
          }
        }, 250);
        timer.unref();
      } else finish();
    }
  }
  async shutdown() {
    this.closing = true;
    for (const c of this.routing.values()) c.abort();
    await Promise.allSettled(
      [...this.active.values()].map((a) => a.handle.stop()),
    );
  }
}
