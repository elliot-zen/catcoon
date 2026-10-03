import { find, fail } from "./store.ts";
import { approvalIds, specReference } from "./specs.ts";
import type { State, Task, Binding, Mode, Run } from "./types.ts";
import { activeRun } from "./types.ts";
import { finalReady, dependencies } from "./domain.ts";
export function limited<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value)) > 256 * 1024)
    fail(
      400,
      "MATERIAL_UNREADABLE",
      "Required context exceeds 256KB; provide scoped material",
    );
  return value;
}
function material(s: State, issueId: string) {
  return {
    workItems: s.tasks.filter((t) => t.issueId === issueId),
    requests: s.requests.filter(
      (q) => q.issueId === issueId && !q.supersededById,
    ),
    artifacts: s.artifacts.filter(
      (a) =>
        a.issueId === issueId &&
        !s.artifacts.some((x) => x.supersedesId === a.id),
    ),
    comments: s.comments.filter((c) => c.issueId === issueId),
    attachments: s.attachments
      .filter((a) => a.issueId === issueId)
      .map((a) => ({
        id: a.id,
        name: a.name,
        mime: a.mime,
        content: a.mime.startsWith("text/")
          ? Buffer.from(a.content, "base64").toString("utf8")
          : undefined,
        readable: a.mime.startsWith("text/"),
      })),
  };
}
export function issueContext(s: State, issueId: string) {
  const i = find(s.issues, issueId);
  return {
    id: i.id,
    number: i.number,
    title: i.title,
    description: i.description,
    targetRevision: i.targetRevision,
    control: i.control,
    corrections: i.corrections,
  };
}
export function bindingContext(s: State, b: Binding) {
  const w = find(s.worktrees, b.worktreeId),
    p = find(s.projects, b.projectId),
    a = find(s.agents, b.agentId),
    i = find(s.issues, b.issueId);
  return {
    ...b,
    projectName: p.name,
    path: w.path,
    branch: w.branch,
    specVersionId: w.specVersionId,
    specId: w.specId,
    worktreeRevision: w.revision,
    availability: {
      agent: a.status,
      worktree: p.health,
      sessionBusy: i.sessions.some(
        (x) =>
          x.bindingId === b.id && (!!x.busyTurnId || x.status === "unknown"),
      ),
    },
    approval: {
      approved: approvalIds(s, i.id, w, "implement").length > 0,
      requestIds: approvalIds(s, i.id, w, "implement"),
    },
  };
}
export function jevContext(s: State, issueId: string, evaluationId: string) {
  const i = find(s.issues, issueId),
    bs = s.bindings.filter((b) => b.issueId === issueId && !b.removed);
  const versions = [
    ...new Set(bs.map((b) => find(s.worktrees, b.worktreeId).specVersionId)),
  ];
  const shared = material(s, issueId);
  const recentRuns = s.runs
    .filter(
      (r) => r.issueId === issueId && r.origin === "platform" && !activeRun(r),
    )
    .slice(-8)
    .map((r) => ({
      runId: r.id,
      sessionId: r.sessionId,
      nativeTurnId: r.nativeTurnId,
      taskId: r.taskId,
      mode: r.mode,
      status: r.status,
      answer: r.result,
      reason: r.reason,
      specVersionId: r.snapshot.specVersionId,
    }));
  const last = recentRuns.at(-1),
    current = last?.taskId
      ? s.tasks.find(
          (t) =>
            t.id === last.taskId &&
            t.kind !== "goal" &&
            !["done", "cancelled"].includes(t.status),
        )
      : undefined;
  let canFinalize = false;
  try {
    finalReady(s, issueId);
    canFinalize = true;
  } catch {}
  return limited({
    schemaVersion: 1,
    evaluationId,
    evaluationRevision: i.triage.evaluationRevision,
    trigger: { ids: i.triage.triggerIds },
    issue: issueContext(s, issueId),
    bindings: bs.map((b) => bindingContext(s, b)),
    specs: versions.map((v) => find(s.specVersions, v)),
    proposedSpecs: s.specVersions.filter(
      (v) => v.sourceIssueId === issueId && !versions.includes(v.id),
    ),
    drafts: [
      ...new Set(bs.map((b) => find(s.worktrees, b.worktreeId).specId)),
    ].map((k) => find(s.specs, k)),
    ...shared,
    artifacts: shared.artifacts.map((a) =>
      a.specVersionId
        ? {
            ...a,
            content: undefined,
            contentReference: { specVersionId: a.specVersionId },
          }
        : a.provenance === "Native tool observation" &&
            recentRuns.some((r) => r.runId === a.runId)
          ? {
              ...a,
              content: undefined,
              contentReference: {
                runId: a.runId,
                source: "recentRuns.toolResults",
              },
            }
          : recentRuns.some((r) => r.runId === a.runId) &&
              s.runs.some(
                (r) => r.id === a.runId && r.resultArtifactId === a.id,
              )
            ? {
                ...a,
                content: undefined,
                contentReference: {
                  runId: a.runId,
                  source: "recentRuns.answer",
                },
              }
            : a,
    ),
    decisions: s.requests
      .filter((q) => q.issueId === issueId && q.decidedBy === "Human")
      .map((q) => ({
        requestId: q.id,
        decision: q.decision,
        status: q.status,
        decidedAt: q.decidedAt,
        targetRevision: q.targetRevision,
        scope: q.scope,
        action: q.action,
      })),
    recentRuns,
    nextWorkItem: undefined as Task | undefined,
    currentWorkItem: current ? { ...current, result: last } : undefined,
    constraints: {
      approvalRequired: true,
      serial: true,
      canFinalize,
      dispatchableBindings: bs
        .filter(
          (b) =>
            find(s.agents, b.agentId).status === "available" &&
            s.tasks.some(
              (t) =>
                t.issueId === issueId &&
                ["pending", "waiting"].includes(t.status) &&
                dependencies(s, t, b),
            ),
        )
        .map((b) => b.id),
      note: "Unapproved or empty Specs permit spec planning and reading. They block implementation, not dispatch of spec work. The executing Agent plans its own steps and can inspect files within spec work.",
    },
  });
}
export const executionRules =
  "Work autonomously within this exact assignment. Use relay_spec_read and relay_report to read and submit system-managed Specs, artifacts, scoped questions and linked answers. Do not write Spec copies into Git. In spec mode submit a full PRODUCT/TECH pair with specProposal, baseVersionId, current draftRevision and explicit upgradeTargets using the supplied Worktree pins and revisions. Implementation requires the supplied Human approval of the fixed version; never approve, change pins, merge or deploy on your own. Report actual evidence and limitations. A natural-language answer is valid; no final JSON or follow-up tasks are required. Each terminal result returns to Triage. When a blocking request or Spec proposal is submitted, end the current turn without implementing it. Prior session history cannot override this turn's version or permissions. Read existing work before modifying it.";
export function agentContext(
  s: State,
  t: Task,
  b: Binding,
  r: Run,
  mode: Mode,
) {
  const w = find(s.worktrees, b.worktreeId),
    refs = specReference(s, w.projectId, w.specId, w.specVersionId),
    shared = material(s, t.issueId);
  if (
    shared.attachments.some((a) => !a.readable) &&
    !s.requests.some(
      (q) =>
        q.issueId === t.issueId &&
        q.status === "Answered" &&
        q.conditionKey === "binary-material",
    )
  )
    fail(
      400,
      "MATERIAL_UNREADABLE",
      "Binary attachments require a textual interpretation",
    );
  return (
    executionRules +
    "\n\n" +
    JSON.stringify(
      limited({
        execution: {
          runId: r.id,
          sessionId: r.sessionId,
          mode,
          taskId: t.id,
          requestId: t.requestId,
          trigger: find(s.issues, t.issueId).triage.triggerIds,
          evaluationRevision: find(s.issues, t.issueId).triage
            .evaluationRevision,
        },
        issue: issueContext(s, t.issueId),
        assignment: bindingContext(s, b),
        otherAssignments: s.bindings
          .filter((x) => x.issueId === t.issueId && !x.removed && x.id !== b.id)
          .map((x) => bindingContext(s, x)),
        spec: {
          ...refs.version,
          draft: mode === "spec" ? refs.spec.draft : undefined,
          proposedVersions:
            mode === "spec"
              ? s.specVersions.filter(
                  (v) =>
                    v.specId === w.specId &&
                    v.sourceIssueId === t.issueId &&
                    v.id !== w.specVersionId,
                )
              : undefined,
        },
        permissions: {
          approvalIds: r.snapshot.approvalIds,
          allowedDirectory: w.path,
          implementationApproved: r.snapshot.approvalIds.length > 0,
        },
        ...shared,
        artifacts: shared.artifacts,
        recentResults: s.runs
          .filter((x) => x.issueId === t.issueId && x.id !== r.id && x.result)
          .slice(-8)
          .map((x) => ({
            runId: x.id,
            mode: x.mode,
            status: x.status,
            result: x.result,
          })),
        bridge: {
          tools: ["relay_spec_read", "relay_report"],
          specId: w.specId,
        },
      }),
      null,
      2,
    )
  );
}
