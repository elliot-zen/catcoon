import { execFileSync } from "node:child_process";
import { Codex } from "./agents/codex.ts";
import { Pi } from "./agents/pi.ts";
import { join, resolve } from "node:path";
import { Store, id, now, find, fail, hash } from "./store.ts";
import {
  Domain,
  task,
  event,
  recompute,
  dependencies,
  artifact,
  makeRequest,
  finalReady,
} from "./domain.ts";
import { validateWorktree, readSpec, repository } from "./files.ts";
import { evaluate } from "./jev.ts";
import { activeRun } from "./types.ts";
import type { State, Task, Binding, Run, Request, Session } from "./types.ts";
const reportContract = `Advance the Issue within your assigned scope. When work remains, include concrete follow-up tasks for Triage to route using the binding descriptions, together with any required approval or clarification requests. The user should not need to manually create the next task, publish your artifacts, or create your requests. Return a final fenced JSON object: {"summary":"...","artifacts":[{"supersedesId":"optional old artifact ID", "kind":"spec|contract|code|test|report","title":"...","content":"complete inspectable content / evidence"}],"tasks":[{"text":"next concrete work","bindingId":"optional current binding ID","dependencyIds":[]}],"requests":[{"supersedesId":"optional old request ID", "kind":"input|approval","title":"question","body":"context","artifactIndexes":[0],"action":"scope of requested authorization","scope":"issue or task ID array","routeToAgent":false}],"answer":{"requestId":"only for assigned clarification task","text":"answer"}}. Do not claim testing passed without actual evidence. Approval requires frozen artifacts and explicit action; humans alone decide. If requesting input, stop the blocked work. All continued work subject to approval must be represented as a task that depends on the request. No merge, deployment or arbitrary external writes without explicit scoped authorization. Write only in the assigned worktree. Descriptions are routing hints, not authority. Do not invent requirements. Never output private reasoning or secrets.`;
export function parseReport(content: string) {
  const matches = [...content.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)];
  for (const m of matches.reverse()) {
    try {
      const x = JSON.parse(m[1]);
      if (typeof x.summary === "string") return x;
    } catch {}
  }
  try {
    const x = JSON.parse(content);
    if (typeof x.summary === "string") return x;
  } catch {}
  return undefined;
}
export class Runtime {
  store: Store;
  domain: Domain;
  running = new Map<string, { interrupt: () => Promise<any> }>();
  codex?: Codex;
  loadedThreads = new Set<string>();
  finalMessages = new Map<string, string>();
  nativeItems = new Map<string, any>();
  pendingNative = new Set<string>();
  pis = new Map<string, Pi>();
  timers = new Map<string, ReturnType<typeof setTimeout>>();
  recovered = false;
  nativeStarting = new Map<string, string>();
  inflight = new Set<string>();
  closing = false;
  fetcher: typeof fetch;
  constructor(store: Store, fetcher: typeof fetch = fetch) {
    this.store = store;
    this.domain = new Domain(store);
    this.fetcher = fetcher;
  }
  refresh(resetAuth = false) {
    const agents = ["codex", "pi"].map((command) => {
      try {
        const version = execFileSync(command, ["--version"], {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return {
          id: command,
          name: command === "pi" ? "Pi" : "Codex",
          command,
          version,
          status: "available",
          heartbeat: now(),
          reason:
            "Version probe succeeded; authentication checked on execution",
        };
      } catch {
        return {
          id: command,
          name: command === "pi" ? "Pi" : "Codex",
          command,
          version: "",
          status: "missing",
          heartbeat: "",
          reason: "Executable unavailable",
        };
      }
    });
    this.store.change((s) => {
      for (const a of agents) {
        const existing = s.agents.find((x) => x.id === a.id);
        if (
          !resetAuth &&
          existing?.status === "authentication required" &&
          a.status === "available"
        ) {
          a.status = existing.status;
          a.reason = existing.reason;
        }
        if (existing) Object.assign(existing, a);
        else s.agents.push(a);
      }
      for (const p of s.projects) {
        try {
          const repo = repository(p.path);
          p.health = repo.dirty ? "needs attention" : "healthy";
          p.healthReason = repo.dirty
            ? "Uncommitted changes found; verify existing work before execution"
            : "Git directory verified";
          for (const w of s.worktrees.filter((w) => w.projectId === p.id))
            if (validateWorktree(w, p).dirty) {
              p.health = "needs attention";
              p.healthReason =
                "Worktree has uncommitted changes; inspect existing work";
            }
        } catch (e) {
          p.health = "needs attention";
          p.healthReason =
            e instanceof Error ? e.message : "Directory unavailable";
        }
        p.checkedAt = now();
      }
      return s.agents;
    });
    return agents;
  }
  context(s: State, t: Task, b: Binding) {
    const w = find(s.worktrees, b.worktreeId),
      p = find(s.projects, b.projectId),
      i = find(s.issues, t.issueId);
    validateWorktree(w, p);
    const specs = {
      product: readSpec(w, "product"),
      tech: readSpec(w, "tech"),
    };
    const binary = s.attachments.filter(
      (a) => a.issueId === i.id && !a.mime.startsWith("text/"),
    );
    if (
      binary.length &&
      !s.requests.some(
        (r) =>
          r.taskId === t.id &&
          r.status === "Answered" &&
          r.body.includes(
            "Binary attachments require a textual interpretation",
          ),
      )
    )
      fail(
        409,
        "DEPENDENCY_BLOCKED",
        "Binary attachments require a textual interpretation. Supply the necessary content in your answer before execution.",
      );
    const context = JSON.stringify(
      {
        task: t,
        issue: i,
        binding: b,
        bindings: s.bindings.filter((x) => x.issueId === i.id && !x.removed),
        worktree: w,
        project: p,
        specs,
        artifacts: s.artifacts.filter((a) => a.issueId === i.id),
        requests: s.requests.filter((r) => r.issueId === i.id),
        comments: s.comments.filter((c) => c.issueId === i.id),
        attachments: s.attachments
          .filter((a) => a.issueId === i.id)
          .map((a) =>
            a.mime.startsWith("text/")
              ? {
                  ...a,
                  content: Buffer.from(a.content, "base64").toString("utf8"),
                }
              : {
                  id: a.id,
                  name: a.name,
                  mime: a.mime,
                  note: "Binary material is not readable by this text-only adapter. Request a textual interpretation before relying on it.",
                },
          ),
      },
      null,
      2,
    );
    if (Buffer.byteLength(context) > 256000)
      fail(
        409,
        "DEPENDENCY_BLOCKED",
        "Required context exceeds 256KB; publish scoped materials before proceeding",
      );
    return reportContract + "\n\n" + context;
  }
  human(s: State, t: Task, reason: string, route = false) {
    if (t.requestId) {
      const original = find(s.requests, t.requestId);
      if (original.status === "Pending") {
        original.recipient = "Human";
        const notification = s.notifications.find(
          (n) => n.requestId === original.id,
        );
        if (notification) {
          notification.archived = false;
          notification.read = false;
        }
        t.status = "waiting";
        t.reason = reason;
        event(s, t.issueId, "Triage", "request.escalated", reason, {
          requestId: original.id,
          taskId: t.id,
        });
        return original;
      }
    }
    const existing = s.requests.find(
      (r) => r.taskId === t.id && r.status === "Pending",
    );
    if (existing) return existing;
    const bs = s.bindings.filter((b) => b.issueId === t.issueId && !b.removed);
    t.status = "waiting";
    t.reason = reason;
    return makeRequest(s, {
      issueId: t.issueId,
      taskId: t.id,
      kind: "input",
      title: route
        ? "Choose a binding for this task"
        : "Execution needs your input",
      body: `${t.text}\n\n${reason}`,
      options:
        route && bs.length
          ? bs.map((b) => ({
              value: b.id,
              label: `${find(s.agents, b.agentId).name} · ${find(s.projects, b.projectId).name} · ${find(s.worktrees, b.worktreeId).branch} · ${b.description}`,
            }))
          : undefined,
      routeTask: route && bs.length > 0,
      source: "Triage",
      scope: [t.id],
    });
  }
  async tick() {
    if (this.closing) return;
    if (!this.recovered) {
      this.recovered = true;
      await this.recoverNative();
    }
    for (const [runId, control] of this.running) {
      const r = this.store.read().runs.find((x) => x.id === runId);
      if (r?.status === "stopping") {
        this.running.delete(runId);
        void control.interrupt().catch((e) => this.unknown(runId, String(e)));
      }
    }
    const s = this.store.read();
    for (const i of s.issues) {
      if (
        !i.started ||
        i.paused ||
        i.status === "Done" ||
        this.inflight.has(i.id) ||
        s.runs.some((r) => r.issueId === i.id && activeRun(r)) ||
        s.sessions.some(
          (x) =>
            x.busyTurnId &&
            s.bindings.some((b) => b.id === x.bindingId && b.issueId === i.id),
        )
      )
        continue;
      const t = s.tasks.find(
        (t) =>
          t.issueId === i.id &&
          ["pending", "waiting"].includes(t.status) &&
          !t.reason?.startsWith("Execution failed") &&
          (!t.retryAt || t.retryAt < Date.now()) &&
          dependencies(s, t) &&
          !(
            t.requestId &&
            s.requests.some(
              (r) =>
                r.id === t.requestId &&
                r.status === "Pending" &&
                r.recipient === "Human",
            )
          ),
      );
      if (t) {
        this.inflight.add(i.id);
        void this.dispatch(t.id)
          .catch(() => {})
          .finally(() => this.inflight.delete(i.id));
      } else if (
        s.tasks.filter((t) => t.issueId === i.id).length &&
        s.tasks
          .filter((t) => t.issueId === i.id)
          .every((t) => ["done", "cancelled"].includes(t.status)) &&
        !s.requests.some(
          (r) =>
            r.issueId === i.id && r.kind === "final" && r.status === "Pending",
        )
      ) {
        try {
          this.domain.action("issue.control", {
            issueId: i.id,
            command: "final",
          });
        } catch {}
      }
    }
  }
  async dispatch(taskId: string) {
    let s = this.store.read();
    let t = find(s.tasks, taskId);
    const issue = find(s.issues, t.issueId);
    if (
      issue.paused ||
      issue.status === "Done" ||
      !dependencies(s, t) ||
      s.runs.some((r) => r.issueId === issue.id && activeRun(r))
    )
      return;
    try {
      if (
        s.runs.filter((r) => r.issueId === issue.id).length -
          (issue.runBudgetStart || 0) >=
        64
      ) {
        this.store.change((s) => {
          find(s.issues, issue.id).paused = true;
          this.human(
            s,
            find(s.tasks, taskId),
            "Automatic run limit reached (64 runs since Start/Resume). Inspect progress and remaining scope, then explicitly Resume.",
          );
          recompute(s);
        });
        return;
      }
      if (t.attempts >= 8) {
        this.store.change((s) => {
          this.human(
            s,
            find(s.tasks, taskId),
            "Execution limit reached (8 attempts). Inspect existing results and adjust the work scope.",
          );
          recompute(s);
        });
        return;
      }
      let candidates = s.bindings.filter(
        (b) => b.issueId === issue.id && !b.removed,
      );
      if (t.bindingId)
        candidates = candidates.filter((b) => b.id === t.bindingId);
      if (!candidates.length) {
        this.store.change((s) => {
          this.human(
            s,
            find(s.tasks, taskId),
            "Add a valid Agent binding.",
            true,
          );
          recompute(s);
        });
        return;
      }
      let selected = candidates.find((b) => b.id === t.bindingId);
      if (!selected) {
        if (candidates.length > 254)
          fail(
            409,
            "DEPENDENCY_BLOCKED",
            "Too many bindings for one Choice (maximum 254)",
          );
        const criteria: Record<string, unknown> = {
          human:
            "Human clarification or decision; no suitable binding or conflicting descriptions",
        };
        for (const b of candidates)
          criteria[b.id] = {
            description: b.description,
            project: find(s.projects, b.projectId).name,
            worktree: find(s.worktrees, b.worktreeId).path,
            availability: find(s.agents, b.agentId).status,
          };
        const token = find(s.issues, issue.id).revision;
        const answer = await evaluate(
          this.store.key(),
          {
            issue,
            task: t,
            bindings: candidates,
            artifacts: s.artifacts.filter((a) => a.issueId === issue.id),
            requests: s.requests.filter((r) => r.issueId === issue.id),
            tasks: s.tasks.filter((x) => x.issueId === issue.id),
            comments: s.comments.filter((x) => x.issueId === issue.id),
          },
          criteria,
          (attempt, status) =>
            this.store.change((s) => {
              event(
                s,
                issue.id,
                "Triage",
                "output",
                `Jev attempt ${attempt}: ${status}`,
                { taskId },
              );
            }),
          this.fetcher,
        );
        s = this.store.read();
        t = find(s.tasks, taskId);
        if (
          find(s.issues, issue.id).revision !== token ||
          find(s.issues, issue.id).paused ||
          t.status === "cancelled"
        )
          return;
        if (answer.choice === "human" || answer.confidence < 0.65) {
          this.store.change((s) => {
            this.human(
              s,
              find(s.tasks, taskId),
              `Jev choice: ${answer.choice}; confidence: ${answer.confidence.toFixed(3)}. Confirm the work scope.`,
              true,
            );
            recompute(s);
          });
          return;
        }
        selected = find(s.bindings, answer.choice);
        this.store.change((s) => {
          event(
            s,
            issue.id,
            "Triage",
            "triage.selected",
            `Binding ${selected!.id}; confidence ${answer.confidence.toFixed(3)}`,
            { taskId, bindingId: selected!.id, data: answer },
          );
        });
      }
      s = this.store.read();
      t = find(s.tasks, taskId);
      const b = find(s.bindings, selected.id),
        w = find(s.worktrees, b.worktreeId),
        a = find(s.agents, b.agentId);
      if (b.removed) fail(409, "STALE_VERSION", "Binding removed");
      if (a.status !== "available") fail(503, "AGENT_UNAVAILABLE", a.reason);
      if (a.command === "codex") await this.prepareCodex(b.id, w.path);
      const context = this.context(this.store.read(), t, b);
      const r = this.begin(taskId, b.id, context, b.revision);
      if (r) this.launch(r);
    } catch (e) {
      this.store.change((s) => {
        const t = find(s.tasks, taskId);
        if (["running", "done", "cancelled", "unknown"].includes(t.status))
          return;
        const reason = this.store.redact(
          e instanceof Error ? e.message : "Execution unavailable",
        );
        const oldReason = t.reason;
        t.reason = reason;
        t.status = "waiting";
        t.retryAt = Date.now() + 60000;
        if (reason.includes("locked") || reason.includes("Worktree is busy")) {
          if (oldReason !== reason)
            event(s, t.issueId, "Triage", "triage.waiting", reason, {
              taskId: t.id,
              bindingId: t.bindingId,
            });
          return;
        }
        this.human(s, t, reason);
        recompute(s);
      });
    }
  }
  begin(taskId: string, bindingId: string, context: string, revision: number) {
    return this.store.change((s) => {
      const t = find(s.tasks, taskId),
        i = find(s.issues, t.issueId),
        b = find(s.bindings, bindingId),
        w = find(s.worktrees, b.worktreeId),
        p = find(s.projects, b.projectId),
        a = find(s.agents, b.agentId);
      if (
        !i.started ||
        i.paused ||
        i.status === "Done" ||
        b.removed ||
        b.revision !== revision ||
        !["pending", "waiting"].includes(t.status) ||
        !dependencies(s, t) ||
        s.runs.some((r) => r.issueId === i.id && activeRun(r)) ||
        s.sessions.some(
          (x) =>
            x.busyTurnId &&
            s.bindings.some((b) => b.id === x.bindingId && b.issueId === i.id),
        )
      )
        return;
      validateWorktree(w, p);
      if (a.status !== "available")
        fail(503, "AGENT_UNAVAILABLE", "Agent unavailable");
      if (
        this.store.db
          .prepare("SELECT run_id FROM locks WHERE path=?")
          .get(w.path)
      )
        fail(
          409,
          "WORKTREE_BUSY",
          "Worktree is busy / locked by another execution",
        );
      const r: Run = {
        id: id(),
        issueId: i.id,
        taskId: t.id,
        bindingId: b.id,
        snapshot: {
          ...b,
          path: w.path,
          branch: w.branch,
          projectName: p.name,
          agentName: a.name,
          command: a.command,
        },
        context,
        status: "starting",
        startedAt: now(),
      };
      this.store.db.prepare("INSERT INTO locks VALUES(?,?)").run(w.path, r.id);
      s.runs.push(r);
      t.status = "running";
      t.bindingId = b.id;
      t.attempts++;
      event(s, i.id, "Triage", "run.scheduled", t.text, {
        runId: r.id,
        taskId: t.id,
        bindingId: b.id,
        data: r.snapshot,
      });
      return r;
    });
  }
  session(bindingId: string, agentId: string, path: string): Session {
    const old = this.store
      .read()
      .sessions.find(
        (x) =>
          x.bindingId === bindingId && x.agentId === agentId && x.path === path,
      );
    if (old) return old;
    return this.store.change((s) => {
      const x: Session = {
        id: id(),
        bindingId,
        agentId,
        path,
        version: find(s.agents, agentId).version,
        status: "idle",
        createdAt: now(),
      };
      if (agentId === "pi")
        x.sessionFile = join(resolve(this.store.dir), "pi", x.id + ".jsonl");
      s.sessions.push(x);
      return x;
    });
  }
  async codexClient() {
    if (!this.codex) {
      const c = (this.codex = new Codex(this.store.dir));
      c.on("message", (m) => {
        if (!this.closing) this.codexMessage(m);
      });
      c.on("disconnect", (reason) => {
        this.loadedThreads.clear();
        this.pendingNative.clear();
        if (!this.closing)
          for (const r of this.store
            .read()
            .runs.filter(
              (r) =>
                r.snapshot.command === "codex" &&
                ["starting", "running", "stopping"].includes(r.status),
            ))
            this.unknown(r.id, reason);
      });
    }
    await this.codex.connect();
    if (this.closing) throw new Error("Relay stopped");
    return this.codex;
  }
  async prepareCodex(bindingId: string, path: string) {
    const c = await this.codexClient();
    const x = this.session(bindingId, "codex", path);
    let thread: any;
    if (x.threadId) {
      if (
        this.loadedThreads.has(x.threadId) &&
        !this.store
          .read()
          .runs.some((r) => r.sessionId === x.id && r.nativeTurnId)
      )
        thread = { id: x.threadId, status: { type: "idle" } };
      else
        thread = (
          await c.call(
            this.loadedThreads.has(x.threadId)
              ? "thread/read"
              : "thread/resume",
            { threadId: x.threadId, cwd: path, includeTurns: true },
          )
        ).thread;
    } else {
      thread = (
        await c.call("thread/start", {
          cwd: path,
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          ephemeral: false,
        })
      ).thread;
      if (this.closing) throw new Error("Relay stopped");
      this.store.change((s) =>
        Object.assign(find(s.sessions, x.id), {
          threadId: thread.id,
          endpoint: c.endpoint,
          status: "idle",
        }),
      );
    }
    if (this.closing) throw new Error("Relay stopped");
    this.loadedThreads.add(thread.id);
    this.store.change((s) => {
      find(s.sessions, x.id).endpoint = c.endpoint;
    });
    const active = thread.turns?.find((t: any) => t.status === "inProgress");
    if (
      thread.status?.type === "active" ||
      active ||
      this.store.read().sessions.find((a) => a.id === x.id)?.busyTurnId
    ) {
      if (active) this.externalTurn(x.id, active.id);
      fail(
        409,
        "WORKTREE_BUSY",
        "Worktree is busy / locked by native terminal session",
      );
    }
    return find(this.store.read().sessions, x.id);
  }
  armTimeout(r: Run) {
    clearTimeout(this.timers.get(r.id));
    const timeout = setTimeout(
      () => {
        if (this.closing) return;
        this.store.change((s) => {
          const run = find(s.runs, r.id);
          if (["starting", "running"].includes(run.status)) {
            run.status = "stopping";
            run.stopRequested = true;
            run.reason = "30 minute execution limit";
          }
        });
        void this.tick();
      },
      Math.max(0, 30 * 60000 - (Date.now() - new Date(r.startedAt).getTime())),
    );
    timeout.unref();
    this.timers.set(r.id, timeout);
  }
  launch(r: Run) {
    void this.launchNative(r).catch((e) => {
      if (!this.closing) this.unknown(r.id, this.store.redact(String(e)));
    });
  }
  async launchNative(r: Run) {
    const x = this.session(r.bindingId, r.snapshot.command, r.snapshot.path);
    this.store.change((s) => {
      find(s.runs, r.id).sessionId = x.id;
    });
    this.armTimeout(r);
    if (r.snapshot.command === "codex") {
      const c = await this.codexClient();
      const ready = await this.prepareCodex(r.bindingId, r.snapshot.path);
      this.nativeStarting.set(ready.threadId!, r.id);
      try {
        const { turn } = await c.call("turn/start", {
          threadId: ready.threadId,
          clientUserMessageId: r.id,
          input: [{ type: "text", text: r.context }],
        });
        this.started(r.id, x.id, turn.id, c.child?.pid);
        if (turn.status !== "inProgress") this.turnResult(r.id, turn);
      } finally {
        this.nativeStarting.delete(ready.threadId!);
      }
      if (
        ["starting", "running", "stopping"].includes(
          find(this.store.read().runs, r.id).status,
        )
      )
        this.running.set(r.id, {
          interrupt: () =>
            c.call("turn/interrupt", {
              threadId: ready.threadId,
              turnId: find(this.store.read().runs, r.id).nativeTurnId,
            }),
        });
    } else {
      if (!/^1\./.test(x.version) && x.version !== "test")
        throw new Error(
          "Pi 1.0.0 RPC required; installed version: " + x.version,
        );
      const pi = new Pi(x.sessionFile!, x.path);
      this.pis.set(x.id, pi);
      let final = "",
        stopReason = "",
        failure = "";
      pi.on("message", (m) => {
        if (this.closing) return;
        if (m.type === "message_end" && m.message?.role === "assistant") {
          final = (m.message.content || [])
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n");
          stopReason = m.message.stopReason || "";
          failure = m.message.errorMessage || "";
        }
        if (m.type === "extension_ui_request")
          this.nativeRequest(r.id, x.id, m.id, "pi/" + m.method, m);
        else if (m.type === "agent_settled") {
          this.nativeFinished(r.id, x.id);
          this.complete(
            r.id,
            !failure && !["error", "aborted"].includes(stopReason),
            final,
            failure,
          );
          pi.shutdown();
          this.pis.delete(x.id);
        } else if (
          [
            "tool_execution_start",
            "tool_execution_end",
            "message_end",
            "agent_end",
            "auto_retry_start",
            "auto_retry_end",
            "auto_compaction_start",
            "auto_compaction_end",
          ].includes(m.type)
        )
          this.step(r, m.type, m);
      });
      pi.on("disconnect", (reason) => {
        if (this.closing) return;
        for (const q of this.store
          .read()
          .requests.filter((q) => q.native?.sessionId === x.id))
          this.pendingNative.delete(q.id);
        if (!this.closing) this.unknown(r.id, reason);
      });
      const state = await pi.call("get_state");
      this.store.change((s) => {
        find(s.sessions, x.id).sessionFile = state.sessionFile || x.sessionFile;
      });
      this.started(r.id, x.id, id(), pi.child.pid);
      this.running.set(r.id, { interrupt: () => pi.interrupt() });
      await pi.call("prompt", { message: r.context });
    }
  }
  started(runId: string, sessionId: string, turnId: string, pid?: number) {
    if (this.closing) return;
    this.store.change((s) => {
      const r = find(s.runs, runId);
      if (!["starting", "running", "stopping", "unknown"].includes(r.status))
        return;
      const duplicate = r.nativeTurnId === turnId;
      const reattached = r.status === "unknown";
      r.nativeTurnId = turnId;
      if (pid !== undefined) r.pid = pid;
      r.sessionId = sessionId;
      if (r.stopRequested) r.status = "stopping";
      else if (r.status !== "stopping") r.status = "running";
      find(s.tasks, r.taskId).status = "running";
      Object.assign(find(s.sessions, sessionId), {
        busyTurnId: turnId,
        status: "running",
      });
      if (!duplicate || reattached)
        event(
          s,
          r.issueId,
          r.snapshot.agentName,
          reattached ? "run.attached" : "run.started",
          r.snapshot.path,
          { runId, taskId: r.taskId, bindingId: r.bindingId },
        );
    });
  }
  step(r: Run, type: string, data: any) {
    const output = this.store.redact(
      JSON.stringify(data, (key, value) =>
        /thinking|reasoning/i.test(key) ||
        (value &&
          typeof value === "object" &&
          /thinking|reasoning/i.test(value.type || ""))
          ? undefined
          : value,
      ),
    );
    this.store.change((s) =>
      event(
        s,
        r.issueId,
        r.snapshot.agentName,
        "step",
        data.command || data.name || type,
        {
          runId: r.id,
          taskId: r.taskId,
          bindingId: r.bindingId,
          data: {
            type,
            output:
              output.slice(0, 64000) +
              (output.length > 64000
                ? "\n[Truncated: event exceeds 64KB]"
                : ""),
          },
        },
      ),
    );
  }
  externalTurn(sessionId: string, turnId: string) {
    this.store.change((s) => {
      const x = find(s.sessions, sessionId);
      const b = find(s.bindings, x.bindingId);
      const duplicate = x.busyTurnId === turnId && x.status === "running";
      x.busyTurnId = turnId;
      x.status = "running";
      this.store.db
        .prepare("INSERT OR IGNORE INTO locks VALUES(?,?)")
        .run(x.path, "native:" + x.id);
      if (!duplicate)
        event(
          s,
          b.issueId,
          "Terminal",
          "session.running",
          "Native terminal turn " + turnId,
          { bindingId: b.id, data: { sessionId: x.id, nativeTurnId: turnId } },
        );
    });
  }
  codexMessage(m: any) {
    const p = m.params || {};
    const x = this.store.read().sessions.find((x) => x.threadId === p.threadId);
    if (!x) return;
    let r = this.store
      .read()
      .runs.find(
        (r) =>
          r.sessionId === x.id &&
          r.nativeTurnId === p.turnId &&
          ["starting", "running", "stopping", "unknown"].includes(r.status),
      );
    const starting = this.nativeStarting.get(p.threadId);
    if (!r && starting) {
      this.started(starting, x.id, p.turnId || p.turn?.id);
      r = find(this.store.read().runs, starting);
    }
    if (m.id !== undefined && m.method) {
      if (r) {
        const proposedItem = this.nativeItems.get(p.threadId + ":" + p.itemId);
        this.nativeRequest(
          r.id,
          x.id,
          m.id,
          m.method,
          proposedItem ? { ...p, proposedItem } : p,
        );
      }
      return;
    }
    if (m.method === "item/started" && p.item?.type !== "reasoning") {
      this.nativeItems.set(p.threadId + ":" + p.item.id, p.item);
      if (r) this.step(r, p.item.type, p.item);
    }
    if (m.method === "turn/started") {
      if (r) this.started(r.id, x.id, p.turn.id);
      else this.externalTurn(x.id, p.turn.id);
    }
    if (m.method === "item/completed" && p.item?.type !== "reasoning") {
      if (r) {
        if (p.item.type === "agentMessage")
          this.finalMessages.set(
            p.turnId,
            this.store.redact(p.item.text).slice(0, 256000),
          );
        this.step(r, p.item.type, p.item);
      } else
        this.store.change((s) =>
          event(
            s,
            find(s.bindings, x.bindingId).issueId,
            "Terminal",
            "step",
            p.item.type,
            {
              bindingId: x.bindingId,
              data: {
                sessionId: x.id,
                nativeTurnId: p.turnId,
                output: this.store
                  .redact(JSON.stringify(p.item))
                  .slice(0, 64000),
              },
            },
          ),
        );
    }
    if (m.method === "turn/completed") {
      r = this.store
        .read()
        .runs.find(
          (a) =>
            a.sessionId === x.id &&
            a.nativeTurnId === p.turn.id &&
            ["starting", "running", "stopping", "unknown"].includes(a.status),
        );
      if (r) this.turnResult(r.id, p.turn);
      else
        this.store.change((s) => {
          const a = find(s.sessions, x.id);
          if (a.busyTurnId === p.turn.id) {
            a.busyTurnId = undefined;
            a.status = "idle";
            this.store.db
              .prepare("DELETE FROM locks WHERE run_id=?")
              .run("native:" + x.id);
          }
          event(
            s,
            find(s.bindings, x.bindingId).issueId,
            "Terminal",
            "session.completed",
            p.turn.status,
            {
              bindingId: x.bindingId,
              data: { sessionId: x.id, nativeTurnId: p.turn.id },
            },
          );
        });
    }
    if (m.method === "serverRequest/resolved")
      this.store.change((s) => {
        for (const q of s.requests.filter(
          (q) =>
            q.native?.sessionId === x.id &&
            q.native.rpcId === p.requestId &&
            this.pendingNative.has(q.id),
        )) {
          this.pendingNative.delete(q.id);
          if (q.status !== "Pending") {
            q.native!.delivery = "confirmed";
            continue;
          }
          q.status = "Resolved externally";
          q.revision++;
          event(s, q.issueId, "Terminal", "request.external", q.title, {
            requestId: q.id,
          });
        }
        recompute(s);
      });
  }
  turnResult(runId: string, turn: any) {
    const r = find(this.store.read().runs, runId);
    if (r.status === "unknown")
      this.store.change((s) => {
        find(s.runs, runId).status = r.stopRequested ? "stopping" : "running";
      });
    this.nativeFinished(runId, r.sessionId!);
    const text =
      this.finalMessages.get(turn.id) ||
      (turn.items || [])
        .filter((i: any) => i.type === "agentMessage")
        .map((i: any) => i.text)
        .join("\n") ||
      this.store
        .read()
        .events.filter(
          (e) =>
            e.runId === runId &&
            e.type === "step" &&
            (e.data as any)?.type === "agentMessage",
        )
        .map((e) => {
          try {
            return JSON.parse((e.data as any).output).text;
          } catch {
            return "";
          }
        })
        .join("\n");
    if (turn.status === "interrupted")
      this.store.change((s) => {
        find(s.runs, runId).status = "stopping";
      });
    this.finalMessages.delete(turn.id);
    for (const item of turn.items || [])
      this.nativeItems.delete(
        (find(this.store.read().sessions, r.sessionId!).threadId || "") +
          ":" +
          item.id,
      );
    this.complete(
      runId,
      turn.status === "completed",
      text,
      turn.error?.message || "",
    );
  }
  nativeFinished(runId: string, sessionId: string) {
    clearTimeout(this.timers.get(runId));
    this.timers.delete(runId);
    this.running.delete(runId);
    this.store.change((s) => {
      const x = find(s.sessions, sessionId);
      x.busyTurnId = undefined;
      x.status = "idle";
      for (const q of s.requests.filter(
        (q) =>
          q.native?.sessionId === sessionId &&
          q.taskId === find(s.runs, runId).taskId &&
          q.status === "Pending",
      )) {
        q.status = "Cancelled";
        q.revision++;
        this.pendingNative.delete(q.id);
      }
      recompute(s);
    });
  }
  unknown(runId: string, reason: string) {
    clearTimeout(this.timers.get(runId));
    this.timers.delete(runId);
    this.running.delete(runId);
    this.store.change((s) => {
      const r = find(s.runs, runId);
      if (!["starting", "running", "stopping"].includes(r.status)) return;
      if (r.status === "stopping") r.stopRequested = true;
      r.status = "unknown";
      r.reason = reason;
      find(s.tasks, r.taskId).status = "unknown";
      if (r.sessionId) find(s.sessions, r.sessionId).status = "unknown";
      event(s, r.issueId, "System", "run.unknown", reason, { runId });
    });
  }
  nativeRequest(
    runId: string,
    sessionId: string,
    rpcId: string | number,
    method: string,
    params: any,
  ) {
    if (
      method === "item/tool/requestUserInput" &&
      params.questions?.some((q: any) => q.isSecret)
    ) {
      this.unknown(
        runId,
        "Secret input must be supplied in the local Codex terminal",
      );
      return;
    }
    const input =
      method === "item/tool/requestUserInput" ||
      /^pi\/(select|input|editor)$/.test(method);
    const approval = /requestApproval$/.test(method) || method === "pi/confirm";
    if (!input && !approval) {
      if (method.startsWith("pi/")) return;
      this.unknown(runId, "Unsupported blocking native request: " + method);
      return;
    }
    const requestId = this.store.change((s) => {
      const existing = s.requests.find(
        (q) =>
          q.native?.sessionId === sessionId &&
          q.native.rpcId === rpcId &&
          q.native.method === method &&
          q.native.params.turnId === params.turnId &&
          q.status === "Pending",
      );
      if (existing) return existing.id;
      const r = find(s.runs, runId);
      for (const q of s.requests.filter(
        (q) =>
          q.native?.sessionId === sessionId &&
          q.native.method === method &&
          params.itemId &&
          q.native.params.itemId === params.itemId &&
          q.taskId === r.taskId &&
          q.status === "Pending",
      )) {
        q.status = "Superseded";
        q.revision++;
        for (const n of s.notifications.filter((n) => n.requestId === q.id))
          n.archived = true;
      }
      const material = artifact(s, {
        issueId: r.issueId,
        runId,
        bindingId: r.bindingId,
        kind: "report",
        title: "Native tool request",
        content: this.store.redact(JSON.stringify(params, null, 2)),
      });
      const q = makeRequest(s, {
        issueId: r.issueId,
        taskId: r.taskId,
        kind: input ? "input" : "approval",
        source: r.snapshot.agentName,
        title: (params.title || params.reason || method).slice(0, 500),
        body: this.store.redact(JSON.stringify(params, null, 2)),
        scope: [r.taskId],
        options:
          method === "pi/select"
            ? params.options.map((value: string) => ({ value, label: value }))
            : undefined,
        artifactIds: approval ? [material.id] : [],
        action: approval ? method : "",
      });
      q.native = { sessionId, rpcId, method, params };
      recompute(s);
      return q.id;
    });
    this.pendingNative.add(requestId);
  }

  async decideNative(p: Record<string, any>, key: string) {
    const q = find(this.store.read().requests, p.requestId);
    const n = q.native!;
    const cached = this.store.cached(
      key,
      hash(JSON.stringify({ type: "request.decide", p })),
    );
    if (cached !== undefined) return cached;
    if (!this.pendingNative.has(q.id))
      fail(
        409,
        "RESULT_UNKNOWN",
        "Native request is not active on this connection; verify in the terminal",
      );
    const rpc = n.method.startsWith("pi/")
      ? this.pis.get(n.sessionId)
      : this.codex;
    if (!rpc || (rpc instanceof Codex && rpc.socket?.readyState !== 1))
      fail(
        409,
        "RESULT_UNKNOWN",
        "Native session is disconnected; verify before deciding",
      );
    let response: any;
    if (n.method === "item/tool/requestUserInput") {
      const questions = n.params.questions || [];
      let answers: any;
      if (questions.length === 1)
        answers = { [questions[0].id]: { answers: [p.answer] } };
      else {
        try {
          answers = JSON.parse(p.answer);
        } catch {
          fail(
            400,
            "INVALID_INPUT",
            "Answer each question as JSON keyed by question ID",
          );
        }
      }
      if (
        !answers ||
        typeof answers !== "object" ||
        questions.some(
          (question: any) =>
            !Array.isArray(answers[question.id]?.answers) ||
            answers[question.id].answers.length !== 1 ||
            typeof answers[question.id].answers[0] !== "string" ||
            !answers[question.id].answers[0].trim() ||
            (question.options?.length &&
              !question.isOther &&
              !question.options.some(
                (o: any) => o.label === answers[question.id].answers[0],
              )),
        )
      )
        fail(
          400,
          "INVALID_INPUT",
          "Provide one answer for every native question",
        );
      response = { answers };
    } else if (n.method.startsWith("pi/"))
      response = {
        type: "extension_ui_response",
        id: n.rpcId,
        ...(p.decision === "cancel"
          ? { cancelled: true }
          : n.method === "pi/confirm"
            ? { confirmed: p.decision === "approve" }
            : {
                value:
                  q.options?.find((o) => o.label === p.answer)?.value ||
                  p.answer,
              }),
      };
    else
      response = { decision: p.decision === "approve" ? "accept" : "decline" };
    const result = this.domain.action("request.decide", p, key);
    const saved = find(this.store.read().requests, p.requestId);
    if (["sent", "confirmed"].includes(saved.native?.delivery || ""))
      return result;
    try {
      if (n.method.startsWith("pi/")) {
        (rpc as Pi).child.stdin?.write(JSON.stringify(response) + "\n");
      } else rpc!.send({ id: n.rpcId, result: response });
      this.store.change((s) => {
        find(s.requests, q.id).native!.delivery = "sent";
      });
    } catch {
      this.store.change((s) => {
        find(s.requests, q.id).native!.delivery = "unknown";
      });
      fail(
        409,
        "RESULT_UNKNOWN",
        "Native decision delivery unknown; do not repeat tool execution",
      );
    }
    return result;
  }
  async recoverNative() {
    this.recovered = true;
    const sessions = this.store
      .read()
      .sessions.filter((x) => x.agentId === "codex" && x.threadId);
    if (!sessions.length) return;
    try {
      const c = await this.codexClient();
      for (const x of sessions) {
        try {
          await c.call("thread/resume", { threadId: x.threadId, cwd: x.path });
          const { thread } = await c.call("thread/read", {
            threadId: x.threadId,
            includeTurns: true,
          });
          const r = this.store
            .read()
            .runs.find(
              (r) =>
                r.sessionId === x.id &&
                r.status === "unknown" &&
                r.nativeTurnId,
            );
          if (r) {
            const turn = thread.turns.find((t: any) => t.id === r.nativeTurnId);
            if (turn?.status === "inProgress") {
              this.started(r.id, x.id, turn.id);
              this.armTimeout(r);
              this.running.set(r.id, {
                interrupt: () =>
                  c.call("turn/interrupt", {
                    threadId: x.threadId,
                    turnId: turn.id,
                  }),
              });
            } else if (turn) this.turnResult(r.id, turn);
          } else {
            const turn = thread.turns.find(
              (t: any) => t.status === "inProgress",
            );
            if (turn) this.externalTurn(x.id, turn.id);
            else
              this.store.change((s) => {
                Object.assign(find(s.sessions, x.id), {
                  busyTurnId: undefined,
                  status: "idle",
                });
                this.store.db
                  .prepare("DELETE FROM locks WHERE run_id=?")
                  .run("native:" + x.id);
              });
          }
        } catch {
          /* Missing rollout remains unknown; no replay or unlocking. */
        }
      }
    } catch {
      /* Local service unavailable: keep persistent unknown state. */
    }
  }
  complete(runId: string, success: boolean, output: string, stderr: string) {
    output = this.store.redact(output);
    stderr = this.store.redact(stderr);
    this.store.change((s) => {
      const r = find(s.runs, runId),
        t = find(s.tasks, r.taskId);
      if (!["starting", "running", "stopping"].includes(r.status)) {
        event(
          s,
          r.issueId,
          r.snapshot.agentName,
          "run.late",
          "Late result; current state preserved",
          { runId },
        );
        return;
      }
      const stopped = r.status === "stopping";
      r.status = stopped ? "stopped" : success ? "completed" : "failed";
      r.finishedAt = now();
      r.result = this.store.redact(output || stderr || "(No final output)");
      this.store.db.prepare("DELETE FROM locks WHERE run_id=?").run(r.id);
      event(
        s,
        r.issueId,
        r.snapshot.agentName,
        `run.${r.status}`,
        stderr || r.status,
        { runId, taskId: t.id, bindingId: r.bindingId },
      );
      if (find(s.issues, r.issueId).status === "Done") return;
      if (stopped || !success) {
        t.status = "waiting";
        t.reason =
          "Execution failed or stopped; inspect worktree before explicit retry";
        const a = find(s.agents, r.snapshot.agentId);
        if (/auth|login|unauthorized|api.?key/i.test(stderr)) {
          a.status = "authentication required";
          a.reason =
            "Execution authentication failed; authenticate the tool outside Relay";
        }
        this.human(s, t, `${t.reason}\n${stderr}`);
        recompute(s);
        return;
      }
      const report = parseReport(output);
      if (!report) {
        t.status = "done";
        artifact(s, {
          issueId: r.issueId,
          runId,
          bindingId: r.bindingId,
          kind: "report",
          title: "Agent output — needs verification",
          content: r.result,
        });
        makeRequest(s, {
          issueId: r.issueId,
          kind: "input",
          title: "Confirm remaining work",
          body: "Agent returned no structured handoff. Review the report and answer with any missing work. Use Stop and correct to submit a revised goal, then Resume automatic routing before final acceptance.",
          scope: "issue",
          source: "Triage",
        });
        recompute(s);
        return;
      }
      try {
        const staged = structuredClone(s);
        this.ingest(staged, find(staged.runs, r.id), report);
        Object.assign(s, staged);
      } catch (e) {
        t.status = "waiting";
        t.reason =
          "Execution failed: invalid structured handoff; verify output";
        artifact(s, {
          issueId: r.issueId,
          runId,
          bindingId: r.bindingId,
          kind: "report",
          title: "Invalid handoff — inspect output",
          content: r.result,
        });
        this.human(
          s,
          t,
          "Execution failed: " +
            (e instanceof Error ? e.message : "Invalid report"),
        );
      }
      recompute(s);
    });
  }
  ingest(s: State, r: Run, report: any) {
    const t = find(s.tasks, r.taskId);
    const artifacts = (report.artifacts || []).map((a: any) =>
      artifact(s, {
        issueId: r.issueId,
        runId: r.id,
        bindingId: r.bindingId,
        worktreeId: r.snapshot.worktreeId,
        kind: a.kind,
        title: a.title,
        supersedesId: a.supersedesId,
        content: this.store.redact(a.content),
      }),
    );
    t.status = "done";
    if (
      !artifacts.length &&
      !(report.tasks || []).length &&
      !(report.requests || []).length &&
      !report.answer
    ) {
      artifact(s, {
        issueId: r.issueId,
        runId: r.id,
        bindingId: r.bindingId,
        title: "Agent report — needs verification",
        kind: "report",
        content: r.result || report.summary,
      });
      makeRequest(s, {
        issueId: r.issueId,
        kind: "input",
        title: "Provide inspectable evidence",
        body: "The agent provided no concrete artifacts or verification evidence. Inspect the actual worktree and answer with the missing evidence or work. Use Stop and correct to submit a revised goal, then Resume automatic routing before final acceptance.",
        source: "Triage",
        scope: "issue",
      });
    }
    if (report.answer) {
      const q = find(s.requests, report.answer.requestId);
      if (
        q.kind !== "input" ||
        q.status !== "Pending" ||
        q.issueId !== r.issueId ||
        t.requestId !== q.id
      )
        fail(
          400,
          "INVALID_INPUT",
          "Agent cannot approve or answer an unrelated request",
        );
      q.status = "Answered";
      q.answer = this.store.redact(
        typeof report.answer.text === "string" && report.answer.text.trim()
          ? report.answer.text
          : fail(400, "INVALID_INPUT", "Agent answer cannot be empty"),
      );
      q.decidedBy = r.snapshot.agentName;
      q.decidedAt = now();
      q.revision++;
      event(
        s,
        r.issueId,
        r.snapshot.agentName,
        "request.answer",
        q.answer || "",
        { requestId: q.id, runId: r.id },
      );
      for (const n of s.notifications.filter((n) => n.requestId === q.id)) {
        n.read = true;
        n.archived = true;
      }
    }
    const requests: Request[] = (report.requests || []).map((q: any) => {
      if (!["input", "approval"].includes(q.kind))
        fail(400, "INVALID_INPUT", "Agents may not create final acceptance");
      const request = makeRequest(s, {
        issueId: r.issueId,
        taskId: t.id,
        kind: q.kind,
        title: q.title,
        body: q.body,
        options: q.options,
        artifactIds: (q.artifactIndexes || []).map(
          (n: number) =>
            artifacts[n]?.id ||
            fail(400, "INVALID_INPUT", "Missing referenced artifact"),
        ),
        scope: q.scope || [t.id],
        action: q.action || "",
        source: "Agent",
        recipient: q.kind === "input" && q.routeToAgent ? "Agent" : "Human",
        supersedesId: q.supersedesId,
      });
      if (q.kind === "input") {
        t.status = "waiting";
        t.dependencyIds.push(request.id);
        t.reason = "Waiting for clarification";
        if (q.routeToAgent) {
          task(
            s,
            r.issueId,
            `Answer request ${request.id}: ${q.title}\n${q.body}`,
            { requestId: request.id, sourceId: request.id },
          );
          s.notifications.find((n) => n.requestId === request.id)!.archived =
            true;
        }
      }
      return request;
    });
    for (const next of report.tasks || []) {
      const deps = [
        ...(next.dependencyIds || []),
        ...requests.filter((q) => q.kind === "approval").map((q) => q.id),
      ];
      if (next.bindingId) {
        const b = find(s.bindings, next.bindingId);
        if (b.issueId !== r.issueId || b.removed)
          fail(400, "INVALID_INPUT", "Invalid handoff binding");
      }
      if (
        deps.some(
          (k) =>
            ![...s.tasks, ...s.requests].some(
              (x) => x.id === k && x.issueId === r.issueId,
            ),
        )
      )
        fail(400, "INVALID_INPUT", "Invalid task dependencies");
      task(s, r.issueId, next.text, {
        bindingId: next.bindingId,
        dependencyIds: deps,
        sourceId: r.id,
      });
    }
    event(
      s,
      r.issueId,
      r.snapshot.agentName,
      "handoff",
      this.store.redact(report.summary),
      { runId: r.id, taskId: t.id },
    );
  }
  shutdown() {
    if (this.closing) return;
    for (const r of this.store
      .read()
      .runs.filter((r) =>
        ["starting", "running", "stopping"].includes(r.status),
      ))
      this.unknown(r.id, "Relay stopped; inspect native session before retry");
    this.closing = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.codex?.shutdown();
    for (const pi of this.pis.values()) pi.shutdown();
    this.pis.clear();
    this.running.clear();
  }
}
