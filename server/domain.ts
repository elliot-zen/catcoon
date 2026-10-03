import { Store, id, now, hash, find, text, fail } from "./store.ts";
import { repository, validateWorktree } from "./files.ts";
import { activeRun } from "./types.ts";
import type {
  State,
  Issue,
  Task,
  Request,
  Binding,
  Artifact,
  Event,
  Scope,
  ApprovalAction,
} from "./types.ts";
import {
  createSpec,
  specReference,
  publishVersion,
  bodyText,
  dirty,
  approveSpec,
  approvalIds,
} from "./specs.ts";

export function event(
  s: State,
  issueId: string,
  source: string,
  type: string,
  message: string,
  extra: Partial<Event> = {},
) {
  const e: Event = {
    id: id(),
    issueId,
    source,
    type,
    text: message,
    at: now(),
    receivedAt: now(),
    ...extra,
  };
  s.events.push(e);
  if (!["output", "heartbeat", "step"].includes(type)) {
    const i = find(s.issues, issueId);
    i.updatedAt = now();
    i.revision++;
  }
  return e;
}
export function recompute(s: State) {
  for (const i of s.issues)
    if (i.status !== "Done")
      i.status = !i.started
        ? "Todo"
        : s.requests.some(
              (q) =>
                q.issueId === i.id &&
                q.status === "Pending" &&
                q.recipient === "Human",
            )
          ? "Human input"
          : "In progress";
}
export function scopeFor(taskId: string): Scope {
  return { taskIds: [taskId], bindingIds: [], worktreeIds: [] };
}
export function applies(q: Request, t?: Task, b?: Binding) {
  return (
    q.scope === "issue" ||
    (!!t && q.scope.taskIds.includes(t.id)) ||
    (!!b &&
      (q.scope.bindingIds.includes(b.id) ||
        q.scope.worktreeIds.includes(b.worktreeId)))
  );
}
export function task(
  s: State,
  issueId: string,
  message: string,
  extra: Partial<Task> = {},
) {
  const t: Task = {
    id: id(),
    issueId,
    kind: "followup",
    text: text(message, "Work item"),
    status: "pending",
    dependencyIds: [],
    attempts: 0,
    createdAt: now(),
    ...extra,
  };
  s.tasks.push(t);
  event(s, issueId, "Triage", "task.created", t.text, {
    taskId: t.id,
    runId: s.runs.find((r) => r.id === t.sourceId)?.id,
  });
  return t;
}
export function artifact(
  s: State,
  p: Partial<Artifact> & { issueId: string; title: string; content: string },
) {
  find(s.issues, p.issueId);
  if (/^https?:\/\/\S+$/.test(p.content))
    fail(
      400,
      "MATERIAL_UNREADABLE",
      "Supply readable content, not only a link",
    );
  const a: Artifact = {
    ...p,
    id: id(),
    issueId: p.issueId,
    title: text(p.title, "Artifact title", 500),
    content: text(p.content, "Artifact content", 1000000),
    kind: p.kind || "report",
    version: hash(p.content),
    provenance: p.provenance || "Agent report",
    createdAt: now(),
  };
  if (p.supersedesId) {
    const old = find(s.artifacts, p.supersedesId);
    if (old.issueId !== p.issueId)
      fail(400, "INVALID_INPUT", "Cannot replace another Issue artifact");
    for (const q of s.requests.filter(
      (q) =>
        q.issueId === p.issueId &&
        q.artifactIds.includes(old.id) &&
        ["Pending", "Approved"].includes(q.status),
    )) {
      q.status = "Superseded";
      q.revision++;
    }
  }
  s.artifacts.push(a);
  event(
    s,
    p.issueId,
    p.provenance === "Human" ? "Human" : "Agent",
    "artifact.published",
    a.title,
    { runId: a.runId, data: { artifactId: a.id } },
  );
  return a;
}
export function validateScope(
  s: State,
  issueId: string,
  scope: unknown,
): Scope {
  if (scope === "issue") return scope;
  const x = scope as Exclude<Scope, string>;
  if (
    !x ||
    typeof x !== "object" ||
    !["taskIds", "bindingIds", "worktreeIds"].every((k) =>
      Array.isArray((x as any)[k]),
    ) ||
    Object.keys(x).some(
      (k) => !["taskIds", "bindingIds", "worktreeIds"].includes(k),
    ) ||
    ![x.taskIds, x.bindingIds, x.worktreeIds].some((a) => a.length)
  )
    fail(
      400,
      "INVALID_INPUT",
      "Scope must identify work items, bindings or Worktrees",
    );
  for (const k of x.taskIds)
    if (find(s.tasks, k).issueId !== issueId)
      fail(400, "INVALID_INPUT", "Invalid task scope");
  for (const k of x.bindingIds)
    if (find(s.bindings, k).issueId !== issueId)
      fail(400, "INVALID_INPUT", "Invalid binding scope");
  for (const k of x.worktreeIds)
    if (
      !s.bindings.some(
        (b) => b.issueId === issueId && b.worktreeId === k && !b.removed,
      )
    )
      fail(400, "INVALID_INPUT", "Invalid Worktree scope");
  return x;
}
export function makeRequest(
  s: State,
  p: Partial<Request> & { issueId: string; title: string },
) {
  const i = find(s.issues, p.issueId);
  const kind = p.kind || "input";
  if (!["input", "approval", "final"].includes(kind))
    fail(400, "INVALID_INPUT", "Unknown request kind");
  for (const k of p.artifactIds || [])
    if (find(s.artifacts, k).issueId !== i.id)
      fail(400, "INVALID_INPUT", "Invalid material");
  if (kind !== "input" && (!p.artifactIds?.length || !p.action))
    fail(400, "INVALID_INPUT", "Approval requires frozen material and action");
  if (p.body !== undefined && typeof p.body !== "string")
    fail(400, "INVALID_INPUT", "Request body must be text");
  if (
    p.options !== undefined &&
    (!Array.isArray(p.options) ||
      p.options.some(
        (o) => !o || typeof o.value !== "string" || typeof o.label !== "string",
      ))
  )
    fail(400, "INVALID_INPUT", "Invalid request options");
  const q: Request = {
    ...p,
    id: id(),
    issueId: i.id,
    kind,
    title: text(p.title, "Question", 500),
    body: p.body || "",
    artifactIds: p.artifactIds || [],
    scope: validateScope(
      s,
      i.id,
      p.scope ?? (p.taskId ? scopeFor(p.taskId) : "issue"),
    ),
    status: "Pending",
    targetRevision: i.targetRevision,
    revision: 0,
    source: p.source || "Triage",
    recipient: p.recipient || "Human",
  };
  if (p.supersedesId) {
    const old = find(s.requests, p.supersedesId);
    if (old.issueId !== i.id || old.kind !== kind)
      fail(400, "INVALID_INPUT", "Invalid replacement");
    old.status = "Superseded";
    old.supersededById = q.id;
    old.revision++;
    for (const t of s.tasks.filter((t) => t.issueId === i.id))
      t.dependencyIds = t.dependencyIds.map((k) => (k === old.id ? q.id : k));
  }
  s.requests.push(q);
  s.notifications.push({
    id: id(),
    requestId: q.id,
    issueId: i.id,
    category:
      kind === "input" ? (q.source === "Agent" ? "Agent" : "Triage") : "Review",
    read: false,
    archived: false,
    createdAt: now(),
  });
  event(s, i.id, q.source, "request.created", q.title, {
    requestId: q.id,
    taskId: q.taskId,
    runId: q.runId,
  });
  recompute(s);
  return q;
}
export function dependencies(s: State, t: Task, b?: Binding) {
  return (
    t.dependencyIds.every(
      (k) =>
        s.requests.some(
          (q) =>
            q.id === k &&
            ["Approved", "Answered", "Resolved"].includes(q.status),
        ) || s.tasks.some((x) => x.id === k && x.status === "done"),
    ) &&
    !s.requests.some(
      (q) =>
        q.issueId === t.issueId &&
        !q.supersededById &&
        q.id !== t.requestId &&
        q.id !== t.sourceId &&
        !q.native &&
        !(
          q.inputClass === "configuration" && q.conditionKey?.startsWith("JEV")
        ) &&
        ["Pending", "Changes requested", "Cancelled", "Superseded"].includes(
          q.status,
        ) &&
        applies(q, t, b),
    )
  );
}
export function finalReady(s: State, issueId: string, exclude?: string) {
  const i = find(s.issues, issueId);
  if (
    !i.started ||
    s.tasks.some(
      (t) =>
        t.issueId === i.id &&
        t.kind !== "goal" &&
        !["done", "cancelled"].includes(t.status),
    ) ||
    s.runs.some((r) => r.issueId === i.id && activeRun(r)) ||
    i.sessions.some((x) => x.busyTurnId || x.status === "unknown") ||
    s.requests.some(
      (q) =>
        q.issueId === i.id &&
        q.id !== exclude &&
        !q.supersededById &&
        ["Pending", "Changes requested", "Cancelled"].includes(q.status) &&
        !q.native,
    )
  )
    fail(
      409,
      "DEPENDENCY_BLOCKED",
      "Resolve remaining work and verify active or unknown execution before final acceptance",
    );
  const evidence = s.artifacts.filter((a) => a.issueId === i.id);
  if (
    !evidence.length ||
    !evidence.some(
      (a) => ["report", "test"].includes(a.kind) && a.content.trim(),
    )
  )
    fail(
      409,
      "DEPENDENCY_BLOCKED",
      "Provide inspectable results and verification evidence",
    );
  for (const r of s.runs.filter(
    (r) =>
      r.issueId === i.id &&
      r.origin === "platform" &&
      r.snapshot.targetRevision === i.targetRevision &&
      r.status === "completed" &&
      ["implement", "verify", "revise"].includes(r.mode || ""),
  )) {
    const w = find(s.worktrees, r.snapshot.worktreeId);
    if (!approvalIds(s, i.id, w, r.mode!, r.taskId).length)
      fail(
        409,
        "DEPENDENCY_BLOCKED",
        "Implementation basis is not currently approved",
      );
  }
}
export function createFinal(s: State, issueId: string) {
  if (
    s.requests.some(
      (q) =>
        q.issueId === issueId && q.kind === "final" && q.status === "Pending",
    )
  )
    return;
  finalReady(s, issueId);
  const i = find(s.issues, issueId);
  const materials = s.artifacts.filter(
    (a) =>
      a.issueId === i.id && !s.artifacts.some((b) => b.supersedesId === a.id),
  );
  for (const t of s.tasks.filter(
    (t) => t.issueId === i.id && t.kind === "goal",
  ))
    t.status = "done";
  const previous = s.requests.findLast(
    (q) => q.issueId === i.id && q.kind === "final" && !q.supersededById,
  );
  return makeRequest(s, {
    issueId,
    kind: "final",
    source: "Triage",
    title: "Final acceptance",
    body: "Review the current goal, changes and actual verification evidence.",
    scope: "issue",
    artifactIds: materials.map((a) => a.id),
    supersedesId: previous?.id,
    action: {
      type: "final",
      targetRevision: i.targetRevision,
      artifactHashes: Object.fromEntries(
        materials.map((a) => [a.id, a.version]),
      ),
      pins: Object.fromEntries(
        s.bindings
          .filter((b) => b.issueId === i.id && !b.removed)
          .map((b) => {
            const w = find(s.worktrees, b.worktreeId);
            return [w.id, w.specVersionId];
          }),
      ),
    },
  });
}
function notifyResolved(s: State, q: Request) {
  for (const n of s.notifications.filter((n) => n.requestId === q.id)) {
    n.read = true;
    n.archived = true;
  }
}
function checkAttachments(s: State, issueId: string, input: any[]) {
  if (!Array.isArray(input)) fail(400, "INVALID_INPUT", "Invalid attachments");
  for (const a of input) {
    if (
      !a ||
      typeof a.content !== "string" ||
      !/^[\w+/]*={0,2}$/.test(a.content) ||
      Buffer.from(a.content, "base64").length > 5 * 1024 * 1024
    )
      fail(400, "INVALID_INPUT", "Invalid attachment / maximum 5MB");
    s.attachments.push({
      id: id(),
      issueId,
      name: text(a.name, "Attachment name", 500),
      mime: a.mime || "application/octet-stream",
      content: a.content,
      createdAt: now(),
    });
  }
}
export class Domain {
  store: Store;
  constructor(store: Store) {
    this.store = store;
  }
  action(type: string, p: Record<string, any>, key?: string) {
    if (!p || typeof p !== "object" || Array.isArray(p))
      fail(400, "INVALID_INPUT", "Object payload required");
    return this.store.change(
      (s) => {
        const result = this.apply(s, type, p);
        recompute(s);
        return result;
      },
      key,
      hash(JSON.stringify({ type, p })),
    );
  }
  apply(s: State, type: string, p: any): any {
    switch (type) {
      case "issue.create": {
        const i: Issue = {
          id: id(),
          number: "REL-" + s.nextIssue++,
          title: text(p.title, "Title", 500),
          description: p.description || "",
          status: "Todo",
          createdAt: now(),
          updatedAt: now(),
          started: false,
          control: "paused",
          revision: 0,
          targetRevision: 1,
          runBudgetStart: 0,
          priority: 0,
          labels: [],
          corrections: [],
          sessions: [],
          triage: {
            dirty: false,
            evaluationRevision: 0,
            phase: "idle",
            triggerIds: [],
          },
        };
        if (typeof i.description !== "string")
          fail(400, "INVALID_INPUT", "Description must be text");
        s.issues.push(i);
        checkAttachments(s, i.id, p.attachments || []);
        event(s, i.id, "Human", "issue.created", i.title);
        return i;
      }
      case "issue.update": {
        const i = find(s.issues, p.issueId);
        if (i.revision !== p.revision)
          fail(409, "STALE_VERSION", "Issue changed");
        if (p.title !== undefined || p.description !== undefined) {
          const title =
            p.title === undefined ? i.title : text(p.title, "Title", 500);
          const description =
            p.description === undefined ? i.description : p.description;
          if (typeof description !== "string")
            fail(400, "INVALID_INPUT", "Description must be text");
          if (title !== i.title || description !== i.description) {
            if (i.status === "Done")
              fail(
                409,
                "DEPENDENCY_BLOCKED",
                "Use Reopen to change a completed target",
              );
            if (
              s.runs.some((r) => r.issueId === i.id && activeRun(r)) ||
              i.sessions.some((session) =>
                ["busy", "unknown"].includes(session.status),
              )
            )
              fail(
                409,
                "WORKTREE_BUSY",
                "Stop the current execution before changing its target",
              );
            i.title = title;
            i.description = description;
            i.targetRevision++;
            for (const q of s.requests.filter(
              (q) =>
                q.issueId === i.id &&
                q.targetRevision !== i.targetRevision &&
                !q.native &&
                ["Pending", "Changes requested", "Cancelled"].includes(
                  q.status,
                ),
            )) {
              q.status = "Superseded";
              q.revision++;
              notifyResolved(s, q);
            }
            for (const t of s.tasks.filter(
              (t) =>
                t.issueId === i.id && !["done", "cancelled"].includes(t.status),
            ))
              t.status = "cancelled";
            if (i.started)
              task(s, i.id, i.description || i.title, {
                kind: "goal",
                sourceId: i.id,
              });
            dirty(s, i.id, "target.updated");
          }
        }
        if (p.priority !== undefined) {
          if (!Number.isInteger(p.priority) || p.priority < 0 || p.priority > 4)
            fail(400, "INVALID_INPUT", "Invalid priority");
          i.priority = p.priority;
        }
        if (p.labels !== undefined) {
          if (!Array.isArray(p.labels) || p.labels.length > 50)
            fail(400, "INVALID_INPUT", "Invalid labels");
          i.labels = [
            ...new Set<string>(p.labels.map((v: any) => text(v, "Label", 100))),
          ];
          for (const name of i.labels)
            if (!s.labelCatalog.some((l) => l.name === name))
              s.labelCatalog.push({ name, color: "bg-emerald-500" });
        }
        event(s, i.id, "Human", "issue.updated", i.title);
        return i;
      }
      case "comment.create": {
        find(s.issues, p.issueId);
        const c = {
          id: id(),
          issueId: p.issueId,
          text: text(p.text, "Comment"),
          createdAt: now(),
        };
        s.comments.push(c);
        event(s, p.issueId, "Human", "comment", c.text);
        return c;
      }
      case "attachment.create": {
        find(s.issues, p.issueId);
        checkAttachments(s, p.issueId, [p]);
        const a = s.attachments.at(-1)!;
        event(s, p.issueId, "Human", "attachment.created", a.name, {
          data: { attachmentId: a.id },
        });
        return a;
      }
      case "project.create": {
        const r = repository(p.path);
        if (s.projects.some((x) => x.commonDir === r.commonDir))
          fail(409, "DUPLICATE_PROJECT", "Repository already registered");
        const x = {
          id: id(),
          name: text(p.name, "Project name", 500),
          path: r.path,
          commonDir: r.commonDir,
          health: r.dirty ? "needs attention" : "healthy",
          healthReason: "Git directory verified",
          checkedAt: now(),
        };
        s.projects.push(x);
        return x;
      }
      case "worktree.create": {
        const project = find(s.projects, p.projectId),
          r = repository(p.path);
        if (r.commonDir !== project.commonDir)
          fail(
            422,
            "INVALID_REPOSITORY",
            "Worktree belongs to another Project",
          );
        if (r.branch !== p.branch)
          fail(422, "BRANCH_MISMATCH", "Actual branch: " + r.branch);
        if (s.worktrees.some((w) => w.path === r.path))
          fail(409, "DUPLICATE_WORKTREE", "Directory already registered");
        if (!!p.newSpec === !!p.specId)
          fail(
            400,
            "INVALID_INPUT",
            "Select an existing Spec version or create a named Spec",
          );
        const refs = p.newSpec
          ? createSpec(s, project.id, p.newSpec.name)
          : undefined;
        const specId = refs?.spec.id || p.specId,
          versionId = refs?.initialVersion.id || p.specVersionId;
        specReference(s, project.id, specId, versionId);
        const w = {
          id: id(),
          projectId: project.id,
          path: r.path,
          name: text(p.name, "Name", 500),
          branch: text(p.branch, "Branch", 500),
          specId,
          specVersionId: versionId,
          revision: 0,
        };
        s.worktrees.push(w);
        return w;
      }
      case "binding.save": {
        const i = find(s.issues, p.issueId),
          project = find(s.projects, p.projectId),
          w = find(s.worktrees, p.worktreeId),
          a = find(s.agents, p.agentId);
        if (w.projectId !== project.id)
          fail(
            422,
            "INVALID_REPOSITORY",
            "Worktree belongs to another Project",
          );
        validateWorktree(w, project);
        specReference(s, project.id, w.specId, w.specVersionId);
        if (
          s.bindings.some(
            (b) =>
              !b.removed &&
              b.id !== p.id &&
              b.issueId === i.id &&
              b.projectId === project.id &&
              b.worktreeId === w.id &&
              b.agentId === a.id,
          )
        )
          fail(409, "DUPLICATE_BINDING", "Edit the existing binding");
        const old = p.id ? find(s.bindings, p.id) : undefined;
        if (
          old &&
          (old.issueId !== i.id || old.removed || old.revision !== p.revision)
        )
          fail(409, "STALE_VERSION", "Binding changed");
        let activeSessionId = old?.activeSessionId;
        if (old && (old.agentId !== a.id || old.worktreeId !== w.id)) {
          const session = i.sessions.find((x) => x.id === activeSessionId);
          if (
            s.runs.some((r) => r.bindingId === old.id && activeRun(r)) ||
            session?.busyTurnId ||
            session?.status === "unknown"
          )
            fail(409, "RESULT_UNKNOWN", "Stop and verify old execution first");
          if (session) session.status = "archived";
          activeSessionId = undefined;
        }
        const b: Binding = {
          id: old?.id || id(),
          issueId: i.id,
          projectId: project.id,
          worktreeId: w.id,
          agentId: a.id,
          description: text(p.description, "Routing description"),
          revision: (old?.revision ?? -1) + 1,
          removed: false,
          activeSessionId,
        };
        if (old) Object.assign(old, b);
        else s.bindings.push(b);
        dirty(s, i.id, "binding.saved");
        event(
          s,
          i.id,
          "Human",
          old ? "binding.updated" : "binding.created",
          a.name +
            " · " +
            project.name +
            " · " +
            w.branch +
            " · " +
            b.description,
          { bindingId: b.id },
        );
        return b;
      }
      case "binding.remove": {
        const b = find(s.bindings, p.bindingId),
          i = find(s.issues, b.issueId);
        if (
          s.runs.some((r) => r.bindingId === b.id && activeRun(r)) ||
          i.sessions.some(
            (x) =>
              x.bindingId === b.id && (x.busyTurnId || x.status === "unknown"),
          )
        )
          fail(
            409,
            "RESULT_UNKNOWN",
            "Stop and verify current execution first",
          );
        b.removed = true;
        b.revision++;
        const x = i.sessions.find((x) => x.id === b.activeSessionId);
        if (x) x.status = "archived";
        b.activeSessionId = undefined;
        for (const t of s.tasks.filter(
          (t) =>
            t.bindingId === b.id && !["done", "cancelled"].includes(t.status),
        )) {
          t.bindingId = undefined;
          t.status = "pending";
        }
        dirty(s, i.id, "binding.removed");
        event(
          s,
          i.id,
          "Human",
          "binding.removed",
          text(p.reason, "Removal reason"),
          { bindingId: b.id },
        );
        return b;
      }
      case "issue.control": {
        const i = find(s.issues, p.issueId);
        if (p.command === "start") {
          if (i.status === "Done")
            fail(409, "DEPENDENCY_BLOCKED", "Reopen first");
          if (!i.started) {
            i.started = true;
            task(s, i.id, i.title + "\n\n" + i.description, {
              kind: "goal",
              sourceId: i.id,
            });
          }
          if (i.control === "stopping")
            fail(
              409,
              "RESULT_UNKNOWN",
              "Confirm stopped execution before starting",
            );
          i.control = "enabled";
        } else if (p.command === "pause") i.control = "paused";
        else if (p.command === "resume") {
          if (!i.started || i.status === "Done")
            fail(409, "DEPENDENCY_BLOCKED", "Issue is not active");
          if (
            s.runs.some(
              (r) =>
                r.issueId === i.id &&
                (r.status === "unknown" || r.status === "stopping"),
            ) ||
            i.sessions.some((x) => x.status === "unknown")
          )
            fail(
              409,
              "RESULT_UNKNOWN",
              "Verify unknown or stopping execution first",
            );
          if (
            s.requests.some(
              (q) =>
                q.issueId === i.id &&
                q.inputClass === "recovery" &&
                q.status === "Pending",
            )
          )
            fail(409, "DEPENDENCY_BLOCKED", "Resolve recovery request first");
          i.control = "enabled";
          i.runBudgetStart = s.runs.filter(
            (r) => r.issueId === i.id && r.origin === "platform",
          ).length;
          for (const t of s.tasks.filter(
            (t) =>
              t.issueId === i.id && !["done", "cancelled"].includes(t.status),
          ))
            t.attempts = 0;
          for (const c of i.corrections) c.stopResolved = true;
        } else if (p.command === "stop") {
          const correction = text(p.text, "Correction");
          i.targetRevision++;
          i.corrections.push({
            id: id(),
            text: correction,
            at: now(),
            source: "Human",
            targetRevision: i.targetRevision,
            stopResolved: false,
          });
          for (const r of s.runs.filter(
            (r) => r.issueId === i.id && activeRun(r),
          )) {
            r.stopRequested = true;
            if (r.status !== "unknown") r.status = "stopping";
          }
          i.control = s.runs.some((r) => r.issueId === i.id && activeRun(r))
            ? "stopping"
            : "paused";
          for (const t of s.tasks.filter(
            (t) =>
              t.issueId === i.id && t.kind === "goal" && t.status === "done",
          ))
            t.status = "pending";
        } else if (p.command === "reopen") {
          if (i.status !== "Done")
            fail(409, "DEPENDENCY_BLOCKED", "Only Done can reopen");
          const goal = text(p.text, "New goal");
          i.finalApprovalId = undefined;
          i.status = "In progress";
          i.targetRevision++;
          i.description = goal;
          i.control = "paused";
          for (const t of s.tasks.filter(
            (t) =>
              t.issueId === i.id && !["done", "cancelled"].includes(t.status),
          ))
            t.status = "cancelled";
          task(s, i.id, goal, { kind: "goal", sourceId: i.id });
        } else fail(400, "INVALID_INPUT", "Unknown control");
        dirty(s, i.id, "issue." + p.command);
        event(s, i.id, "Human", "issue." + p.command, p.text || p.command);
        return i;
      }
      case "request.decide": {
        const q = find(s.requests, p.requestId),
          i = find(s.issues, q.issueId);
        if (q.status !== "Pending")
          fail(409, "REQUEST_RESOLVED", "Request already resolved", {
            request: q,
          });
        if (q.revision !== p.revision)
          fail(409, "STALE_VERSION", "Request changed");
        if (p.decision === "cancel") {
          q.answer = text(p.answer, "Cancellation reason");
          q.status = "Cancelled";
        } else if (q.kind === "input") {
          if (p.decision !== "answer")
            fail(400, "INVALID_INPUT", "Input requires an answer");
          let answer = text(p.answer, "Answer");
          if (q.options?.length) {
            let options = q.options.filter((o) => o.value === answer);
            if (!options.length)
              options = q.options.filter(
                (o) =>
                  o.label === answer || o.label + " · " + o.value === answer,
              );
            if (!options.length && q.routeTask)
              options = q.options.filter((o) => {
                const b = s.bindings.find(
                  (b) => b.id === o.value && !b.removed && b.issueId === i.id,
                );
                return (
                  b &&
                  find(s.agents, b.agentId).name.toLowerCase() ===
                    answer.toLowerCase()
                );
              });
            if (options.length !== 1)
              fail(
                400,
                "INVALID_INPUT",
                "Choose one full listed option or binding ID; ambiguous names cannot be used",
              );
            answer = options[0].value;
          }
          q.answer = answer;
          q.status = "Answered";
          for (const t of s.tasks.filter(
            (t) => t.requestId === q.id && t.kind === "clarification",
          ))
            if (!["running", "unknown"].includes(t.status)) t.status = "done";
        } else if (p.decision === "approve") {
          if (q.kind === "final") {
            const a = q.action as Extract<ApprovalAction, { type: "final" }>;
            if (a?.type !== "final" || a.targetRevision !== i.targetRevision)
              fail(409, "STALE_VERSION", "Final acceptance target changed");
            finalReady(s, i.id, q.id);
            if (
              Object.entries(a.artifactHashes).some(
                ([k, v]) =>
                  find(s.artifacts, k).version !== v ||
                  s.artifacts.some((x) => x.supersedesId === k),
              ) ||
              Object.entries(a.pins).some(
                ([k, v]) => find(s.worktrees, k).specVersionId !== v,
              )
            )
              fail(409, "STALE_VERSION", "Final acceptance material changed");
            i.status = "Done";
            i.finalApprovalId = q.id;
          } else if (!q.native) approveSpec(this.store, s, q);
          q.status = "Approved";
        } else if (p.decision === "changes") {
          q.answer = text(p.answer, "Changes requested");
          q.status = "Changes requested";
          if (!q.native) {
            for (const t of s.tasks.filter(
              (t) => t.issueId === i.id && t.kind === "goal",
            ))
              t.status = "pending";
            task(s, i.id, "Revise " + q.title + "\n" + q.answer, {
              kind: "revision",
              sourceId: q.id,
            });
          }
        } else
          fail(
            400,
            "INVALID_INPUT",
            "Approval requires explicit approve or changes",
          );
        q.decision = p.decision;
        q.decidedBy = "Human";
        q.decidedAt = now();
        q.revision++;
        notifyResolved(s, q);
        dirty(s, i.id, "request." + p.decision);
        event(s, i.id, "Human", "request." + p.decision, q.answer || q.title, {
          requestId: q.id,
        });
        return q;
      }
      case "notification.update": {
        const n = find(s.notifications, p.notificationId);
        for (const k of ["read", "archived"] as const)
          if (p[k] !== undefined) {
            if (typeof p[k] !== "boolean")
              fail(400, "INVALID_INPUT", "Notification flags must be boolean");
            n[k] = p[k];
          }
        return n;
      }
      case "run.reconcile": {
        const r = find(s.runs, p.runId),
          i = find(s.issues, r.issueId);
        if (r.status !== "unknown")
          fail(
            409,
            "RESULT_UNKNOWN",
            "Only unknown execution can be reconciled",
          );
        if (!["completed", "failed", "stopped"].includes(p.outcome))
          fail(400, "INVALID_INPUT", "Invalid outcome");
        r.result = text(p.evidence, "Verification evidence");
        r.status = p.outcome;
        r.finishedAt = now();
        r.ingestedAt = now();
        const evidence = artifact(s, {
          issueId: i.id,
          runId: r.id,
          title: "Human verification of execution",
          content: r.result,
          provenance: "Human",
        });
        r.resultArtifactId = evidence.id;
        const x = find(i.sessions, r.sessionId);
        x.busyTurnId = undefined;
        x.status = "idle";
        if (r.taskId) {
          const t = find(s.tasks, r.taskId);
          t.status = "pending";
          t.waitReason = undefined;
        }
        this.store.db.prepare("DELETE FROM locks WHERE run_id=?").run(r.id);
        for (const q of s.requests.filter(
          (q) =>
            q.runId === r.id &&
            q.inputClass === "recovery" &&
            q.status === "Pending",
        )) {
          q.status = "Resolved";
          q.resolutionEvidence = r.result;
        }
        if (
          i.control === "stopping" &&
          !s.runs.some((r) => r.issueId === i.id && activeRun(r))
        )
          i.control = "paused";
        dirty(s, i.id, "run.reconciled");
        event(s, i.id, "Human", "run.reconciled", r.result, { runId: r.id });
        return r;
      }
      default:
        fail(400, "INVALID_INPUT", "Unknown action");
    }
  }
  report(runId: string, report: any, key: string) {
    return this.store.change(
      (s) => {
        const r = find(s.runs, runId),
          i = find(s.issues, r.issueId);
        if (
          r.origin !== "platform" ||
          !["starting", "running"].includes(r.status) ||
          r.stopRequested ||
          i.targetRevision !== r.snapshot.targetRevision
        )
          fail(409, "STALE_VERSION", "Run cannot accept this report");
        if (
          !report ||
          typeof report !== "object" ||
          Array.isArray(report) ||
          Object.keys(report).some(
            (k) =>
              ![
                "specProposal",
                "artifacts",
                "requests",
                "answer",
                "suggestions",
              ].includes(k),
          )
        )
          fail(400, "INVALID_INPUT", "Invalid report fields");
        const ids: string[] = [];
        const reportedArtifacts: string[] = [];
        if (report.specProposal) {
          const p = report.specProposal,
            w = find(s.worktrees, r.snapshot.worktreeId),
            spec = find(s.specs, w.specId);
          if (
            p.specId !== w.specId ||
            p.baseVersionId !== r.snapshot.specVersionId ||
            p.draftRevision !== spec.draft.revision
          )
            fail(
              409,
              "SPEC_CONFLICT",
              "Spec proposal has stale scope or draft",
            );
          spec.draft.product = bodyText(p.product);
          spec.draft.tech = bodyText(p.tech);
          spec.draft.revision++;
          if (!spec.draft.product.trim() || !spec.draft.tech.trim())
            fail(400, "MATERIAL_UNREADABLE", "Both Spec documents required");
          const v = publishVersion(s, spec.id, spec.draft.revision, {
            issueId: i.id,
            runId: r.id,
          });
          const targets = p.upgradeTargets || [];
          if (
            !Array.isArray(targets) ||
            new Set(targets.map((t) => t.worktreeId)).size !== targets.length
          )
            fail(400, "INVALID_INPUT", "Invalid upgrade targets");
          for (const t of targets) {
            const target = find(s.worktrees, t.worktreeId);
            if (
              !s.bindings.some(
                (b) =>
                  b.issueId === i.id &&
                  !b.removed &&
                  b.worktreeId === t.worktreeId &&
                  b.projectId === w.projectId,
              ) ||
              target.specId !== spec.id
            )
              fail(400, "INVALID_INPUT", "Invalid upgrade target");
            if (
              target.specVersionId !== t.fromVersionId ||
              target.revision !== t.worktreeRevision
            )
              fail(409, "STALE_VERSION", "Upgrade target changed");
          }
          const a = artifact(s, {
            issueId: i.id,
            runId: r.id,
            bindingId: r.bindingId,
            kind: "spec",
            title: spec.name + " V" + v.number,
            content: "# PRODUCT\n" + v.product + "\n\n# TECH\n" + v.tech,
            specVersionId: v.id,
          });
          const previous = s.requests.findLast(
            (q) =>
              q.issueId === i.id &&
              q.kind === "approval" &&
              q.artifactIds.some((k) =>
                s.artifacts.some(
                  (a) =>
                    a.id === k &&
                    a.specVersionId &&
                    find(s.specVersions, a.specVersionId).specId === spec.id,
                ),
              ) &&
              !q.supersededById,
          );
          const action: ApprovalAction = targets.length
            ? {
                type: "approve_spec_and_upgrade",
                specVersionId: v.id,
                targets,
                allowedModes: ["implement", "verify", "revise"],
              }
            : {
                type: "approve_spec",
                specVersionId: v.id,
                worktreeIds: [w.id],
                allowedModes: ["implement", "verify", "revise"],
              };
          const description = targets
            .map((t: any) => {
              const target = find(s.worktrees, t.worktreeId),
                from = find(s.specVersions, t.fromVersionId);
              return (
                target.name +
                " · " +
                target.path +
                " · V" +
                from.number +
                " → V" +
                v.number
              );
            })
            .join("\n");
          const q = makeRequest(s, {
            issueId: i.id,
            runId: r.id,
            taskId: r.taskId,
            kind: "approval",
            source: r.snapshot.agentName,
            title: "Approve " + spec.name + " V" + v.number,
            body:
              "Approve this immutable version for the stated implementation scope." +
              (description
                ? "\nUpgrade exactly:\n" + description
                : "\nApproval does not change Worktree versions."),
            artifactIds: [a.id],
            scope: {
              taskIds: [],
              bindingIds: [],
              worktreeIds: targets.length
                ? targets.map((t: any) => t.worktreeId)
                : [w.id],
            },
            action,
            supersedesId: previous?.id,
          });
          ids.push(v.id, a.id, q.id);
        }
        if (report.artifacts !== undefined && !Array.isArray(report.artifacts))
          fail(400, "INVALID_INPUT", "artifacts must be an array");
        for (const a of report.artifacts || []) {
          if (
            !a ||
            typeof a !== "object" ||
            (a.kind &&
              !["report", "test", "spec", "patch", "link"].includes(a.kind))
          )
            fail(400, "INVALID_INPUT", "Invalid artifact");
          const saved = artifact(s, {
            title: a.title,
            kind: a.kind,
            supersedesId: a.supersedesId,
            issueId: i.id,
            runId: r.id,
            bindingId: r.bindingId,
            worktreeId: r.snapshot.worktreeId,
            content: this.store.redact(bodyText(a.content)),
            provenance: r.snapshot.agentName,
          });
          ids.push(saved.id);
          reportedArtifacts.push(saved.id);
        }
        if (report.requests !== undefined && !Array.isArray(report.requests))
          fail(400, "INVALID_INPUT", "requests must be an array");
        for (const p of report.requests || []) {
          if (
            (p.kind !== "input" && p.kind !== "approval") ||
            (p.action && p.action.type !== "review")
          )
            fail(
              400,
              "INVALID_INPUT",
              "Agent cannot create final decisions or implementation authority",
            );
          if (
            (p.routeToAgent && p.kind !== "input") ||
            (p.routeToAgent !== undefined &&
              typeof p.routeToAgent !== "boolean") ||
            (p.action && typeof p.action.description !== "string") ||
            (p.artifactIndexes !== undefined &&
              !Array.isArray(p.artifactIndexes))
          )
            fail(400, "INVALID_INPUT", "Invalid request fields");
          const arts = (p.artifactIndexes || []).map((index: number) => {
            if (!Number.isInteger(index) || !reportedArtifacts[index])
              fail(400, "INVALID_INPUT", "Invalid material index");
            return reportedArtifacts[index];
          });
          const q = makeRequest(s, {
            issueId: i.id,
            runId: r.id,
            taskId: r.taskId,
            kind: p.kind,
            title: p.title,
            body: p.body,
            scope: p.scope || scopeFor(r.taskId!),
            artifactIds: arts,
            action: p.action,
            supersedesId: p.supersedesId,
            inputClass: "business",
            source: r.snapshot.agentName,
            recipient: p.routeToAgent ? "Agent" : "Human",
          });
          ids.push(q.id);
          if (p.routeToAgent)
            task(s, i.id, q.title + "\n" + q.body, {
              kind: "clarification",
              requestId: q.id,
              sourceId: q.id,
            });
        }
        if (report.answer) {
          const q = find(s.requests, report.answer.requestId),
            t = find(s.tasks, r.taskId);
          if (
            q.issueId !== i.id ||
            q.kind !== "input" ||
            q.recipient !== "Agent" ||
            q.status !== "Pending" ||
            t.requestId !== q.id
          )
            fail(400, "INVALID_INPUT", "Run cannot answer this request");
          q.answer = text(report.answer.text, "Answer");
          q.status = "Answered";
          q.revision++;
          t.status = "done";
          notifyResolved(s, q);
          ids.push(q.id);
        }
        if (
          report.suggestions !== undefined &&
          !Array.isArray(report.suggestions)
        )
          fail(400, "INVALID_INPUT", "suggestions must be an array");
        for (const suggestion of report.suggestions || []) {
          for (const dep of suggestion.dependencyIds || [])
            if (
              ![...s.tasks, ...s.requests].some(
                (x) => x.id === dep && x.issueId === i.id,
              )
            )
              fail(400, "INVALID_INPUT", "Invalid suggested dependency");
          ids.push(
            task(s, i.id, suggestion.text, {
              kind: "followup",
              sourceId: r.id,
              dependencyIds: suggestion.dependencyIds || [],
            }).id,
          );
        }
        dirty(s, i.id, "report.applied");
        recompute(s);
        return { appliedIds: ids, revision: s.revision + 1 };
      },
      key,
      hash(JSON.stringify({ runId, report })),
    );
  }
  recover() {
    this.store.change((s) => {
      for (const r of s.runs.filter(activeRun)) {
        if (r.status === "stopping") r.stopRequested = true;
        r.status = "unknown";
        r.reason = "Verify the native session after Relay restart";
        find(s.issues, r.issueId).sessions.find(
          (x) => x.id === r.sessionId,
        )!.status = "unknown";
        if (r.taskId) find(s.tasks, r.taskId).status = "unknown";
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
            body: r.reason,
            source: "System",
            scope: r.taskId ? scopeFor(r.taskId) : "issue",
          });
      }
      for (const i of s.issues) {
        dirty(s, i.id, "service.restarted");
        i.triage.phase = "idle";
      }
      recompute(s);
    });
  }
}
