import { spawn, execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { Store, id, now, find, fail } from "./store.ts";
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
import type { State, Task, Binding, Run, Request } from "./types.ts";
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
  running = new Map<string, ChildProcess>();
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
    for (const [runId, child] of this.running) {
      const r = this.store.read().runs.find((x) => x.id === runId);
      if (r?.status === "stopping" && !child.killed) {
        try {
          process.kill(-child.pid!, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        setTimeout(() => {
          if (this.running.has(runId)) {
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
        }, 5000).unref();
      }
    }
    const s = this.store.read();
    for (const i of s.issues) {
      if (
        !i.started ||
        i.paused ||
        i.status === "Done" ||
        this.inflight.has(i.id) ||
        s.runs.some((r) => r.issueId === i.id && activeRun(r))
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
      const context = this.context(s, t, b);
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
        s.runs.some((r) => r.issueId === i.id && activeRun(r))
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
  launch(r: Run) {
    const args =
      r.snapshot.command === "codex"
        ? [
            "exec",
            "--json",
            "--sandbox",
            "workspace-write",
            "-C",
            r.snapshot.path,
            "-",
          ]
        : ["--mode", "json", "--print", "--no-session", "--", r.context];
    const env = { ...process.env };
    delete env.TYPESAFE_API_KEY;
    const child = spawn(r.snapshot.command, args, {
      cwd: r.snapshot.path,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.running.set(r.id, child);
    let buffer = "",
      final = "",
      stderr = "",
      failed = false;
    const timeout = setTimeout(() => {
      this.store.change((s) => {
        const run = find(s.runs, r.id);
        if (["starting", "running"].includes(run.status)) {
          run.status = "stopping";
          run.reason = "30 minute execution limit";
          event(s, r.issueId, "System", "run.timeout", run.reason, {
            runId: r.id,
          });
        }
      });
      void this.tick();
    }, 30 * 60000);
    timeout.unref();
    child.on("spawn", () =>
      this.store.change((s) => {
        const run = find(s.runs, r.id);
        run.pid = child.pid;
        if (run.status !== "stopping") run.status = "running";
        event(
          s,
          r.issueId,
          r.snapshot.agentName,
          "run.started",
          `${r.snapshot.projectName} · ${r.snapshot.path}`,
          { runId: r.id, taskId: r.taskId, bindingId: r.bindingId },
        );
      }),
    );
    if (r.snapshot.command === "codex") child.stdin?.end(r.context);
    else child.stdin?.end();
    const line = (raw: string) => {
      if (!raw.trim()) return;
      try {
        const x = JSON.parse(raw);
        if (
          /reasoning|thinking|delta/.test(x.type || "") ||
          ["message_update", "message_start"].includes(x.type)
        )
          return;
        const item = x.item || x.message || x;
        const kind = item.type || x.type || "event";
        if (/reasoning|thinking/.test(kind)) return;
        if (item.type === "agent_message") final = item.text || final;
        if (x.type === "message_end" && x.message?.role === "assistant") {
          const content = x.message.content || [];
          final =
            content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("\n") || final;
        }
        if (x.type === "turn.failed" || x.type === "error") failed = true;
        const reportedAt = x.timestamp || x.at;
        const at =
          reportedAt && !Number.isNaN(new Date(reportedAt).getTime())
            ? new Date(reportedAt).toISOString()
            : now();
        const clean = this.store.redact(
          JSON.stringify(x, (key, value) =>
            key === "reasoning" ||
            key === "thinking" ||
            (value &&
              typeof value === "object" &&
              /thinking|reasoning/.test(value.type))
              ? undefined
              : value,
          ),
        );
        this.store.change((s) => {
          event(
            s,
            r.issueId,
            r.snapshot.agentName,
            "step",
            item.command || item.name || kind,
            {
              at,
              runId: r.id,
              taskId: r.taskId,
              bindingId: r.bindingId,
              data: {
                type: kind,
                status: item.status || x.type,
                exitCode: item.exit_code,
                output:
                  clean.length > 64000
                    ? clean.slice(0, 64000) +
                      "\n[Truncated: observable event exceeded 64KB; consult native tool output.]"
                    : clean,
              },
            },
          );
        });
      } catch {
        this.store.change((s) => {
          event(
            s,
            r.issueId,
            r.snapshot.agentName,
            "output",
            this.store.redact(raw).slice(0, 64000) +
              (raw.length > 64000
                ? "\n[Truncated: observable output exceeded 64KB.]"
                : ""),
            { runId: r.id },
          );
        });
      }
    };
    child.stdout?.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (buffer.length > 1e6) {
        line(buffer.slice(0, 64000));
        buffer = "";
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderr = this.store.redact((stderr + chunk.toString()).slice(-64000));
    });
    child.on("error", (e) => {
      stderr = this.store.redact(e.message);
      failed = true;
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      this.running.delete(r.id);
      if (buffer) line(buffer);
      this.complete(r.id, code === 0 && !failed, final, stderr);
    });
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
    this.closing = true;
    for (const c of this.running.values()) {
      try {
        process.kill(-c.pid!, "SIGTERM");
      } catch {
        c.kill();
      }
    }
  }
}
