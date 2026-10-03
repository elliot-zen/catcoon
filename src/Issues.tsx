import { useState } from "react";
import {
  Plus,
  Paperclip,
  Maximize2,
  Minimize2,
  Check,
  Circle,
  CircleDot,
  Bot,
  GitBranch,
  UserRound,
  ArrowUp,
  MoreHorizontal,
  Copy,
  ShieldCheck,
} from "lucide-react";
import type { State, Issue, Binding, Request } from "../server/types";
import { activeRun } from "../server/types";
import {
  Button,
  Modal,
  Field,
  Empty,
  RequestCard,
  ArtifactView,
} from "./components";
import { useDraft } from "./api";
import type { Action } from "./api";
import type { T } from "./i18n";
export const statuses = ["Human input", "In progress", "Todo", "Done"];
export function StatusIcon({ status }: { status: string }) {
  return status === "Done" ? (
    <span className="flex size-4 items-center justify-center rounded-full bg-indigo-500 text-white">
      <Check size={10} />
    </span>
  ) : status === "Todo" ? (
    <Circle size={15} className="text-zinc-400" />
  ) : (
    <CircleDot
      size={15}
      className={
        status === "Human input" ? "text-violet-500" : "text-amber-500"
      }
    />
  );
}
export function IssueCreate({
  action,
  t,
  onClose,
  onCreate,
}: {
  action: Action;
  t: T;
  onClose: () => void;
  onCreate: (i: Issue, more: boolean) => void;
}) {
  const [title, setTitle] = useDraft("new:title"),
    [description, setDescription] = useDraft("new:description");
  const [more, setMore] = useState(false),
    [expanded, setExpanded] = useState(false),
    [pending, setPending] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState("");
  const dismiss = () => {
    if (
      !pending &&
      !uploading &&
      (!attachments.length || confirm(t("Discard unsaved attachments?")))
    )
      onClose();
  };
  const [attachments, setAttachments] = useState<
    { name: string; mime: string; content: string }[]
  >([]);
  return (
    <Modal title={t("New issue")} wide={expanded} onClose={dismiss}>
      <input
        className="w-full bg-transparent text-lg font-semibold outline-none"
        autoFocus
        placeholder={t("Issue title")}
        aria-label={t("Issue title")}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        className={`mt-4 w-full resize-none bg-transparent leading-6 outline-none ${expanded ? "min-h-72" : "min-h-32"}`}
        placeholder={t("Add description…")}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <div className="mb-4 flex items-center gap-2">
        <label className="btn cursor-pointer">
          <Paperclip size={15} />
          {t("Attachments")}
          <input
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              for (const f of files) {
                if (f.size > 5 * 1024 * 1024) {
                  setUploadError(t("Maximum 5MB"));
                  continue;
                }
                setUploading((n) => n + 1);
                const reader = new FileReader();
                reader.onloadend = () => setUploading((n) => n - 1);
                reader.onerror = () =>
                  setUploadError(t("Attachment read failed"));
                reader.onload = () =>
                  setAttachments((prev) => [
                    ...prev,
                    {
                      name: f.name,
                      mime: f.type,
                      content: String(reader.result).split(",")[1],
                    },
                  ]);
                reader.readAsDataURL(f);
              }
            }}
          />
        </label>
        <Button
          className="ml-auto"
          aria-label={t(expanded ? "Collapse" : "Expand")}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </Button>
      </div>
      {uploading > 0 && <p className="text-xs muted">{t("Loading…")}</p>}
      {uploadError && (
        <p role="alert" className="text-xs text-rose-500">
          {uploadError}
        </p>
      )}
      {attachments.map((a, n) => (
        <div key={n} className="mb-2 flex items-center text-xs muted">
          <Paperclip size={12} />
          {a.name}
          <Button
            className="ml-auto"
            onClick={() =>
              setAttachments(attachments.filter((_, i) => i !== n))
            }
          >
            {t("Remove")}
          </Button>
        </div>
      ))}
      <footer className="flex items-center gap-2 border-t border-border pt-4">
        <label className="flex items-center gap-2 text-xs muted">
          <input
            type="checkbox"
            checked={more}
            onChange={(e) => setMore(e.target.checked)}
          />
          {t("Create more")}
        </label>
        <Button className="ml-auto" onClick={dismiss}>
          {t("Cancel")}
        </Button>
        <Button
          variant="primary"
          disabled={pending || uploading > 0 || !title.trim()}
          onClick={() => {
            setPending(true);
            void action("issue.create", { title, description, attachments })
              .then((i) => {
                setTitle("");
                setDescription("");
                setAttachments([]);
                onCreate(i, more);
              })
              .catch(() => {})
              .finally(() => setPending(false));
          }}
        >
          {t("Create issue")}
        </Button>
      </footer>
    </Modal>
  );
}
export function Issues({
  state: s,
  t,
  onOpen,
  onCreate,
  search,
}: {
  state: State;
  t: T;
  onOpen: (id: string) => void;
  onCreate: () => void;
  search?: string;
}) {
  const [view, setView] = useState("Active");
  const visible = s.issues.filter((i) =>
    search !== undefined
      ? !!search.trim() &&
        [
          i.number,
          i.title,
          ...s.bindings
            .filter((b) => b.issueId === i.id && !b.removed)
            .map(
              (b) => s.projects.find((p) => p.id === b.projectId)?.name || "",
            ),
        ]
          .join("\n")
          .toLowerCase()
          .includes(search.trim().toLowerCase())
      : view === "All issues" ||
        (view === "Backlog"
          ? i.status === "Todo"
          : ["In progress", "Human input"].includes(i.status)),
  );
  return (
    <>
      {search === undefined && (
        <div className="flex items-center gap-2 border-b border-border px-5 py-3">
          {["Active", "Backlog", "All issues"].map((v) => (
            <Button
              key={v}
              className={view === v ? "bg-muted text-foreground" : ""}
              onClick={() => setView(v)}
            >
              {t(v)}
            </Button>
          ))}
          <Button className="ml-auto" variant="outline" onClick={onCreate}>
            <Plus size={12} />
            {t("New issue")}
          </Button>
        </div>
      )}
      {!visible.length && (
        <Empty>
          {search !== undefined && !search.trim()
            ? t("Search by number, title or project")
            : s.issues.length
              ? t("No issues found")
              : t("Create your first issue")}
        </Empty>
      )}
      {statuses.map((status) => {
        const rows = visible
          .filter((i) => i.status === status)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return rows.length ? (
          <section key={status}>
            <div className="flex items-center gap-2 border-y border-border bg-muted/50 px-6 py-2 text-xs">
              <StatusIcon status={status} />
              <span className="font-medium">{t(status)}</span>
              <span className="muted">{rows.length}</span>
              <Button
                className="ml-auto py-0"
                aria-label={t("New issue")}
                onClick={onCreate}
              >
                <Plus size={13} />
              </Button>
            </div>
            {rows.map((i) => {
              const bs = s.bindings.filter(
                (b) => b.issueId === i.id && !b.removed,
              );
              return (
                <button
                  key={i.id}
                  className="flex w-full items-center gap-3 border-b border-border px-6 py-3 text-left hover:bg-muted"
                  onClick={() => onOpen(i.id)}
                >
                  <span className="w-20 shrink-0 text-[11px] muted">
                    {i.number}
                  </span>
                  <StatusIcon status={i.status} />
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {i.title}
                  </span>
                  <span className="hidden max-w-56 truncate text-[11px] muted sm:block">
                    {[
                      ...new Set(
                        bs.map(
                          (b) => s.agents.find((a) => a.id === b.agentId)?.name,
                        ),
                      ),
                    ].join(", ")}
                  </span>
                  <span className="shrink-0 text-[10px] muted">
                    {new Date(i.updatedAt).toLocaleString()}
                  </span>
                </button>
              );
            })}
          </section>
        ) : null;
      })}
    </>
  );
}
export function BindingDialog({
  issueId,
  state: s,
  action,
  t,
  onClose,
  binding,
}: {
  issueId: string;
  state: State;
  action: Action;
  t: T;
  onClose: () => void;
  binding?: Binding;
}) {
  const [projectId, setProject] = useState(binding?.projectId || ""),
    [worktreeId, setTree] = useState(binding?.worktreeId || ""),
    [agentId, setAgent] = useState(binding?.agentId || "");
  const [description, setDescription] = useState(binding?.description || ""),
    [pending, setPending] = useState(false);
  const trees = s.worktrees.filter((w) => w.projectId === projectId);
  return (
    <Modal title={t(binding ? "Edit" : "Bind agent")} onClose={onClose}>
      <div className="space-y-4">
        <Field label={t("Agent")}>
          <select
            className="field"
            value={agentId}
            onChange={(e) => setAgent(e.target.value)}
          >
            <option value="">{t("No selection")}</option>
            {s.agents
              .filter((a) => a.status !== "missing")
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.status}
                </option>
              ))}
          </select>
        </Field>
        <Field label={t("Project")}>
          <select
            className="field"
            value={projectId}
            onChange={(e) => {
              setProject(e.target.value);
              setTree("");
            }}
          >
            <option value="">{t("No selection")}</option>
            {s.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("Worktree")}>
          <select
            className="field"
            value={worktreeId}
            onChange={(e) => setTree(e.target.value)}
          >
            <option value="">{t("No selection")}</option>
            {trees.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} · {w.branch}
              </option>
            ))}
          </select>
        </Field>
        {projectId && !trees.length && (
          <p className="text-xs muted">
            {t("No worktrees in this project")} ·{" "}
            <a className="underline" href={`#project/${projectId}`}>
              {t("Manage projects")}
            </a>
          </p>
        )}
        <Field label={t("Triage routing description")}>
          <textarea
            className="field min-h-28"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        {binding && (
          <p className="text-xs muted">
            {t("Pause prevents new dispatch; existing runs may continue.")}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button
            variant="primary"
            disabled={
              pending ||
              !projectId ||
              !worktreeId ||
              !agentId ||
              !description.trim()
            }
            onClick={() => {
              setPending(true);
              void action("binding.save", {
                issueId,
                id: binding?.id,
                revision: binding?.revision,
                projectId,
                worktreeId,
                agentId,
                description,
              })
                .then(onClose)
                .catch(() => {})
                .finally(() => setPending(false));
            }}
          >
            {t(binding ? "Save" : "Bind agent")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
function Composer({
  issueId,
  state: s,
  action,
  t,
  mode,
  onClose,
}: {
  issueId: string;
  state: State;
  action: Action;
  t: T;
  mode: string;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(""),
    [body, setBody] = useState(""),
    [kind, setKind] = useState("report"),
    [actionText, setAction] = useState(""),
    [refs, setRefs] = useState<string[]>([]),
    [bindingId, setBinding] = useState(""),
    [scope, setScope] = useState("issue"),
    [deps, setDeps] = useState<string[]>([]),
    [old, setOld] = useState(""),
    [oldRequest, setOldRequest] = useState(""),
    [pending, setPending] = useState(false);
  const tasks = s.tasks.filter(
    (x) => x.issueId === issueId && !["done", "cancelled"].includes(x.status),
  );
  const fields = mode === "Publish artifact";
  const isTask = mode === "Submit task";
  const approval = mode === "Request approval";
  return (
    <Modal title={t(mode)} onClose={onClose}>
      <div className="space-y-4">
        {!isTask && (
          <Field
            label={t(
              approval || mode === "Request human input" ? "Question" : "Title",
            )}
          >
            <input
              className="field"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
        )}
        <Field label={t(isTask ? "Task description" : "Content")}>
          <textarea
            className="field min-h-32"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </Field>
        {fields && (
          <>
            <Field label={t("Kind")}>
              <select
                className="field"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
              >
                {["report", "spec", "contract", "code", "test"].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </Field>
            <Field label={t("Supersedes")}>
              <select
                className="field"
                value={old}
                onChange={(e) => setOld(e.target.value)}
              >
                <option value="">—</option>
                {s.artifacts
                  .filter((a) => a.issueId === issueId)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.title} · {a.version.slice(0, 10)}
                    </option>
                  ))}
              </select>
            </Field>
          </>
        )}
        {isTask && (
          <>
            <Field label={t("Assignments")}>
              <select
                className="field"
                value={bindingId}
                onChange={(e) => setBinding(e.target.value)}
              >
                <option value="">{t("Automatic routing")}</option>
                {s.bindings
                  .filter((b) => b.issueId === issueId && !b.removed)
                  .map((b) => (
                    <option key={b.id} value={b.id}>
                      {s.agents.find((a) => a.id === b.agentId)?.name} ·{" "}
                      {s.worktrees.find((w) => w.id === b.worktreeId)?.name} ·{" "}
                      {b.description}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label={t("Dependencies")}>
              <div className="space-y-2">
                {[
                  ...tasks,
                  ...s.requests.filter((r) => r.issueId === issueId),
                ].map((x) => (
                  <label key={x.id} className="flex gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={deps.includes(x.id)}
                      onChange={(e) =>
                        setDeps(
                          e.target.checked
                            ? [...deps, x.id]
                            : deps.filter((k) => k !== x.id),
                        )
                      }
                    />
                    {"text" in x ? x.text : x.title}
                  </label>
                ))}
              </div>
            </Field>
          </>
        )}
        {!fields && !isTask && (
          <>
            <Field label={t("Supersedes request")}>
              <select
                className="field"
                value={oldRequest}
                onChange={(e) => setOldRequest(e.target.value)}
              >
                <option value="">—</option>
                {s.requests
                  .filter(
                    (r) =>
                      r.issueId === issueId &&
                      !r.supersededById &&
                      r.kind === (approval ? "approval" : "input"),
                  )
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.title} · {t(r.status)}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label={t("Scope")}>
              <select
                className="field"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              >
                <option value="issue">{t("Whole issue")}</option>
                {tasks.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.text}
                  </option>
                ))}
              </select>
            </Field>
            {approval && (
              <>
                <Field label={t("Action after approval")}>
                  <input
                    className="field"
                    value={actionText}
                    onChange={(e) => setAction(e.target.value)}
                  />
                </Field>
                <Field label={t("Frozen materials")}>
                  <div className="space-y-2">
                    {s.artifacts
                      .filter((a) => a.issueId === issueId)
                      .map((a) => (
                        <label key={a.id} className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={refs.includes(a.id)}
                            onChange={(e) =>
                              setRefs(
                                e.target.checked
                                  ? [...refs, a.id]
                                  : refs.filter((x) => x !== a.id),
                              )
                            }
                          />
                          {a.title} · {a.version.slice(0, 8)}
                        </label>
                      ))}
                  </div>
                </Field>
              </>
            )}
          </>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button
            variant="primary"
            disabled={
              pending ||
              !body.trim() ||
              (!isTask && !title.trim()) ||
              (approval && (!refs.length || !actionText.trim()))
            }
            onClick={() => {
              setPending(true);
              const type = fields
                ? "artifact.publish"
                : isTask
                  ? "task.create"
                  : "request.create";
              const payload = fields
                ? {
                    issueId,
                    title,
                    content: body,
                    kind,
                    supersedesId: old || undefined,
                  }
                : isTask
                  ? {
                      issueId,
                      text: body,
                      bindingId: bindingId || undefined,
                      dependencyIds: deps,
                    }
                  : {
                      issueId,
                      title,
                      body,
                      kind: approval ? "approval" : "input",
                      scope: scope === "issue" ? "issue" : [scope],
                      action: actionText,
                      artifactIds: refs,
                      supersedesId: oldRequest || undefined,
                    };
              void action(type, payload)
                .then(onClose)
                .catch(() => {})
                .finally(() => setPending(false));
            }}
          >
            {t(mode)}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
export function IssueDetail({
  issue: i,
  state: s,
  action,
  t,
  busy,
}: {
  issue: Issue;
  state: State;
  action: Action;
  t: T;
  busy: boolean;
}) {
  const [comment, setComment] = useDraft(`comment:${i.id}`);
  const [binding, setBinding] = useState<Binding | "new">(),
    [mode, setMode] = useState(""),
    [menu, setMenu] = useState(false),
    [control, setControl] = useState(""),
    [controlText, setControlText] = useState("");
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(i.title);
  const [editDescription, setEditDescription] = useState(i.description);
  const bindings = s.bindings.filter((b) => b.issueId === i.id && !b.removed);
  const runs = s.runs.filter((r) => r.issueId === i.id);
  const events = s.events.filter((e) => e.issueId === i.id && !e.runId);
  const requests = s.requests.filter((r) => r.issueId === i.id);
  const send = (command: string, text?: string) =>
    void action("issue.control", { issueId: i.id, command, text })
      .then(() => {
        setControl("");
        setControlText("");
        setMenu(false);
      })
      .catch(() => {});
  return (
    <>
      <main className="mx-auto grid max-w-6xl grid-cols-1 gap-10 px-5 py-8 md:px-10 lg:grid-cols-[minmax(0,1fr)_256px] lg:gap-16">
        <section className="min-w-0">
          <div className="flex items-start gap-3">
            <h1 className="flex-1 text-base font-semibold tracking-tight">
              {i.title}
            </h1>
            <Button
              aria-label={t("Copy issue link")}
              onClick={() => void navigator.clipboard.writeText(location.href)}
            >
              <Copy size={14} />
            </Button>
            <Button
              aria-label={t("Edit issue")}
              onClick={() => {
                setEditTitle(i.title);
                setEditDescription(i.description);
                setEditing(true);
              }}
            >
              {t("Edit")}
            </Button>
            <div className="relative">
              <Button aria-label={t("Details")} onClick={() => setMenu(!menu)}>
                <MoreHorizontal size={16} />
              </Button>
              {menu && (
                <div className="absolute right-0 z-10 w-52 rounded-lg border border-border bg-card p-1 shadow-lg">
                  {(!i.started
                    ? ["Start"]
                    : i.status === "Done"
                      ? ["Reopen"]
                      : i.paused
                        ? ["Resume", "Stop and correct", "Final acceptance"]
                        : ["Pause", "Stop and correct", "Final acceptance"]
                  ).map((c) => (
                    <Button
                      key={c}
                      className="w-full justify-start"
                      disabled={busy}
                      onClick={() =>
                        c === "Stop and correct" || c === "Reopen"
                          ? (setControl(c), setMenu(false))
                          : send(
                              c === "Final acceptance"
                                ? "final"
                                : c.toLowerCase(),
                            )
                      }
                    >
                      {t(c)}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <p className="mt-3 whitespace-pre-wrap text-[13px] leading-6 muted">
            {i.description}
          </p>
          {i.paused && (
            <div className="mt-4 rounded border border-amber-400/30 bg-amber-400/5 p-3 text-xs">
              {t("Paused")} ·{" "}
              {t("Pause prevents new dispatch; existing runs may continue.")}
            </div>
          )}
          {s.attachments
            .filter((a) => a.issueId === i.id)
            .map((a) => (
              <a
                key={a.id}
                href={`/api/attachments/${a.id}`}
                className="mt-3 mr-3 inline-flex items-center gap-1 underline"
              >
                <Paperclip size={12} />
                {a.name}
              </a>
            ))}
          <div className="mt-8 flex flex-wrap gap-2">
            {[
              "Submit task",
              "Publish artifact",
              "Request approval",
              "Request human input",
            ].map((m) => (
              <Button
                key={m}
                variant="outline"
                disabled={i.status === "Done"}
                onClick={() => setMode(m)}
              >
                {m === "Request approval" ? (
                  <ShieldCheck size={12} />
                ) : (
                  <Plus size={12} />
                )}{" "}
                {t(m)}
              </Button>
            ))}
          </div>
          <div className="mt-8 border-t border-border pt-5">
            <h2 className="mb-4 font-semibold">{t("Activity")}</h2>
            <div className="timeline space-y-4">
              {events.map((e) => (
                <div key={e.id} className="relative flex items-start gap-3">
                  <div
                    className={`z-1 flex size-6 shrink-0 items-center justify-center rounded-full text-[9px] ${e.source === "Human" ? "bg-muted text-foreground" : "bg-violet-100 text-violet-700"}`}
                  >
                    {e.source === "Human"
                      ? "H"
                      : e.source === "Triage"
                        ? "T"
                        : "S"}
                  </div>
                  <div className="min-w-0 flex-1 pt-0.5">
                    <div className="text-xs">
                      <span className="font-medium">{t(e.source)}</span>{" "}
                      <span className="muted">
                        {t(e.type)} · {new Date(e.at).toLocaleString()}
                      </span>
                    </div>
                    {e.type === "comment" ? (
                      <div className="mt-2 rounded-lg border border-border p-3 whitespace-pre-wrap leading-6">
                        {e.text}
                      </div>
                    ) : (
                      <p className="mt-1 whitespace-pre-wrap break-words text-xs muted">
                        {e.text}
                      </p>
                    )}
                    {e.requestId &&
                      e.type === "request.created" &&
                      requests.find((r) => r.id === e.requestId) && (
                        <RequestCard
                          request={requests.find((r) => r.id === e.requestId)!}
                          state={s}
                          action={action}
                          t={t}
                          busy={busy}
                        />
                      )}
                  </div>
                </div>
              ))}
            </div>
            {runs.map((r) => {
              const steps = s.events.filter((e) => e.runId === r.id);
              return (
                <details
                  key={r.id}
                  className="mt-4 rounded-lg border border-border bg-card p-4"
                  open={activeRun(r)}
                >
                  <summary className="text-xs">
                    <span className="font-medium">{r.snapshot.agentName}</span>{" "}
                    · {r.snapshot.projectName} · {r.snapshot.branch}
                    <span className="ml-2 badge">{t(r.status)}</span>
                    <span className="ml-2 muted">
                      {steps.length} {t("Steps")}
                    </span>
                  </summary>
                  <div className="mt-3 space-y-3">
                    <p className="text-[11px] muted break-all">
                      {r.id} · PID {r.pid || "—"} · {r.snapshot.path} ·{" "}
                      {r.startedAt}
                    </p>
                    <p className="text-xs muted">{r.snapshot.description}</p>
                    {bindings.find((b) => b.id === r.bindingId)?.revision !==
                      r.snapshot.revision && (
                      <p className="text-xs text-amber-500">
                        {t("Needs verification")} · {t("Assignments")}{" "}
                        {t("Version")} {r.snapshot.revision}
                      </p>
                    )}
                    {r.reason && (
                      <p className="text-amber-500 text-xs">{r.reason}</p>
                    )}
                    {steps.map((e) => (
                      <div key={e.id} className="border-l border-border pl-3">
                        <div className="text-[10px] muted">
                          {e.at} · {e.type}
                        </div>
                        <p className="mt-1 whitespace-pre-wrap text-xs">
                          {e.text}
                        </p>
                        {e.data !== undefined && (
                          <details className="mt-1 text-xs muted">
                            <summary>{t("Details")}</summary>
                            <pre className="mt-2 max-h-80 overflow-auto">
                              {typeof e.data === "string"
                                ? e.data
                                : JSON.stringify(e.data, null, 2)}
                            </pre>
                          </details>
                        )}
                        {e.requestId &&
                          e.type === "request.created" &&
                          requests.find((q) => q.id === e.requestId) && (
                            <RequestCard
                              request={requests.find(
                                (q) => q.id === e.requestId,
                              )!}
                              state={s}
                              action={action}
                              t={t}
                              busy={busy}
                            />
                          )}
                      </div>
                    ))}
                    {r.status === "unknown" && (
                      <>
                        <p className="text-xs muted">
                          {t(
                            "Unknown run holds the worktree lock until verified.",
                          )}
                        </p>
                        <Button
                          variant="outline"
                          onClick={() => {
                            setControl(`verify:${r.id}`);
                            setControlText("");
                          }}
                        >
                          {t("Verify unknown run")}
                        </Button>
                      </>
                    )}
                  </div>
                </details>
              );
            })}
            <div className="mt-5 overflow-hidden rounded-lg border border-border bg-card">
              <div className="flex items-center gap-2 px-4 pt-3 text-xs font-medium">
                <UserRound size={14} />
                {t("Human")}
              </div>
              <textarea
                className="min-h-24 w-full resize-y bg-transparent px-4 py-3 outline-none"
                placeholder={t("Leave a comment…")}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
              <div className="flex justify-end border-t border-border px-3 py-2">
                <Button
                  variant="primary"
                  disabled={busy || !comment.trim()}
                  onClick={() =>
                    void action("comment.create", {
                      issueId: i.id,
                      text: comment,
                    })
                      .then(() => setComment(""))
                      .catch(() => {})
                  }
                >
                  {t("Send comment")}
                  <ArrowUp size={12} />
                </Button>
              </div>
            </div>
          </div>
          {s.tasks.some((t) => t.issueId === i.id) && (
            <section className="mt-8">
              <h2 className="mb-3 font-semibold">{t("Tasks")}</h2>
              {s.tasks
                .filter((t) => t.issueId === i.id)
                .map((task) => (
                  <details
                    key={task.id}
                    className="mb-2 rounded border border-border p-3"
                  >
                    <summary className="text-xs">
                      {task.text.slice(0, 100)}{" "}
                      <span className="badge">{t(task.status)}</span>
                    </summary>
                    <p className="mt-2 whitespace-pre-wrap text-xs muted">
                      {task.text}
                    </p>
                    <p className="mt-2 text-xs muted">
                      {task.reason} · {task.id}
                    </p>
                    <p className="text-xs muted">
                      {t("Dependencies")}:{" "}
                      {task.dependencyIds.join(", ") || "—"}
                    </p>
                    {!["running", "unknown", "done", "cancelled"].includes(
                      task.status,
                    ) && (
                      <div className="mt-3 flex gap-2">
                        <Button
                          variant="outline"
                          onClick={() => {
                            setControl(`retry:${task.id}`);
                            setControlText("");
                          }}
                        >
                          {t("Retry")}
                        </Button>
                        <Button
                          onClick={() => {
                            setControl(`cancel:${task.id}`);
                            setControlText("");
                          }}
                        >
                          {t("Cancel task")}
                        </Button>
                      </div>
                    )}
                  </details>
                ))}
            </section>
          )}
          <section className="mt-8">
            <h2 className="mb-3 font-semibold">{t("Artifacts")}</h2>
            <div className="space-y-2">
              {s.artifacts
                .filter((a) => a.issueId === i.id)
                .map((a) => (
                  <ArtifactView key={a.id} artifact={a} t={t} />
                ))}
            </div>
            {!s.artifacts.some((a) => a.issueId === i.id) && (
              <p className="text-xs muted">{t("No artifacts yet")}</p>
            )}
          </section>
        </section>
        <aside className="lg:pt-6">
          <h2 className="text-xs font-medium muted">{t("Properties")}</h2>
          <div className="mt-4 flex items-center gap-2">
            <StatusIcon status={i.status} />
            {t(i.status)}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <UserRound size={14} />
            {t("Human")}
          </div>
          <h2 className="mt-8 text-xs font-medium muted">{t("Assignments")}</h2>
          <div className="mt-4 space-y-4">
            {bindings.map((b) => {
              const p = s.projects.find((p) => p.id === b.projectId),
                w = s.worktrees.find((w) => w.id === b.worktreeId),
                a = s.agents.find((a) => a.id === b.agentId),
                r = runs.find((r) => r.bindingId === b.id && activeRun(r));
              const pending = s.tasks.find(
                (t) =>
                  t.bindingId === b.id &&
                  ["waiting", "unknown"].includes(t.status),
              );
              const status = r
                ? r.status === "unknown"
                  ? t("Unknown")
                  : t("Running")
                : pending || a?.status !== "available"
                  ? t("Waiting")
                  : t("Ready");
              return (
                <details
                  key={b.id}
                  className="rounded border border-border p-3"
                >
                  <summary className="text-xs">
                    <span className="font-medium">{p?.name}</span>
                    <span className="ml-2 text-[10px] muted">{status}</span>
                    <span className="mt-2 flex items-center gap-1 text-[11px] muted">
                      <GitBranch size={11} />
                      {w?.branch}
                      <Bot className="ml-1" size={11} />
                      {a?.name}
                    </span>
                    <span className="mt-1 block line-clamp-2 text-[11px] leading-4 muted">
                      {b.description}
                    </span>
                  </summary>
                  <p className="mt-2 flex items-center gap-1 text-[11px] muted">
                    <GitBranch size={11} />
                    {w?.branch}
                    <Bot size={11} />
                    {a?.name}
                  </p>
                  <p className="mt-2 break-all text-[11px] muted">{w?.path}</p>
                  <p className="mt-3 whitespace-pre-wrap text-xs leading-5">
                    {b.description}
                  </p>
                  {(pending || a?.status !== "available") && (
                    <p className="mt-2 text-xs text-amber-500">
                      {pending?.reason || a?.reason}
                    </p>
                  )}
                  <div className="mt-3 flex gap-2">
                    <Button variant="outline" onClick={() => setBinding(b)}>
                      {t("Edit")}
                    </Button>
                    <Button
                      className="danger"
                      onClick={() => {
                        setControl(`remove:${b.id}`);
                        setControlText("");
                      }}
                    >
                      {t("Remove")}
                    </Button>
                  </div>
                </details>
              );
            })}
          </div>
          {!bindings.length && (
            <p className="mt-4 text-xs muted">{t("No assignments")}</p>
          )}
          <Button
            className="mt-3 px-0"
            disabled={i.status === "Done"}
            onClick={() => setBinding("new")}
          >
            <Plus size={12} />
            {t("Bind agent")}
          </Button>
          <h2 className="mt-8 text-xs font-medium muted">{t("Created")}</h2>
          <p className="mt-3 text-xs muted">
            {new Date(i.createdAt).toLocaleString()}
          </p>
        </aside>
      </main>
      {editing && (
        <Modal title={t("Edit issue")} onClose={() => setEditing(false)}>
          <div className="space-y-4">
            <Field label={t("Issue title")}>
              <input
                className="field"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
              />
            </Field>
            <Field label={t("Content")}>
              <textarea
                className="field min-h-32"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
              />
            </Field>
            <Button
              variant="primary"
              disabled={busy || !editTitle.trim()}
              onClick={() =>
                void action("issue.update", {
                  issueId: i.id,
                  revision: i.revision,
                  title: editTitle,
                  description: editDescription,
                })
                  .then(() => setEditing(false))
                  .catch(() => {})
              }
            >
              {t("Save")}
            </Button>
          </div>
        </Modal>
      )}
      {binding && (
        <BindingDialog
          issueId={i.id}
          binding={binding === "new" ? undefined : binding}
          state={s}
          action={action}
          t={t}
          onClose={() => setBinding(undefined)}
        />
      )}{" "}
      {mode && (
        <Composer
          issueId={i.id}
          state={s}
          action={action}
          t={t}
          mode={mode}
          onClose={() => setMode("")}
        />
      )}
      {control && (
        <ControlModal
          control={control}
          text={controlText}
          setText={setControlText}
          t={t}
          onClose={() => setControl("")}
          onSubmit={(outcome) => {
            if (control === "Stop and correct" || control === "Reopen")
              send(control === "Reopen" ? "reopen" : "stop", controlText);
            else {
              const [type, id] = control.split(":");
              const actionType =
                type === "verify"
                  ? "run.reconcile"
                  : type === "remove"
                    ? "binding.remove"
                    : type === "retry"
                      ? "task.retry"
                      : "task.cancel";
              const payload =
                type === "verify"
                  ? { runId: id, outcome, evidence: controlText }
                  : type === "remove"
                    ? { bindingId: id, reason: controlText }
                    : { taskId: id, reason: controlText };
              void action(actionType, payload)
                .then(() => setControl(""))
                .catch(() => {});
            }
          }}
        />
      )}
    </>
  );
}
function ControlModal({
  control,
  text,
  setText,
  t,
  onClose,
  onSubmit,
}: {
  control: string;
  text: string;
  setText: (v: string) => void;
  t: T;
  onClose: () => void;
  onSubmit: (outcome: string) => void;
}) {
  const [outcome, setOutcome] = useState("completed");
  return (
    <Modal
      title={t(
        control.startsWith("verify:")
          ? "Verify unknown run"
          : control.includes(":")
            ? "Reason / evidence"
            : control,
      )}
      onClose={onClose}
    >
      <textarea
        className="field min-h-28"
        autoFocus
        placeholder={t("Reason / evidence")}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {control.startsWith("verify:") && (
        <select
          className="field mt-3"
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
        >
          {["completed", "failed", "stopped"].map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      )}
      <Button
        className="mt-4"
        variant="primary"
        disabled={!text.trim()}
        onClick={() => onSubmit(outcome)}
      >
        {t("Save")}
      </Button>
    </Modal>
  );
}
