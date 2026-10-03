import { Store, id, now, find, hash, fail, AppError } from "./store.ts";
import { dirty, approvalIds } from "./specs.ts";
import {
  dependencies,
  makeRequest,
  recompute,
  createFinal,
  artifact,
  scopeFor,
  task,
} from "./domain.ts";
import { jevContext, limited } from "./context.ts";
import { evaluate, questionsFor } from "./jev.ts";
import { activeRun } from "./types.ts";
import type { Issue, State, Task, Mode } from "./types.ts";
import type { Runtime } from "./runtime.ts";
export class Triage {
  store: Store;
  runtime: Runtime;
  fetcher: typeof fetch;
  inflight = new Set<string>();
  constructor(store: Store, runtime: Runtime, fetcher: typeof fetch) {
    this.store = store;
    this.runtime = runtime;
    this.fetcher = fetcher;
  }
  waitKey(s: State, i: Issue) {
    const paths = new Set(
      s.bindings
        .filter((b) => b.issueId === i.id && !b.removed)
        .map((b) => find(s.worktrees, b.worktreeId).path),
    );
    return hash(
      JSON.stringify({
        target: i.targetRevision,
        bindings: s.bindings
          .filter((b) => b.issueId === i.id && !b.removed)
          .map((b) => ({
            ...b,
            worktree: find(s.worktrees, b.worktreeId),
            agent: find(s.agents, b.agentId).status,
            health: find(s.projects, b.projectId).healthReason,
          })),
        keyConfigured: !!this.store.key(),
        requests: s.requests
          .filter((q) => q.issueId === i.id)
          .map((q) => [q.id, q.status, q.revision]),
        sessions: i.sessions.map((x) => [x.id, x.status, x.busyTurnId]),
        locks: this.store.db
          .prepare("SELECT * FROM locks ORDER BY path")
          .all()
          .filter((row: any) => paths.has(row.path)),
      }),
    );
  }
  human(
    s: State,
    t: Task,
    message: string,
    inputClass: "business" | "configuration" | "recovery" = "business",
    conditionKey?: string,
    route = false,
  ) {
    let q = s.requests.find(
      (q) =>
        q.issueId === t.issueId &&
        q.status === "Pending" &&
        (q.taskId === t.id ||
          (conditionKey && q.conditionKey === conditionKey)),
    );
    if (t.requestId) {
      q = find(s.requests, t.requestId);
      q.recipient = "Human";
      for (const n of s.notifications.filter((n) => n.requestId === q!.id)) {
        n.archived = false;
        n.read = false;
      }
    }
    if (!q)
      q = makeRequest(s, {
        issueId: t.issueId,
        taskId: t.id,
        kind: "input",
        title: route ? "Choose a binding for this work" : "Input needed",
        body: t.text + "\n\n" + message,
        inputClass,
        conditionKey,
        source: "Triage",
        scope: scopeFor(t.id),
        routeTask: route,
        options: route
          ? s.bindings
              .filter((b) => b.issueId === t.issueId && !b.removed)
              .map((b) => ({
                value: b.id,
                label:
                  find(s.agents, b.agentId).name +
                  " · " +
                  find(s.projects, b.projectId).name +
                  " · " +
                  find(s.worktrees, b.worktreeId).branch +
                  " · " +
                  b.description,
              }))
          : undefined,
      });
    t.status = "waiting";
    t.waitReason = {
      code: conditionKey || inputClass,
      conditionKey,
      requestIds: [q.id],
      runIds: [],
      message,
      recoverable: inputClass !== "business",
    };
    return q;
  }
  candidates(s: State, i: Issue, t: Task) {
    return s.bindings.filter(
      (b) => b.issueId === i.id && !b.removed && dependencies(s, t, b),
    );
  }
  async tick() {
    let s = this.store.read();
    for (const i of s.issues) {
      if (
        !i.started ||
        i.status === "Done" ||
        i.control !== "enabled" ||
        this.inflight.has(i.id) ||
        s.runs.some((r) => r.issueId === i.id && activeRun(r)) ||
        i.sessions.some((x) => x.busyTurnId || x.status === "unknown")
      )
        continue;
      const key = this.waitKey(s, i);
      if (!i.triage.dirty && i.triage.waitingKey !== key)
        this.store.change((state) =>
          dirty(state, i.id, "wait.condition.changed"),
        );
      if (!find(this.store.read().issues, i.id).triage.dirty) continue;
      this.inflight.add(i.id);
      void this.decide(i.id)
        .catch(() => {})
        .finally(() => this.inflight.delete(i.id));
    }
  }
  async decide(issueId: string) {
    let s = this.store.read(),
      i = find(s.issues, issueId);
    const last = s.runs.findLast(
      (r) => r.issueId === issueId && r.origin === "platform" && r.ingestedAt,
    );
    let t =
      s.tasks.find(
        (x) =>
          x.issueId === issueId &&
          ["pending", "waiting"].includes(x.status) &&
          x.kind !== "goal" &&
          dependencies(s, x),
      ) ||
      s.tasks.find(
        (x) =>
          x.issueId === issueId &&
          x.kind === "goal" &&
          ["pending", "waiting"].includes(x.status),
      );
    if (!t) return this.wait(issueId);
    try {
      this.store.change((state) => {
        for (const q of state.requests.filter(
          (q) =>
            q.issueId === issueId &&
            q.status === "Pending" &&
            q.inputClass === "configuration",
        )) {
          const bs = state.bindings.filter(
            (b) => b.issueId === issueId && !b.removed,
          );
          const resolved =
            q.conditionKey === "binding.missing"
              ? !!bs.length
              : q.conditionKey === "jev.key"
                ? !!this.store.key()
                : q.conditionKey === "agent.unavailable"
                  ? bs.some(
                      (b) =>
                        find(state.agents, b.agentId).status === "available",
                    )
                  : false;
          if (resolved) {
            q.status = "Resolved";
            q.resolutionEvidence = "Actual configuration condition restored";
            q.revision++;
            const work = state.tasks.find((x) => x.id === q.taskId);
            if (work) {
              work.status = "pending";
              work.waitReason = undefined;
            }
            dirty(state, issueId, "configuration.restored");
          }
        }
        recompute(state);
      });
      s = this.store.read();
      i = find(s.issues, issueId);
      t = find(s.tasks, t.id);
      const bs = this.candidates(s, i, t);
      if (!s.bindings.some((b) => b.issueId === i.id && !b.removed))
        return this.block(
          t,
          "Add a valid Agent binding.",
          "configuration",
          "binding.missing",
        );
      if (!bs.length) return this.wait(issueId);
      if (!this.store.key())
        return this.block(
          t,
          "Save a Jev API key in Settings.",
          "configuration",
          "jev.key",
        );
      if (!bs.some((b) => find(s.agents, b.agentId).status === "available"))
        return this.block(
          t,
          "Authenticate or restore the execution Agent.",
          "configuration",
          "agent.unavailable",
        );
      const windowRuns =
        s.runs.filter((r) => r.issueId === i.id && r.origin === "platform")
          .length - i.runBudgetStart;
      if (windowRuns >= 64 || t.attempts >= 8)
        return this.block(
          t,
          "Execution budget reached. Inspect actual progress, adjust scope and Resume.",
          "recovery",
          "run.budget",
        );
      const lastDecision =
        s.requests
          .filter((q) => q.issueId === i.id && q.decidedAt)
          .map((q) => q.decidedAt!)
          .sort()
          .at(-1) || "";
      const history = s.runs
        .filter((r) => r.issueId === i.id && r.origin === "platform")
        .slice(i.runBudgetStart)
        .filter((r) => r.progressHash && (r.finishedAt || "") > lastDecision)
        .slice(-3);
      if (
        history.length === 3 &&
        history.every((r) => r.progressHash === history[0].progressHash) &&
        history[2].snapshot.targetRevision === i.targetRevision
      )
        return this.block(
          t,
          "Three runs produced no new inspectable progress. Clarify the goal or required evidence.",
          "business",
          "run.no-progress",
        );
      const evaluationId = id();
      const input = jevContext(this.store.redacted(s), i.id, evaluationId);
      input.nextWorkItem = t;
      input.recentRuns = input.recentRuns.map((x) => ({
        ...x,
        toolResults: this.runtime.streams
          .items(x.runId)
          .filter((item) => item.kind === "tool")
          .map((item) =>
            item.metadata.type === "dynamicToolCall"
              ? {
                  title: item.metadata.title,
                  status: item.status,
                  systemToolResult:
                    "Validated results are in Specs, artifacts and requests",
                }
              : {
                  title: item.metadata.title,
                  status: item.status,
                  parameters: item.metadata.parameters,
                  content: item.content,
                  exitCode: item.metadata.exitCode,
                  truncated: item.metadata.truncated,
                },
          ),
      }));
      limited(input);
      if (
        Buffer.byteLength(
          JSON.stringify({ state: input, questions: questionsFor(input) }),
        ) >
        64 * 1024
      )
        fail(
          400,
          "MATERIAL_UNREADABLE",
          "Jev decision context exceeds 64KB; provide scoped evidence. Required original material was not truncated.",
        );
      const questions = questionsFor(input),
        token = i.triage.evaluationRevision;
      this.store.change((state) => {
        const current = find(state.issues, i.id);
        current.triage.phase = "evaluating";
        state.evaluations.push({
          id: evaluationId,
          issueId: i.id,
          evaluationRevision: token,
          triggerIds: [...current.triage.triggerIds],
          snapshotHash: hash(JSON.stringify(input)),
          input,
          status: "evaluating",
          createdAt: now(),
        });
      });
      const response = await evaluate(
        this.store.key(),
        input,
        questions,
        this.fetcher,
      );
      let dispatch:
        | { taskId: string; bindingId: string; mode: Mode; token: number }
        | undefined;
      this.store.change((state) => {
        const current = find(state.issues, i.id),
          ev = find(state.evaluations, evaluationId);
        ev.answer = response.answers;
        ev.model = response.model;
        ev.usage = response.usage;
        if (
          current.triage.evaluationRevision !== token ||
          current.control !== "enabled" ||
          current.status === "Done"
        ) {
          ev.status = "discarded";
          current.triage.dirty = true;
          return;
        }
        ev.status = "applied";
        for (const q of state.requests.filter(
          (q) =>
            q.issueId === i.id &&
            q.status === "Pending" &&
            q.inputClass === "configuration" &&
            q.conditionKey?.startsWith("JEV"),
        )) {
          q.status = "Resolved";
          q.resolutionEvidence = "A valid Jev evaluation succeeded";
          q.revision++;
        }
        current.triage.dirty = false;
        current.triage.triggerIds = [];
        current.triage.phase = "waiting";
        const answers = response.answers,
          a = answers.next_action;
        if (input.currentWorkItem && answers.work_item_complete?.noul >= 0.5) {
          const work = find(state.tasks, input.currentWorkItem.id);
          const linked = work.requestId
            ? state.requests.some(
                (q) => q.id === work.requestId && q.status === "Answered",
              )
            : true;
          if (linked && last?.resultArtifactId) {
            work.status = "done";
            work.waitReason = undefined;
            const previous = state.requests.find(
              (q) =>
                q.id === work.sourceId &&
                q.kind === "final" &&
                q.status === "Changes requested",
            );
            if (previous) previous.status = "Superseded";
          }
        }
        const pending = find(state.tasks, t!.id);
        if (a.confidence < 0.65 && a.choice !== "final") {
          this.human(
            state,
            pending,
            "Jev next_action=" +
              a.choice +
              " has insufficient confidence (" +
              a.confidence +
              "). Review the current goal and actual evidence; clarify what remains or provide independent verification.",
            "business",
            undefined,
            false,
          );
          return;
        }
        if (a.choice === "final") {
          if (answers.goal_complete.noul < 0.5) {
            if (
              bs.some(
                (b) => find(state.agents, b.agentId).status === "available",
              )
            ) {
              if (
                !state.tasks.some(
                  (t) =>
                    t.issueId === i.id &&
                    t.kind !== "goal" &&
                    !["done", "cancelled"].includes(t.status),
                )
              )
                task(
                  state,
                  i.id,
                  "Independently verify the delivered behavior against the current goal and fixed Spec. Publish actual verification results and requirement coverage. Fix any proven gap only within the supplied Human approval. Do not claim tests that were not executed.",
                  { kind: "followup", sourceId: ev.id },
                );
              dirty(state, i.id, "goal.verification.required");
            } else
              this.human(
                state,
                pending,
                "The goal is not covered by sufficient evidence.",
              );
            return;
          }
          try {
            createFinal(state, i.id);
          } catch (e) {
            this.human(
              state,
              pending,
              e instanceof Error
                ? e.message
                : "Final prerequisites not satisfied",
            );
          }
          return;
        }
        if (a.choice === "human") {
          this.human(
            state,
            pending,
            "Review the latest result and clarify the remaining goal.",
            "business",
            undefined,
            true,
          );
          return;
        }
        if (a.choice === "wait") {
          current.triage.waitingKey = this.waitKey(state, current);
          pending.status = "waiting";
          pending.waitReason = {
            code: "DEPENDENCY_BLOCKED",
            requestIds: state.requests
              .filter((q) => q.issueId === i.id && q.status === "Pending")
              .map((q) => q.id),
            runIds: [],
            message: "Waiting for a known dependency or environment condition",
            recoverable: true,
          };
          if (
            !pending.waitReason.requestIds.length &&
            !state.bindings.some(
              (b) =>
                b.issueId === i.id &&
                find(state.agents, b.agentId).status !== "available",
            )
          )
            this.human(
              state,
              pending,
              "No concrete waiting condition was identified. Inspect the latest result.",
            );
          return;
        }
        const mode = answers.dispatch_mode,
          route = answers.route;
        if (
          a.choice !== "dispatch" ||
          mode.choice === "none" ||
          mode.confidence < 0.65 ||
          route.confidence < 0.65 ||
          route.choice === "human"
        ) {
          this.human(
            state,
            pending,
            "Dispatch type or binding is unclear.",
            "business",
            undefined,
            true,
          );
          return;
        }
        const b = find(state.bindings, route.choice);
        if (b.issueId !== i.id || b.removed || !dependencies(state, pending, b))
          return;
        let actualMode = mode.choice as Mode;
        const revisionSource = state.requests.find(
          (q) => q.id === pending.sourceId,
        );
        if (
          pending.kind === "revision" &&
          revisionSource?.action &&
          ["approve_spec", "approve_spec_and_upgrade"].includes(
            revisionSource.action.type,
          )
        )
          actualMode = "spec";
        const w = find(state.worktrees, b.worktreeId);
        if (
          ["implement", "verify", "revise"].includes(actualMode) &&
          !approvalIds(state, i.id, w, actualMode, pending.id).length
        ) {
          const v = find(state.specVersions, w.specVersionId);
          if (!v.product.trim() || !v.tech.trim()) {
            this.human(
              state,
              pending,
              "The fixed Spec is empty. Plan a readable specification first.",
            );
            return;
          }
          const material = artifact(state, {
            issueId: i.id,
            kind: "spec",
            title: find(state.specs, w.specId).name + " V" + v.number,
            content: "# PRODUCT\n" + v.product + "\n\n# TECH\n" + v.tech,
            specVersionId: v.id,
            provenance: "System",
          });
          makeRequest(state, {
            issueId: i.id,
            taskId: pending.id,
            kind: "approval",
            title: "Approve fixed Spec V" + v.number,
            body: "Authorize implementation for " + w.name + " · " + w.path,
            artifactIds: [material.id],
            scope: { taskIds: [], bindingIds: [], worktreeIds: [w.id] },
            action: {
              type: "approve_spec",
              specVersionId: v.id,
              worktreeIds: [w.id],
              allowedModes: ["implement", "verify", "revise"],
            },
          });
          return;
        }
        dispatch = {
          taskId:
            pending.status === "done"
              ? state.tasks.find(
                  (x) =>
                    x.issueId === i.id &&
                    x.kind === "goal" &&
                    x.status !== "done",
                )?.id || pending.id
              : pending.id,
          bindingId: b.id,
          mode: actualMode,
          token,
        };
      });
      if (dispatch) {
        const { taskId, bindingId, mode } = dispatch;
        let b = find(this.store.read().bindings, bindingId);
        if (b.agentId === "codex")
          await this.runtime.prepareCodex(
            b.id,
            find(this.store.read().worktrees, b.worktreeId).path,
          );
        if (
          find(this.store.read().issues, i.id).triage.evaluationRevision !==
          dispatch.token
        )
          return this.store.change((state) =>
            dirty(state, i.id, "dispatch.revalidate"),
          );
        const r = this.runtime.begin(taskId, b.id, mode);
        if (r) this.runtime.launch(r);
      }
      if (
        find(this.store.read().evaluations, evaluationId).status ===
          "discarded" ||
        find(this.store.read().issues, issueId).triage.evaluationRevision !==
          token
      )
        return;
      this.wait(issueId);
    } catch (e) {
      const message = this.store.redact(
          e instanceof Error ? e.message : String(e),
        ),
        code = e instanceof AppError ? e.code : "JEV_UNAVAILABLE";
      this.store.change((state) => {
        for (const ev of state.evaluations.filter(
          (ev) => ev.issueId === issueId && ev.status === "evaluating",
        )) {
          ev.status = "failed";
          ev.reason = message;
          if (
            e instanceof AppError &&
            e.code === "JEV_INVALID_RESPONSE" &&
            e.details
          ) {
            const response = this.store.redacted(e.details as any);
            ev.answer = response.rawAnswer;
            ev.model = response.model;
            ev.usage = response.usage;
          }
        }
      });
      if (code === "WORKTREE_BUSY") return this.wait(issueId);
      this.block(
        t,
        message,
        code.startsWith("JEV") ? "configuration" : "business",
        code,
      );
    }
  }
  wait(issueId: string) {
    this.store.change((s) => {
      const i = find(s.issues, issueId);
      i.triage.dirty = false;
      i.triage.phase = s.runs.some((r) => r.issueId === i.id && activeRun(r))
        ? "running"
        : "waiting";
      i.triage.waitingKey = this.waitKey(s, i);
      recompute(s);
    });
  }
  block(
    t: Task,
    message: string,
    kind: "business" | "configuration" | "recovery",
    conditionKey?: string,
  ) {
    this.store.change((s) => {
      this.human(s, find(s.tasks, t.id), message, kind, conditionKey);
      recompute(s);
    });
    this.wait(t.issueId);
  }
}
