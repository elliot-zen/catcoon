import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { Codex } from "./agents/codex.ts";
import { Pi } from "./agents/pi.ts";
import { Store, id, now, find, fail, hash } from "./store.ts";
import {
  Domain,
  event,
  recompute,
  artifact,
  makeRequest,
  dependencies,
  scopeFor,
} from "./domain.ts";
import { readDocument, dirty, approvalIds, assertApproved } from "./specs.ts";
import { agentContext } from "./context.ts";
import { validateWorktree, repository } from "./files.ts";
import { activeRun, sessions } from "./types.ts";
import type { State, Binding, Run, Session, Mode } from "./types.ts";
import { Streams } from "./streams.ts";
import { Triage } from "./triage.ts";
import { relayTools } from "./agents/tools.ts";
export class Runtime {
  store: Store;
  domain: Domain;
  streams: Streams;
  triage: Triage;
  running = new Map<string, { interrupt: () => Promise<any> }>();
  codex?: Codex;
  loadedThreads = new Set<string>();
  finalMessages = new Map<string, string>();
  nativeItems = new Map<string, any>();
  pendingNative = new Set<string>();
  pis = new Map<string, Pi>();
  timers = new Map<string, ReturnType<typeof setTimeout>>();
  nativeStarting = new Map<string, string>();
  recovered = false;
  closing = false;
  fetcher: typeof fetch;
  apiEndpoint = "";
  runTokens = new Map<string, string>();
  constructor(store: Store, fetcher: typeof fetch = fetch) {
    this.store = store;
    this.domain = new Domain(store);
    this.streams = new Streams(store);
    this.fetcher = fetcher;
    this.triage = new Triage(store, this, fetcher);
  }
  get inflight() {
    return this.triage.inflight;
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
    await this.triage.tick();
  }
  begin(taskId: string, bindingId: string, mode: Mode) {
    return this.store.change((s) => {
      const t = find(s.tasks, taskId),
        i = find(s.issues, t.issueId),
        b = find(s.bindings, bindingId),
        w = find(s.worktrees, b.worktreeId),
        p = find(s.projects, b.projectId),
        a = find(s.agents, b.agentId);
      if (
        !i.started ||
        i.control !== "enabled" ||
        i.status === "Done" ||
        b.issueId !== i.id ||
        b.removed ||
        !["pending", "waiting"].includes(t.status) ||
        !dependencies(s, t, b) ||
        s.runs.some((r) => r.issueId === i.id && activeRun(r))
      )
        return;
      validateWorktree(w, p);
      assertApproved(s, i.id, w, mode, t.id);
      if (a.status !== "available")
        fail(503, "AGENT_UNAVAILABLE", "Agent unavailable");
      if (this.store.db.prepare("SELECT * FROM locks WHERE path=?").get(w.path))
        fail(409, "WORKTREE_BUSY", "Worktree is locked by another execution");
      let x = i.sessions.find((x) => x.id === b.activeSessionId);
      if (!x) {
        x = this.createSession(s, b, w.path);
        b.activeSessionId = x.id;
      }
      if (x.busyTurnId || x.status === "unknown")
        fail(409, "WORKTREE_BUSY", "Native session is busy or unknown");
      const r: Run = {
        id: id(),
        issueId: i.id,
        origin: "platform",
        taskId: t.id,
        bindingId: b.id,
        sessionId: x.id,
        mode,
        status: "starting",
        stopRequested: false,
        startedAt: now(),
        snapshot: {
          ...b,
          path: w.path,
          branch: w.branch,
          projectName: p.name,
          agentName: a.name,
          command: a.command,
          targetRevision: i.targetRevision,
          worktreeRevision: w.revision,
          specId: w.specId,
          specVersionId: w.specVersionId,
          contentHash: find(s.specVersions, w.specVersionId).contentHash,
          approvalIds: approvalIds(s, i.id, w, mode, t.id),
        },
      };
      const payload = agentContext(this.store.redacted(s), t, b, r, mode),
        contextId = id();
      s.contextSnapshots.push({
        id: contextId,
        runId: r.id,
        payload,
        contentHash: hash(payload),
        createdAt: now(),
      });
      r.contextRef = contextId;
      this.store.db.prepare("INSERT INTO locks VALUES(?,?)").run(w.path, r.id);
      s.runs.push(r);
      t.status = "running";
      t.bindingId = b.id;
      t.attempts++;
      i.triage.phase = "running";
      event(s, i.id, "Triage", "run.scheduled", t.text, {
        runId: r.id,
        taskId: t.id,
        bindingId: b.id,
      });
      return r;
    });
  }
  createSession(s: State, b: Binding, path: string): Session {
    const i = find(s.issues, b.issueId),
      old = i.sessions.filter((x) => x.bindingId === b.id);
    const x: Session = {
      id: id(),
      bindingId: b.id,
      agentId: b.agentId,
      projectId: b.projectId,
      worktreeId: b.worktreeId,
      path,
      generation: old.length + 1,
      parentSessionId: old.at(-1)?.id,
      toolVersion: find(s.agents, b.agentId).version,
      status: "uninitialized",
      createdAt: now(),
    };
    if (b.agentId === "pi")
      x.sessionFile = join(resolve(this.store.dir), "pi", x.id + ".jsonl");
    i.sessions.push(x);
    b.activeSessionId = x.id;
    return x;
  }
  session(bindingId: string, agentId: string, path: string): Session {
    const s = this.store.read(),
      b = find(s.bindings, bindingId),
      i = find(s.issues, b.issueId);
    const old = i.sessions.find(
      (x) =>
        x.id === b.activeSessionId &&
        x.agentId === agentId &&
        x.path === path &&
        x.status !== "archived",
    );
    if (old) return old;
    return this.store.change((s) =>
      this.createSession(s, find(s.bindings, bindingId), path),
    );
  }
  runContext(r: Run) {
    return find(this.store.read().contextSnapshots, r.contextRef).payload;
  }
  handleTool(runId: string, tool: string, args: any, callId: string) {
    const r = find(this.store.read().runs, runId),
      w = find(this.store.read().worktrees, r.snapshot.worktreeId);
    if (tool === "relay_spec_read") {
      if (args.specId !== w.specId)
        fail(
          403,
          "SCOPE_REJECTED",
          "Only the assigned system Spec can be read",
        );
      return this.readSpec(args);
    }
    if (tool === "relay_report")
      return this.domain.report(
        runId,
        args,
        hash(r.sessionId + ":" + r.nativeTurnId + ":" + callId),
      );
    fail(400, "INVALID_INPUT", "Unknown Relay tool");
  }
  readSpec(args: any) {
    return readDocument(
      this.store.read(),
      args.specId,
      args.document,
      args.versionId,
    );
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
          sandbox: "read-only",
          dynamicTools: relayTools,
          approvalPolicy: "on-request",
          ephemeral: false,
        })
      ).thread;
      if (this.closing) throw new Error("Relay stopped");
      this.store.change((s) =>
        Object.assign(find(sessions(s), x.id), {
          threadId: thread.id,
          endpoint: c.endpoint,
          status: "idle",
        }),
      );
    }
    if (this.closing) throw new Error("Relay stopped");
    this.loadedThreads.add(thread.id);
    this.store.change((s) => {
      find(sessions(s), x.id).endpoint = c.endpoint;
    });
    const active = thread.turns?.find((t: any) => t.status === "inProgress");
    if (
      thread.status?.type === "active" ||
      active ||
      sessions(this.store.read()).find((a) => a.id === x.id)?.busyTurnId
    ) {
      if (active) this.externalTurn(x.id, active.id);
      fail(
        409,
        "WORKTREE_BUSY",
        "Worktree is busy / locked by native terminal session",
      );
    }
    return find(sessions(this.store.read()), x.id);
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
          input: [{ type: "text", text: this.runContext(r) }],
          sandboxPolicy: r.snapshot.approvalIds.length
            ? {
                type: "workspaceWrite",
                writableRoots: [r.snapshot.path],
                networkAccess: false,
                excludeTmpdirEnvVar: true,
                excludeSlashTmp: true,
              }
            : { type: "readOnly" },
          summary: "detailed",
        });
        this.started(r.id, x.id, turn.id, c.child?.pid);
        if (turn.status !== "inProgress") this.turnResult(r.id, turn);
      } finally {
        if (this.nativeStarting.get(ready.threadId!) === r.id)
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
      if (!/^1\./.test(x.toolVersion) && x.toolVersion !== "test")
        throw new Error(
          "Pi 1.0.0 RPC required; installed version: " + x.toolVersion,
        );
      const token = id();
      this.runTokens.set(r.id, token);
      const pi = new Pi(x.sessionFile!, x.path, {
        RELAY_API_URL: this.apiEndpoint,
        RELAY_RUN_ID: r.id,
        RELAY_RUN_TOKEN: token,
        RELAY_WRITE_APPROVED: r.snapshot.approvalIds.length ? "1" : "0",
        RELAY_WORKTREE: r.snapshot.path,
      });
      this.pis.set(x.id, pi);
      let final = "",
        stopReason = "",
        failure = "";
      pi.on("message", (m) => {
        if (this.closing) return;
        this.streams.pi(find(this.store.read().runs, r.id), m);
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
        }
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
        find(sessions(s), x.id).sessionFile =
          state.sessionFile || x.sessionFile;
        find(sessions(s), x.id).nativeSessionId = state.sessionId;
      });
      this.started(r.id, x.id, id(), pi.child.pid);
      this.running.set(r.id, { interrupt: () => pi.interrupt() });
      await pi.call("prompt", { message: this.runContext(r) });
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
      if (r.taskId) find(s.tasks, r.taskId).status = "running";
      Object.assign(find(sessions(s), sessionId), {
        busyTurnId: turnId,
        status: "busy",
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
  codexMessage(m: any) {
    const p = m.params || {},
      state = this.store.read(),
      x = sessions(state).find((x) => x.threadId === p.threadId);
    if (!x) return;
    const turnId = p.turnId || p.turn?.id;
    let r = state.runs.find(
      (r) => r.sessionId === x.id && r.nativeTurnId === turnId,
    );
    const starting = this.nativeStarting.get(p.threadId);
    if (!r && starting && turnId) {
      this.started(starting, x.id, turnId);
      r = find(this.store.read().runs, starting);
    }
    if (!r && turnId) {
      this.externalTurn(x.id, turnId);
      r = this.store
        .read()
        .runs.find((r) => r.sessionId === x.id && r.nativeTurnId === turnId);
    }
    if (m.id !== undefined && m.method) {
      if (m.method === "item/tool/call") {
        let result: any;
        try {
          if (!r)
            fail(
              409,
              "RESULT_UNKNOWN",
              "Tool call has no matching native turn",
            );
          const value = this.handleTool(r!.id, p.tool, p.arguments, p.callId);
          result = {
            success: true,
            contentItems: [{ type: "inputText", text: JSON.stringify(value) }],
          };
        } catch (e) {
          result = {
            success: false,
            contentItems: [
              { type: "inputText", text: this.store.redact(String(e)) },
            ],
          };
        }
        this.codex?.send({ id: m.id, result });
        return;
      }
      if (r) {
        const item = this.nativeItems.get(p.threadId + ":" + p.itemId);
        this.nativeRequest(
          r.id,
          x.id,
          m.id,
          m.method,
          item ? { ...p, proposedItem: item } : p,
        );
      }
      return;
    }
    if (m.method === "item/started")
      this.nativeItems.set(p.threadId + ":" + p.item.id, p.item);
    if (r && activeRun(r)) this.streams.codex(r, m);
    if (m.method === "turn/started") {
      if (r) this.started(r.id, x.id, p.turn.id);
    }
    if (m.method === "item/completed" && p.item.type === "agentMessage" && r)
      this.finalMessages.set(
        p.turnId,
        this.streams
          .items(r!.id)
          .filter((i) => i.kind === "answer")
          .map((i) => i.content)
          .join("\n"),
      );
    if (m.method === "turn/completed" && r && activeRun(r))
      this.turnResult(r.id, p.turn);
    if (m.method === "serverRequest/resolved")
      this.store.change((s) => {
        for (const q of s.requests.filter(
          (q) => q.native?.sessionId === x.id && q.native.rpcId === p.requestId,
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
  externalTurn(sessionId: string, turnId: string) {
    return this.store.change((s) => {
      const x = find(sessions(s), sessionId),
        b = find(s.bindings, x.bindingId),
        i = find(s.issues, b.issueId);
      if (s.runs.some((r) => r.sessionId === x.id && r.nativeTurnId === turnId))
        return;
      const w = find(s.worktrees, b.worktreeId),
        a = find(s.agents, b.agentId),
        p = find(s.projects, b.projectId);
      const r: Run = {
        id: id(),
        issueId: i.id,
        origin: "terminal",
        bindingId: b.id,
        sessionId: x.id,
        nativeTurnId: turnId,
        status: "running",
        stopRequested: false,
        startedAt: now(),
        snapshot: {
          ...b,
          path: w.path,
          branch: w.branch,
          projectName: p.name,
          agentName: a.name,
          command: a.command,
          targetRevision: i.targetRevision,
          worktreeRevision: w.revision,
          specId: w.specId,
          specVersionId: w.specVersionId,
          contentHash: find(s.specVersions, w.specVersionId).contentHash,
          approvalIds: [],
        },
      };
      x.busyTurnId = turnId;
      x.status = "busy";
      s.runs.push(r);
      this.store.db
        .prepare("INSERT OR IGNORE INTO locks VALUES(?,?)")
        .run(x.path, r.id);
      event(
        s,
        i.id,
        "Terminal",
        "run.started",
        "Native terminal turn " + turnId,
        { runId: r.id, bindingId: b.id },
      );
      return r;
    });
  }

  turnResult(runId: string, turn: any) {
    const r = find(this.store.read().runs, runId);
    if (!activeRun(r)) return;
    for (const item of turn.items || [])
      this.streams.codex(r, {
        method: "item/completed",
        params: { item, turnId: turn.id },
      });
    if (r.status === "unknown")
      this.store.change((s) => {
        find(s.runs, runId).status = r.stopRequested ? "stopping" : "running";
      });
    this.nativeFinished(runId, r.sessionId!);
    const text =
      (turn.items || [])
        .filter((i: any) => i.type === "agentMessage")
        .map((i: any) => i.text)
        .join("\n") ||
      this.finalMessages.get(turn.id) ||
      this.streams
        .items(r.id)
        .filter((i) => i.kind === "answer")
        .map((i) => i.content)
        .join("\n");
    if (turn.status === "interrupted")
      this.store.change((s) => {
        find(s.runs, runId).status = "stopping";
      });
    this.finalMessages.delete(turn.id);
    for (const item of turn.items || [])
      this.nativeItems.delete(
        (find(sessions(this.store.read()), r.sessionId!).threadId || "") +
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
      const x = find(sessions(s), sessionId);
      x.busyTurnId = undefined;
      x.status = "idle";
      for (const q of s.requests.filter(
        (q) =>
          q.native?.sessionId === sessionId &&
          q.runId === runId &&
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
      if (r.taskId) find(s.tasks, r.taskId).status = "unknown";
      if (r.sessionId) find(sessions(s), r.sessionId).status = "unknown";
      if (
        !s.requests.some(
          (q) =>
            q.runId === r.id &&
            q.inputClass === "recovery" &&
            q.status === "Pending",
        )
      )
        makeRequest(s, {
          issueId: r.issueId,
          runId: r.id,
          taskId: r.taskId,
          kind: "input",
          inputClass: "recovery",
          title: "Verify unknown execution",
          body: reason,
          source: "System",
          scope: r.taskId ? scopeFor(r.taskId) : "issue",
        });
      dirty(s, r.issueId, "run.unknown");
      recompute(s);
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
          q.runId === r.id &&
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
        runId: r.id,
        inputClass: "native",
        scope: r.taskId
          ? scopeFor(r.taskId)
          : { taskIds: [], bindingIds: [r.bindingId], worktreeIds: [] },
        options:
          method === "pi/select"
            ? params.options.map((value: string) => ({ value, label: value }))
            : undefined,
        artifactIds: approval ? [material.id] : [],
        action: approval ? { type: "native", method } : undefined,
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
    const run = this.store.read().runs.find((r) => r.id === q.runId);
    if (
      p.decision === "approve" &&
      run?.origin === "platform" &&
      n.method.endsWith("requestApproval") &&
      !run.snapshot.approvalIds.length
    )
      fail(
        409,
        "APPROVAL_REQUIRED",
        "Approve the fixed Spec and implementation scope before authorizing a write-capable native tool",
      );
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
    const codexSessions = sessions(this.store.read()).filter(
      (x) => x.agentId === "codex" && x.threadId,
    );
    if (!codexSessions.length) return;
    try {
      const c = await this.codexClient();
      for (const x of codexSessions) {
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
                Object.assign(find(sessions(s), x.id), {
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
    this.store.change((s) => {
      const r = find(s.runs, runId),
        i = find(s.issues, r.issueId);
      if (!activeRun(r) || r.ingestedAt) return;
      const stopped = r.stopRequested || r.status === "stopping";
      r.status = stopped ? "stopped" : success ? "completed" : "failed";
      r.finishedAt = now();
      r.ingestedAt = now();
      r.result = this.store.redact(output || stderr || "(No final answer)");
      r.reason = stderr ? this.store.redact(stderr) : undefined;
      const x = find(i.sessions, r.sessionId);
      x.busyTurnId = undefined;
      x.status = "idle";
      for (const q of s.requests.filter(
        (q) =>
          q.runId === r.id &&
          q.inputClass === "recovery" &&
          q.status === "Pending",
      )) {
        q.status = "Resolved";
        q.resolutionEvidence = "Native terminal outcome observed: " + r.status;
        q.revision++;
      }
      this.store.db.prepare("DELETE FROM locks WHERE run_id=?").run(r.id);
      for (const q of s.requests.filter(
        (q) => q.runId === r.id && q.native && q.status === "Pending",
      )) {
        q.status = "Cancelled";
        q.revision++;
      }
      event(
        s,
        i.id,
        r.origin === "terminal" ? "Terminal" : r.snapshot.agentName,
        "run." + r.status,
        r.reason || r.status,
        { runId: r.id, taskId: r.taskId, bindingId: r.bindingId },
      );
      if (r.origin === "platform") {
        const t = find(s.tasks, r.taskId);
        if (t.status !== "done") t.status = "pending";
        t.waitReason = undefined;
        const result = artifact(s, {
          issueId: i.id,
          runId: r.id,
          bindingId: r.bindingId,
          kind: "report",
          title: r.snapshot.agentName + " result",
          content: r.result,
          provenance: r.snapshot.agentName,
        });
        r.resultArtifactId = result.id;
        const tools = this.streams
          .items(r.id)
          .filter((item) => item.kind === "tool");
        if (tools.length)
          artifact(s, {
            issueId: i.id,
            runId: r.id,
            bindingId: r.bindingId,
            kind: "report",
            title: "Observed tool results",
            content: JSON.stringify(
              tools.map((item) => ({
                content: item.content,
                status: item.status,
                ...item.metadata,
              })),
              null,
              2,
            ),
            provenance: "Native tool observation",
          });
        const materialHashes = [
          ...new Set(
            s.artifacts.filter((a) => a.issueId === i.id).map((a) => a.version),
          ),
        ].sort();
        r.progressHash = hash(
          JSON.stringify([
            i.targetRevision,
            r.snapshot.specVersionId,
            r.mode,
            r.result,
            materialHashes,
            s.requests
              .filter((q) => q.issueId === i.id)
              .map((q) => [q.id, q.status]),
          ]),
        );
        if (
          !success &&
          !stopped &&
          /auth|login|unauthorized|api.?key/i.test(stderr)
        ) {
          const a = find(s.agents, r.snapshot.agentId);
          a.status = "authentication required";
          a.reason = "Authenticate the native tool outside Relay";
        }
        if (
          i.control === "stopping" &&
          !s.runs.some((other) => other.issueId === i.id && activeRun(other))
        )
          i.control = "paused";
        dirty(s, i.id, "run." + r.status);
      }
      recompute(s);
    });
  }
  shutdown() {
    if (this.closing) return;
    for (const r of this.store
      .read()
      .runs.filter((r) =>
        ["starting", "running", "stopping"].includes(r.status),
      ))
      this.unknown(r.id, "Relay stopped; verify native execution");
    this.closing = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.codex?.shutdown();
    for (const pi of this.pis.values()) pi.shutdown();
    this.pis.clear();
    this.running.clear();
  }
}
