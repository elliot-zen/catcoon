import type {
  State,
  Worktree,
  SpecVersion,
  ApprovalAction,
  UpgradeTarget,
  Mode,
  Request,
} from "./types.ts";
import { activeRun, sessions } from "./types.ts";
import { id, now, hash, find, fail, text, Store } from "./store.ts";

export const pairHash = (product: string, tech: string) =>
  hash(JSON.stringify({ product, tech }));
export function createSpec(s: State, projectId: string, name: unknown) {
  find(s.projects, projectId);
  const specId = id(),
    versionId = id(),
    at = now();
  const version: SpecVersion = {
    id: versionId,
    specId,
    number: 1,
    product: "",
    tech: "",
    contentHash: pairHash("", ""),
    createdAt: at,
  };
  const spec = {
    id: specId,
    projectId,
    name: text(name, "Spec name", 500),
    draft: { product: "", tech: "", revision: 0, baseVersionId: versionId },
    latestVersionId: versionId,
    createdAt: at,
    updatedAt: at,
  };
  s.specs.push(spec);
  s.specVersions.push(version);
  return { spec, initialVersion: version };
}
export function specReference(
  s: State,
  projectId: string,
  specId: unknown,
  versionId: unknown,
) {
  const spec = find(s.specs, specId),
    version = find(s.specVersions, versionId);
  if (spec.projectId !== projectId || version.specId !== spec.id)
    fail(
      422,
      "SPEC_PROJECT_MISMATCH",
      "Spec and version must belong to this project",
    );
  return { spec, version };
}
export function readDocument(
  s: State,
  specId: unknown,
  document: unknown,
  versionId?: unknown,
) {
  if (document !== "product" && document !== "tech")
    fail(400, "INVALID_INPUT", "document must be product or tech");
  const spec = find(s.specs, specId);
  if (versionId) {
    const v = find(s.specVersions, versionId);
    if (v.specId !== spec.id)
      fail(422, "SPEC_PROJECT_MISMATCH", "Version belongs to another Spec");
    return {
      specId: spec.id,
      versionId: v.id,
      document,
      content: v[document as "product" | "tech"],
      contentHash: v.contentHash,
    };
  }
  return {
    specId: spec.id,
    document,
    content: spec.draft[document as "product" | "tech"],
    draftRevision: spec.draft.revision,
    baseVersionId: spec.draft.baseVersionId,
  };
}
export function bodyText(content: unknown) {
  if (typeof content !== "string" || Buffer.byteLength(content) > 1024 * 1024)
    fail(400, "INVALID_INPUT", "Document must be text, maximum 1MB");
  return content as string;
}
export function saveDraft(s: State, p: any) {
  const current = readDocument(s, p.specId, p.document);
  const spec = find(s.specs, p.specId);
  if (spec.draft.revision !== p.draftRevision)
    fail(
      409,
      "SPEC_CONFLICT",
      "Shared draft changed; compare before saving",
      current,
    );
  spec.draft[p.document as "product" | "tech"] = bodyText(p.content);
  spec.draft.revision++;
  spec.updatedAt = now();
  return readDocument(s, p.specId, p.document);
}
export function publishVersion(
  s: State,
  specId: string,
  draftRevision: number,
  source?: { issueId: string; runId: string },
) {
  const spec = find(s.specs, specId);
  if (spec.draft.revision !== draftRevision)
    fail(409, "SPEC_CONFLICT", "Shared draft changed", spec.draft);
  const version: SpecVersion = {
    id: id(),
    specId,
    number:
      Math.max(
        ...s.specVersions
          .filter((v) => v.specId === specId)
          .map((v) => v.number),
      ) + 1,
    product: spec.draft.product,
    tech: spec.draft.tech,
    contentHash: pairHash(spec.draft.product, spec.draft.tech),
    createdAt: now(),
    previousVersionId: spec.draft.baseVersionId,
    sourceIssueId: source?.issueId,
    sourceRunId: source?.runId,
  };
  s.specVersions.push(version);
  spec.latestVersionId = version.id;
  spec.draft.baseVersionId = version.id;
  return version;
}
export function directoryIdle(store: Store, s: State, w: Worktree) {
  if (
    s.runs.some((r) => r.snapshot.path === w.path && activeRun(r)) ||
    sessions(s).some(
      (x) => x.path === w.path && (x.busyTurnId || x.status === "unknown"),
    ) ||
    store.db.prepare("SELECT run_id FROM locks WHERE path=?").get(w.path)
  )
    fail(
      409,
      "WORKTREE_BUSY",
      "Stop and verify this Worktree before changing its Spec version",
    );
}
export function approvalIds(
  s: State,
  issueId: string,
  w: Worktree,
  mode: Mode,
  taskId?: string,
) {
  const issue = find(s.issues, issueId);
  return s.requests
    .filter((q) => {
      const a = q.action;
      if (
        q.issueId !== issueId ||
        q.status !== "Approved" ||
        q.decidedBy !== "Human" ||
        q.targetRevision !== issue.targetRevision ||
        !a ||
        !["approve_spec", "approve_spec_and_upgrade"].includes(a.type)
      )
        return false;
      const action = a as Extract<
        ApprovalAction,
        { type: "approve_spec" | "approve_spec_and_upgrade" }
      >;
      const targets =
        action.type === "approve_spec"
          ? action.worktreeIds
          : action.targets.map((t) => t.worktreeId);
      return (
        action.specVersionId === w.specVersionId &&
        targets.includes(w.id) &&
        action.allowedModes.includes(mode) &&
        (q.scope === "issue" ||
          q.scope.worktreeIds.includes(w.id) ||
          q.scope.bindingIds.some((b) =>
            s.bindings.some((x) => x.id === b && x.worktreeId === w.id),
          ) ||
          (!!taskId && q.scope.taskIds.includes(taskId)))
      );
    })
    .map((q) => q.id);
}
export function assertApproved(
  s: State,
  issueId: string,
  w: Worktree,
  mode: Mode,
  taskId?: string,
) {
  if (
    ["implement", "verify", "revise"].includes(mode) &&
    !approvalIds(s, issueId, w, mode, taskId).length
  )
    fail(
      409,
      "APPROVAL_REQUIRED",
      "This fixed Spec version needs Human approval for this Issue and scope",
    );
}
export function approveSpec(store: Store, s: State, q: Request) {
  const a = q.action;
  if (!a || !["approve_spec", "approve_spec_and_upgrade"].includes(a.type))
    return;
  if (q.targetRevision !== find(s.issues, q.issueId).targetRevision)
    fail(409, "STALE_VERSION", "Issue target changed");
  const action = a as Extract<
    ApprovalAction,
    { type: "approve_spec" | "approve_spec_and_upgrade" }
  >;
  const v = find(s.specVersions, action.specVersionId);
  if (!v.product.trim() || !v.tech.trim())
    fail(
      400,
      "MATERIAL_UNREADABLE",
      "Both Spec documents must be readable before implementation",
    );
  const targets =
    action.type === "approve_spec_and_upgrade"
      ? action.targets
      : action.worktreeIds.map((worktreeId) => ({ worktreeId }));
  for (const target of targets) {
    const w = find(s.worktrees, target.worktreeId);
    specReference(s, w.projectId, w.specId, v.id);
    if (action.type === "approve_spec_and_upgrade") {
      const t = target as UpgradeTarget;
      if (
        w.specVersionId !== t.fromVersionId ||
        w.revision !== t.worktreeRevision
      )
        fail(409, "STALE_VERSION", "Worktree fixed version changed");
      directoryIdle(store, s, w);
    }
  }
  if (action.type === "approve_spec_and_upgrade")
    for (const target of action.targets) {
      const w = find(s.worktrees, target.worktreeId);
      w.specVersionId = v.id;
      w.revision++;
      for (const b of s.bindings.filter(
        (b) => b.worktreeId === w.id && !b.removed,
      ))
        dirty(s, b.issueId, "spec.upgraded");
    }
}
export function dirty(s: State, issueId: string, trigger: string) {
  const i = find(s.issues, issueId);
  i.triage.dirty = true;
  i.triage.evaluationRevision++;
  i.triage.triggerIds = [...new Set([...i.triage.triggerIds, trigger])];
}
