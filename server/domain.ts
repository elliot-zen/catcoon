import { Store, id, now, hash, find, text, fail } from "./store.ts";
import { repository, validateWorktree, specPath } from "./files.ts";
import { activeRun } from "./types.ts";
import type {
  State,
  Issue,
  Task,
  Request,
  Binding,
  Artifact,
  Run,
  Event,
} from "./types.ts";
export function event(
  s: State,
  issueId: string,
  source: string,
  type: string,
  message: string,
  extra: Partial<Event> = {},
) {
  const e = {
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
  for (const i of s.issues) {
    if (i.status === "Done") continue;
    i.status = !i.started
      ? "Todo"
      : s.requests.some(
            (r) =>
              r.issueId === i.id &&
              r.status === "Pending" &&
              r.recipient !== "Agent",
          )
        ? "Human input"
        : "In progress";
  }
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
    text: text(message, "Task"),
    status: "pending",
    dependencyIds: [],
    attempts: 0,
    createdAt: now(),
    ...extra,
  };
  s.tasks.push(t);
  event(
    s,
    issueId,
    s.runs.find((r) => r.id === t.sourceId)?.snapshot.agentName ||
      (t.requestId ? "Triage" : "Human"),
    "task.created",
    t.text,
    { taskId: t.id },
  );
  return t;
}
export function artifact(
  s: State,
  p: Partial<Artifact> & { issueId: string; content: string; title: string },
) {
  find(s.issues, p.issueId);
  if (
    typeof p.content === "string" &&
    /^https?:\/\/\S+$/.test(p.content.trim())
  )
    fail(
      400,
      "MATERIAL_UNREADABLE",
      "Publish the document content or a readable snapshot instead of only a link",
    );
  const a: Artifact = {
    id: id(),
    issueId: p.issueId,
    kind: p.kind || "report",
    title: text(p.title, "Artifact title", 500),
    content: text(p.content, "Artifact content", 1000000),
    version: hash(p.content),
    createdAt: now(),
    runId: p.runId,
    bindingId: p.bindingId,
    worktreeId: p.worktreeId,
    supersedesId: p.supersedesId,
  };
  if (p.supersedesId) {
    const old = find(s.artifacts, p.supersedesId);
    if (old.issueId !== p.issueId)
      fail(400, "INVALID_INPUT", "Cannot replace another Issue artifact");
    for (const r of s.requests.filter(
      (r) =>
        r.issueId === p.issueId &&
        r.artifactIds.includes(old.id) &&
        ["Pending", "Approved", "Changes requested"].includes(r.status),
    )) {
      for (const run of s.runs.filter(
        (run) =>
          run.issueId === p.issueId &&
          ["starting", "running"].includes(run.status),
      )) {
        const work = find(s.tasks, run.taskId);
        if (
          work.dependencyIds.includes(r.id) ||
          r.scope === "issue" ||
          r.scope.includes(work.id)
        ) {
          run.status = "stopping";
          run.reason =
            "Execution basis replaced; stop and verify existing results before continuing";
          event(s, p.issueId, "System", "run.stopping", run.reason, {
            runId: run.id,
            taskId: work.id,
          });
        }
      }
      r.status = "Superseded";
      r.revision++;
      event(s, p.issueId, "System", "request.superseded", r.title, {
        requestId: r.id,
      });
      for (const t of s.tasks.filter(
        (t) =>
          t.issueId === p.issueId &&
          t.dependencyIds.includes(r.id) &&
          !["done", "cancelled"].includes(t.status),
      ))
        t.reason = "Approval object replaced; new approval required";
    }
  }
  s.artifacts.push(a);
  event(
    s,
    p.issueId,
    p.runId ? "Agent" : "Human",
    "artifact.published",
    a.title,
    {
      runId: p.runId,
      bindingId: p.bindingId,
      data: { artifactId: a.id, version: a.version },
    },
  );
  return a;
}
export function makeRequest(
  s: State,
  p: Partial<Request> & { issueId: string; title: string },
) {
  find(s.issues, p.issueId);
  if (!["input", "approval", "final"].includes(p.kind || "input"))
    fail(400, "INVALID_INPUT", "Unknown request kind");
  if (p.taskId && find(s.tasks, p.taskId).issueId !== p.issueId)
    fail(400, "INVALID_INPUT", "Task belongs to another Issue");
  const refs = p.artifactIds || [];
  for (const a of refs)
    if (find(s.artifacts, a).issueId !== p.issueId)
      fail(400, "INVALID_INPUT", "Artifact belongs to another Issue");
  const kind = p.kind || "input";
  if (kind !== "input" && (!refs.length || !p.action?.trim()))
    fail(
      400,
      "INVALID_INPUT",
      "Approval requires frozen materials and intended action",
    );
  const scope = p.scope ?? (p.taskId ? [p.taskId] : "issue");
  if (
    scope !== "issue" &&
    (!Array.isArray(scope) ||
      scope.some((x) => find(s.tasks, x).issueId !== p.issueId))
  )
    fail(400, "INVALID_INPUT", "Invalid blocking scope");
  if (
    p.options &&
    (!Array.isArray(p.options) || p.options.some((o) => !o.value || !o.label))
  )
    fail(400, "INVALID_INPUT", "Invalid options");
  const r: Request = {
    id: id(),
    issueId: p.issueId,
    taskId: p.taskId,
    kind,
    title: text(p.title, "Question", 500),
    body: p.body || "",
    options: p.options,
    artifactIds: refs,
    scope,
    action: p.action || "",
    status: "Pending",
    revision: 0,
    source: p.source || "Human",
    recipient: p.recipient || "Human",
    routeTask: p.routeTask,
    supersedesId: p.supersedesId,
  };
  if (p.supersedesId) {
    const old = find(s.requests, p.supersedesId);
    if (old.issueId !== r.issueId || old.kind !== r.kind || old.supersededById)
      fail(400, "INVALID_INPUT", "Invalid request replacement");
    old.status = "Superseded";
    old.supersededById = r.id;
    old.revision++;
    for (const t of s.tasks.filter((t) => t.issueId === r.issueId))
      t.dependencyIds = t.dependencyIds.map((k) => (k === old.id ? r.id : k));
    event(s, r.issueId, r.source, "request.superseded", old.title, {
      requestId: old.id,
    });
  }
  s.requests.push(r);
  s.notifications.push({
    id: id(),
    requestId: r.id,
    issueId: r.issueId,
    category:
      kind === "input" ? (r.source === "Agent" ? "Agent" : "Triage") : "Review",
    read: false,
    archived: false,
    createdAt: now(),
  });
  event(s, r.issueId, r.source, "request.created", r.title, {
    requestId: r.id,
    taskId: r.taskId,
  });
  return r;
}
export function dependencies(s: State, t: Task) {
  return (
    t.dependencyIds.every((key) => {
      const r = s.requests.find((x) => x.id === key);
      return r
        ? ["Approved", "Answered"].includes(r.status)
        : s.tasks.some((x) => x.id === key && x.status === "done");
    }) &&
    !s.requests.some(
      (r) =>
        r.issueId === t.issueId &&
        !r.supersededById &&
        r.id !== t.sourceId &&
        ["Pending", "Changes requested", "Superseded", "Cancelled"].includes(
          r.status,
        ) &&
        (r.scope === "issue" || r.scope.includes(t.id)) &&
        r.id !== t.requestId,
    )
  );
}
export function finalReady(s: State, issueId: string, exclude?: string) {
  if (!find(s.issues, issueId).started)
    fail(
      409,
      "DEPENDENCY_BLOCKED",
      "Start the Issue and finish its required work first",
    );
  if (
    s.tasks.some(
      (t) => t.issueId === issueId && !["done", "cancelled"].includes(t.status),
    ) ||
    s.runs.some((r) => r.issueId === issueId && activeRun(r)) ||
    s.requests.some(
      (r) =>
        r.issueId === issueId &&
        r.id !== exclude &&
        ["Pending", "Changes requested", "Superseded", "Cancelled"].includes(
          r.status,
        ) &&
        !r.supersededById &&
        !(
          Array.isArray(r.scope) &&
          r.scope.length > 0 &&
          r.scope.every((k) =>
            s.tasks.some((t) => t.id === k && t.status === "cancelled"),
          )
        ),
    )
  )
    fail(
      409,
      "DEPENDENCY_BLOCKED",
      "Finish work, resolve requests and verify unknown runs before final acceptance",
    );
  if (!s.artifacts.some((a) => a.issueId === issueId))
    fail(409, "DEPENDENCY_BLOCKED", "Publish reviewable artifacts first");
}
function wake(s: State, issueId?: string) {
  for (const t of s.tasks) {
    if (
      (!issueId || t.issueId === issueId) &&
      t.status === "waiting" &&
      !s.requests.some((r) => r.taskId === t.id && r.status === "Pending")
    ) {
      t.retryAt = 0;
      if (!t.reason?.startsWith("Execution failed")) t.status = "pending";
    }
  }
}
export class Domain {
  store: Store;
  constructor(store: Store) {
    this.store = store;
  }
  action(type: string, p: Record<string, any>, key?: string) {
    if (
      typeof type !== "string" ||
      !p ||
      typeof p !== "object" ||
      Array.isArray(p)
    )
      fail(400, "INVALID_INPUT", "Action and object payload are required");
    for (const field of [
      "description",
      "body",
      "action",
      "kind",
      "supersedesId",
      "source",
      "content",
      "evidence",
      "reason",
      "text",
      "title",
      "name",
      "path",
      "branch",
      "specName",
      "specDir",
      "answer",
      "bindingId",
      "issueId",
      "taskId",
      "projectId",
      "worktreeId",
      "agentId",
      "notificationId",
      "requestId",
      "runId",
      "id",
      "command",
      "outcome",
      "sourceId",
    ]) {
      if (
        p[field] !== undefined &&
        (typeof p[field] !== "string" ||
          p[field].length > (field === "content" ? 1000000 : 100000))
      )
        fail(
          400,
          "INVALID_INPUT",
          `${field} must be text within its size limit`,
        );
    }
    for (const field of [
      "dependencyIds",
      "artifactIds",
      "options",
      "attachments",
    ])
      if (p[field] !== undefined && !Array.isArray(p[field]))
        fail(400, "INVALID_INPUT", `${field} must be an array`);
    for (const field of ["read", "archived"])
      if (p[field] !== undefined && typeof p[field] !== "boolean")
        fail(400, "INVALID_INPUT", `${field} must be boolean`);
    if (
      p.revision !== undefined &&
      (!Number.isInteger(p.revision) || p.revision < 0)
    )
      fail(400, "INVALID_INPUT", "revision must be a nonnegative integer");
    const fp = hash(JSON.stringify({ type, p }));
    return this.store.change(
      (s) => {
        const result = this.apply(s, type, p);
        recompute(s);
        return result;
      },
      key,
      fp,
    );
  }
  apply(s: State, type: string, p: Record<string, any>): unknown {
    switch (type) {
      case "issue.create": {
        const i: Issue = {
          id: id(),
          number: `REL-${s.nextIssue++}`,
          title: text(p.title, "Title", 500),
          description: typeof p.description === "string" ? p.description : "",
          status: "Todo",
          createdAt: now(),
          updatedAt: now(),
          started: false,
          paused: false,
          revision: 0,
        };
        s.issues.push(i);
        for (const a of p.attachments || []) {
          if (
            !a ||
            typeof a.content !== "string" ||
            Buffer.from(a.content, "base64").length > 5 * 1024 * 1024 ||
            !/^[-\w+/]*={0,2}$/.test(a.content)
          )
            fail(400, "INVALID_INPUT", "Invalid attachment / maximum 5MB");
          s.attachments.push({
            id: id(),
            issueId: i.id,
            name: text(a.name, "Attachment name", 500),
            mime:
              typeof a.mime === "string" ? a.mime : "application/octet-stream",
            content: a.content,
            createdAt: now(),
          });
        }
        event(s, i.id, "Human", "issue.created", i.title);
        return i;
      }
      case "issue.update": {
        const i = find(s.issues, p.issueId);
        if (i.revision !== p.revision)
          fail(409, "STALE_VERSION", "Issue changed");
        i.title = text(p.title, "Title", 500);
        i.description = p.description || "";
        event(s, i.id, "Human", "issue.updated", i.title);
        wake(s, i.id);
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
      case "task.create": {
        const i = find(s.issues, p.issueId);
        if (i.status === "Done")
          fail(409, "DEPENDENCY_BLOCKED", "Reopen Issue first");
        if (p.bindingId) {
          const b = find(s.bindings, p.bindingId);
          if (b.issueId !== i.id || b.removed)
            fail(400, "INVALID_INPUT", "Invalid binding");
        }
        const deps = p.dependencyIds || [];
        if (
          !Array.isArray(deps) ||
          deps.some(
            (k: string) =>
              ![...s.tasks, ...s.requests].some(
                (x) => x.id === k && x.issueId === i.id,
              ),
          )
        )
          fail(400, "INVALID_INPUT", "Invalid dependencies");
        return task(s, i.id, p.text, {
          bindingId: p.bindingId,
          dependencyIds: deps,
          sourceId: p.sourceId,
        });
      }
      case "task.cancel": {
        const t = find(s.tasks, p.taskId);
        if (["running", "unknown"].includes(t.status))
          fail(409, "RESULT_UNKNOWN", "Stop / reconcile run first");
        t.status = "cancelled";
        t.reason = text(p.reason, "Cancellation reason");
        event(s, t.issueId, "Human", "task.cancelled", t.reason, {
          taskId: t.id,
        });
        return t;
      }
      case "task.retry": {
        const t = find(s.tasks, p.taskId);
        if (s.runs.some((r) => r.taskId === t.id && activeRun(r)))
          fail(409, "RESULT_UNKNOWN", "Verify old execution first");
        if (find(s.issues, t.issueId).status === "Done")
          fail(409, "DEPENDENCY_BLOCKED", "Reopen Issue first");
        t.reason = text(p.reason, "Retry evidence");
        if (t.attempts >= 8) t.attempts = 0;
        t.status = "pending";
        t.retryAt = 0;
        event(s, t.issueId, "Human", "task.retry", t.reason, { taskId: t.id });
        return t;
      }
      case "project.create": {
        const r = repository(p.path);
        if (s.projects.some((x) => x.path === r.path))
          fail(409, "DUPLICATE_PROJECT", "Directory already registered");
        const project = {
          id: id(),
          name: text(p.name, "Project name", 500),
          path: r.path,
          commonDir: r.commonDir,
          health: r.dirty ? "needs attention" : "healthy",
          healthReason: r.dirty
            ? "Uncommitted changes found; verify existing work before execution"
            : "Git directory verified",
          checkedAt: now(),
        };
        s.projects.push(project);
        return project;
      }
      case "worktree.create": {
        const project = find(s.projects, p.projectId);
        const r = repository(p.path);
        if (r.commonDir !== project.commonDir)
          fail(
            422,
            "INVALID_REPOSITORY",
            "Worktree belongs to another Project",
          );
        if (r.branch !== p.branch)
          fail(
            422,
            "BRANCH_MISMATCH",
            `Actual branch: ${r.branch || "(detached)"}`,
          );
        if (s.worktrees.some((w) => w.path === r.path))
          fail(409, "DUPLICATE_WORKTREE", "Directory already registered");
        const w = {
          id: id(),
          projectId: project.id,
          path: r.path,
          name: text(p.name, "Name", 500),
          branch: text(p.branch, "Branch", 500),
          specName: text(p.specName, "Spec name", 500),
          specDir: text(p.specDir, "Spec relative directory", 500),
        };
        specPath(w, "product");
        s.worktrees.push(w);
        return w;
      }
      case "binding.save": {
        find(s.issues, p.issueId);
        const project = find(s.projects, p.projectId),
          w = find(s.worktrees, p.worktreeId),
          a = find(s.agents, p.agentId);
        if (w.projectId !== project.id)
          fail(
            422,
            "INVALID_REPOSITORY",
            "Worktree belongs to another Project",
          );
        if (a.status === "missing")
          fail(503, "AGENT_UNAVAILABLE", "Tool is not installed");
        validateWorktree(w, project);
        if (
          s.bindings.some(
            (b) =>
              !b.removed &&
              b.id !== p.id &&
              b.issueId === p.issueId &&
              b.projectId === p.projectId &&
              b.worktreeId === p.worktreeId &&
              b.agentId === p.agentId,
          )
        )
          fail(
            409,
            "DUPLICATE_BINDING",
            "Edit the existing routing description",
          );
        const old = p.id ? find(s.bindings, p.id) : undefined;
        if (old && (old.issueId !== p.issueId || old.removed))
          fail(400, "INVALID_INPUT", "Invalid binding");
        if (old && old.revision !== p.revision)
          fail(409, "STALE_VERSION", "Binding changed");
        const b: Binding = {
          id: old?.id || id(),
          issueId: p.issueId,
          projectId: project.id,
          worktreeId: w.id,
          agentId: a.id,
          description: text(p.description, "Routing description"),
          revision: (old?.revision ?? -1) + 1,
          removed: false,
        };
        if (old) {
          Object.assign(old, b);
          for (const t of s.tasks.filter(
            (t) =>
              t.bindingId === b.id &&
              !["running", "unknown", "done", "cancelled"].includes(t.status),
          )) {
            t.bindingId = undefined;
            t.status = "pending";
          }
        } else s.bindings.push(b);
        event(
          s,
          b.issueId,
          "Human",
          old ? "binding.updated" : "binding.created",
          `${a.name} · ${project.name} · ${w.branch} · ${b.description}`,
          { bindingId: b.id, data: { ...b, path: w.path } },
        );
        wake(s, b.issueId);
        return b;
      }
      case "binding.remove": {
        const b = find(s.bindings, p.bindingId);
        if (s.runs.some((r) => r.bindingId === b.id && activeRun(r)))
          fail(
            409,
            "RESULT_UNKNOWN",
            "Stop / verify current run before removing",
          );
        b.removed = true;
        b.revision++;
        for (const t of s.tasks.filter(
          (t) =>
            t.bindingId === b.id && !["done", "cancelled"].includes(t.status),
        )) {
          t.bindingId = undefined;
          t.status = "pending";
          t.reason = "Binding removed; pending reassignment";
        }
        event(
          s,
          b.issueId,
          "Human",
          "binding.removed",
          text(p.reason, "Removal reason"),
          { bindingId: b.id },
        );
        return b;
      }
      case "issue.control": {
        const i = find(s.issues, p.issueId);
        switch (p.command) {
          case "start":
            if (i.status === "Done")
              fail(409, "DEPENDENCY_BLOCKED", "Reopen first");
            if (!i.started) {
              i.started = true;
              task(s, i.id, `${i.title}\n\n${i.description}`, {
                sourceId: i.id,
              });
            }
            i.paused = false;
            wake(s, i.id);
            break;
          case "pause":
            i.paused = true;
            break;
          case "resume":
            if (!i.started || i.status === "Done")
              fail(409, "DEPENDENCY_BLOCKED", "Issue is not active");
            i.paused = false;
            i.runBudgetStart = s.runs.filter((r) => r.issueId === i.id).length;
            wake(s, i.id);
            break;
          case "stop":
            i.paused = true;
            text(p.text, "Correction");
            for (const r of s.runs.filter(
              (r) =>
                r.issueId === i.id &&
                ["starting", "running"].includes(r.status),
            ))
              r.status = "stopping";
            task(s, i.id, p.text, { sourceId: i.id });
            break;
          case "reopen":
            if (i.status !== "Done")
              fail(409, "DEPENDENCY_BLOCKED", "Only Done Issue can reopen");
            i.status = "In progress";
            i.runBudgetStart = s.runs.filter((r) => r.issueId === i.id).length;
            i.started = true;
            i.paused = true;
            task(s, i.id, text(p.text, "Revised goal"), { sourceId: i.id });
            break;
          case "final": {
            const current = s.requests.find(
              (r) =>
                r.issueId === i.id &&
                r.kind === "final" &&
                r.status === "Pending",
            );
            const previous = s.requests.findLast(
              (r) =>
                r.issueId === i.id &&
                r.kind === "final" &&
                ["Changes requested", "Cancelled"].includes(r.status) &&
                !r.supersededById,
            );
            finalReady(s, i.id, current?.id || previous?.id);
            if (!current)
              makeRequest(s, {
                issueId: i.id,
                kind: "final",
                title: "Final acceptance",
                body: "Review completed work and verification evidence. Agent reports are not independently verified.",
                artifactIds: s.artifacts
                  .filter((a) => a.issueId === i.id)
                  .map((a) => a.id),
                scope: "issue",
                action: "Accept current Issue as Done",
                source: "Triage",
                supersedesId: previous?.id,
              });
            break;
          }
          default:
            fail(400, "INVALID_INPUT", "Unknown control");
        }
        event(s, i.id, "Human", `issue.${p.command}`, p.text || p.command);
        return i;
      }
      case "artifact.publish":
        return artifact(s, p as any);
      case "request.create":
        if (p.kind === "final")
          fail(400, "INVALID_INPUT", "Use final acceptance control");
        return makeRequest(s, p as any);
      case "request.decide": {
        const r = find(s.requests, p.requestId);
        if (r.status !== "Pending")
          fail(
            409,
            "REQUEST_RESOLVED",
            "Request has already been resolved or replaced",
            { request: r },
          );
        if (p.revision !== r.revision)
          fail(409, "STALE_VERSION", "Request changed");
        if (r.kind === "input") {
          if (!["answer", "cancel"].includes(p.decision))
            fail(400, "INVALID_INPUT", "Input requires an answer");
          if (p.decision === "answer") {
            r.answer = text(p.answer, "Answer");
            if (
              r.options?.length &&
              !r.options.some((o) => o.value === r.answer)
            )
              fail(400, "INVALID_INPUT", "Choose a listed option");
            if (r.routeTask && r.taskId) {
              const b = find(s.bindings, r.answer);
              if (b.removed || b.issueId !== r.issueId)
                fail(409, "STALE_VERSION", "Binding is no longer valid");
              find(s.tasks, r.taskId).bindingId = b.id;
            }
            r.status = "Answered";
            for (const resolver of s.tasks.filter(
              (t) =>
                t.requestId === r.id &&
                !["running", "unknown"].includes(t.status),
            ))
              resolver.status = "done";
          }
        } else {
          if (!["approve", "changes", "cancel"].includes(p.decision))
            fail(400, "INVALID_INPUT", "Approval requires Human decision");
          if (p.decision === "approve") {
            if (r.kind === "final") {
              finalReady(s, r.issueId, r.id);
              find(s.issues, r.issueId).status = "Done";
            }
            r.status = "Approved";
          } else if (p.decision === "changes") {
            r.answer = text(p.answer, "Changes requested");
            r.status = "Changes requested";
            task(s, r.issueId, `Revise proposal: ${r.title}\n${r.answer}`, {
              sourceId: r.id,
            });
          }
        }
        if (p.decision === "cancel") {
          r.answer = text(p.answer, "Cancellation reason");
          r.status = "Cancelled";
        }
        r.decision = p.decision;
        r.decidedBy = "Human";
        r.decidedAt = now();
        r.revision++;
        for (const n of s.notifications.filter((n) => n.requestId === r.id)) {
          n.archived = true;
          n.read = true;
        }
        event(
          s,
          r.issueId,
          "Human",
          `request.${p.decision}`,
          r.answer || `${r.action} · ${r.artifactIds.join(", ")}`,
          { requestId: r.id, taskId: r.taskId },
        );
        wake(s, r.issueId);
        return r;
      }
      case "notification.update": {
        const n = find(s.notifications, p.notificationId);
        if (typeof p.read === "boolean") n.read = p.read;
        if (typeof p.archived === "boolean") n.archived = p.archived;
        return n;
      }
      case "run.reconcile": {
        const r = find(s.runs, p.runId);
        if (r.status !== "unknown")
          fail(409, "RESULT_UNKNOWN", "Only unknown run can be reconciled");
        if (!["completed", "failed", "stopped"].includes(p.outcome))
          fail(400, "INVALID_INPUT", "Invalid outcome");
        r.result = text(p.evidence, "Verification evidence");
        r.status = p.outcome;
        artifact(s, {
          issueId: r.issueId,
          runId: r.id,
          bindingId: r.bindingId,
          kind: "report",
          title: "Human verification of execution",
          content: r.result,
        });
        r.finishedAt = now();
        const t = find(s.tasks, r.taskId);
        t.status = p.outcome === "completed" ? "done" : "waiting";
        t.reason = "Execution failed or stopped; explicit retry required";
        this.store.db.prepare("DELETE FROM locks WHERE run_id=?").run(r.id);
        event(s, r.issueId, "Human", "run.reconciled", r.result, {
          runId: r.id,
        });
        return r;
      }
      default:
        return fail(400, "INVALID_INPUT", "Unknown action");
    }
  }
  recover() {
    this.store.change((s) => {
      for (const r of s.runs.filter(activeRun)) {
        if (r.status === "unknown") continue;
        r.status = "unknown";
        r.reason =
          "Service restarted; verify process and worktree before retry";
        find(s.tasks, r.taskId).status = "unknown";
        event(s, r.issueId, "System", "run.unknown", r.reason, { runId: r.id });
      }
      recompute(s);
    });
  }
}
