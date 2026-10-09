import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  Activity,
  ApprovalLevel,
  Binding,
  Detail,
  HumanRequest,
  Issue,
  Status,
  Turn,
} from "../server/types";
import {
  approvalDescriptions,
  approvalLabels,
  approvalLevels,
  defaultApprovalLevel,
} from "../server/approval";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./style.css";
type Row = Issue & { bindings: Binding[]; runningAgent: string | null };
type Config = {
  workspace: string;
  jevConfigured: boolean;
  runtimeAvailable: Record<string, boolean>;
};
const labels: Record<Status, string> = {
  waiting_binding: "Waiting for binding",
  ready: "Open",
  routing: "Running",
  running: "Running",
  waiting_human: "Needs attention",
  stopping: "Stopping",
  stopped: "Stopped",
  done: "Done",
};
const editable = (s: Status) =>
  ["waiting_binding", "ready", "stopped"].includes(s);
async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const res = await fetch("/api" + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || "Request failed.");
  return result;
}
function Icon({ name }: { name: string }) {
  return (
    <span className={`icon icon-${name}`}>
      <img src={`/assets/${name}.svg`} alt="" />
    </span>
  );
}
function Badge({ status }: { status: Status }) {
  return <span className="badge">{labels[status]}</span>;
}
function time(value: string) {
  return new Date(value).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
function date(value: string) {
  return new Date(value).toDateString() === new Date().toDateString()
    ? `Today, ${time(value)}`
    : new Date(value).toLocaleDateString("en-GB");
}
function relative(value: string) {
  const minutes = Math.floor((Date.now() - Date.parse(value)) / 60000);
  return minutes < 1
    ? "Just now"
    : minutes < 60
      ? `${minutes} min ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)} hour${minutes >= 120 ? "s" : ""} ago`
        : minutes < 2880
          ? "Yesterday"
          : new Date(value).toLocaleDateString("en-GB");
}
function parse(value: string): any {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
function Dialog({
  title,
  children,
  close,
  decision = false,
  error,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
  decision?: boolean;
  error?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${decision ? "decision-dialog" : ""}`}
      onCancel={close}
      onClick={(e) => {
        if (e.target === ref.current) close();
      }}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        {decision && <button onClick={close}>Close</button>}
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {children}
    </dialog>
  );
}
function App() {
  const [rows, setRows] = useState<Row[]>([]),
    [detail, setDetail] = useState<Detail | null>(null),
    [config, setConfig] = useState<Config | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(() =>
      decodeURIComponent(location.hash.slice(1)),
    ),
    [filter, setFilter] = useState("All issues"),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(0),
    [modal, setModal] = useState<"create" | "edit" | "binding" | null>(null),
    [editingBinding, setEditingBinding] = useState<Binding | null>(null),
    [session, setSession] = useState<string | null>(null),
    [inspect, setInspect] = useState<Activity | null>(null),
    [activityFilter, setActivityFilter] = useState("all"),
    [more, setMore] = useState(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const requestVersion = useRef(0);
  async function refresh() {
    const version = ++requestVersion.current;
    try {
      const id = selectedRef.current;
      const [list, d] = await Promise.all([
        api<Row[]>("/issues"),
        id
          ? api<Detail>(`/issues/${encodeURIComponent(id)}`)
          : Promise.resolve(null),
      ]);
      if (version === requestVersion.current) {
        setRows(list);
        setDetail(d);
        setLoading(false);
      }
    } catch (e) {
      if (version === requestVersion.current) {
        setError((e as Error).message);
        setLoading(false);
      }
    }
  }
  useEffect(() => {
    void api<Config>("/config")
      .then(setConfig)
      .catch((e) => setError(e.message));
    const hash = () => {
      setSelected(decodeURIComponent(location.hash.slice(1)));
      setDetail(null);
      setSession(null);
      setLoading(true);
    };
    addEventListener("hashchange", hash);
    const events = new EventSource("/api/events");
    events.onmessage = () => void refresh();
    return () => {
      removeEventListener("hashchange", hash);
      events.close();
    };
  }, []);
  useEffect(() => {
    void refresh();
  }, [selected]);
  useEffect(() => setPage(0), [filter, search]);
  async function perform(fn: () => Promise<unknown>, close = false) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
      if (close) setModal(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function navigate(id = "") {
    setSession(null);
    setMore(false);
    location.hash = id;
  }
  function openBinding(b: Binding | null = null) {
    setError("");
    setEditingBinding(b);
    setModal("binding");
  }
  const group = (i: Row, f: string) =>
    f === "All issues" ||
    (f === "Running" &&
      ["routing", "running", "stopping"].includes(i.status)) ||
    (f === "Needs attention" &&
      (i.status === "waiting_human" ||
        (i.status === "stopped" &&
          !!i.stopReason &&
          i.stopReason !== "Stopped by Human"))) ||
    (f === "Done" && i.status === "done");
  const filtered = rows.filter(
    (i) =>
      group(i, filter) &&
      `${i.id} ${i.title}`.toLowerCase().includes(search.toLowerCase()),
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / 8));
  const pageIndex = Math.min(page, totalPages - 1);
  const visible = filtered.slice(pageIndex * 8, pageIndex * 8 + 8);
  const current = detail?.turns.find((t) => t.id === detail.currentTurnId);
  const currentAgent = detail?.bindings.find(
    (b) => b.id === current?.bindingId,
  );
  const pending = detail?.requests.find((r) => r.status === "pending");
  const pendingActivity = detail?.activities.find(
    (a) => a.type === "human_requested" && a.summary === pending?.title,
  );

  const activities =
    detail?.activities.filter(
      (a) => activityFilter === "all" || activityFilter === a.actor,
    ) || [];
  return (
    <div className="app">
      <aside className="sidebar" data-node-id="73:629">
        <button className="brand plain" onClick={() => navigate()}>
          <span className="brand-mark">A</span>
          <strong>Agent workspace</strong>
        </button>
        <button className="nav plain" onClick={() => navigate()}>
          <Icon name="nav" />
          <span>Issue</span>
        </button>
        <div className="sidebar-spacer" />
        <div className="workspace-status" />
        <div className="account" />
      </aside>
      <div className="workspace">
        <header className="topbar">
          {selected ? (
            <>
              <button
                className="plain breadcrumb"
                onClick={() => (session ? setSession(null) : navigate())}
              >
                <Icon name="back" />
                Issue
              </button>
              <span className="slash">/</span>
              <span className="issue-id">{selected}</span>
            </>
          ) : (
            <>
              <Icon name="issue" />
              <span>Issue</span>
            </>
          )}
          {!session && <span className="workspace-name">Agent workspace</span>}
        </header>
        <main>
          {loading ? (
            <p className="empty">Loading…</p>
          ) : !selected ? (
            <section className="list-page" data-node-id="10:2155">
              <div className="list-heading">
                <div>
                  <h1>Issues</h1>
                  <p>Track work and follow your agents' progress.</p>
                </div>
                <button
                  className="primary"
                  aria-label="New issue"
                  onClick={() => {
                    setError("");
                    setModal("create");
                  }}
                >
                  {"+  New issue"}
                </button>
              </div>
              <div className="list-toolbar">
                <div className="tabs">
                  {["All issues", "Running", "Needs attention", "Done"].map(
                    (f) => (
                      <button
                        className={`plain tab ${filter === f ? "selected" : ""}`}
                        key={f}
                        onClick={() => setFilter(f)}
                      >{`${f}  ${rows.filter((i) => group(i, f)).length}`}</button>
                    ),
                  )}
                </div>
                <input
                  className="search"
                  aria-label="Search issues"
                  placeholder="Search issues..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="table-wrap">
                <table>
                  <colgroup>
                    <col className="column-id" />
                    <col className="column-title" />
                    <col className="column-status" />
                    <col className="column-agent" />
                    <col className="column-updated" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Title</th>
                      <th>Status</th>
                      <th>Running agent</th>
                      <th>Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((i) => (
                      <tr key={i.id} onClick={() => navigate(i.id)}>
                        <td>{i.id}</td>
                        <td>
                          <button
                            className="plain issue-link"
                            onClick={() => navigate(i.id)}
                          >
                            {i.title}
                          </button>
                        </td>
                        <td>{labels[i.status]}</td>
                        <td>
                          {i.status === "running" ? i.runningAgent || "—" : "—"}
                        </td>
                        <td>{relative(i.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!visible.length && (
                  <p className="empty">
                    {rows.length ? "No matching issues" : "No issues"}
                  </p>
                )}
              </div>
              <div className="table-footer">
                <span>
                  {filtered.length} issue{filtered.length === 1 ? "" : "s"}
                </span>
                <div className="pagination">
                  <span>
                    Page {pageIndex + 1} of {totalPages}
                  </span>
                  <button
                    className="plain"
                    disabled={pageIndex === 0}
                    onClick={() => setPage(pageIndex - 1)}
                  >
                    Previous
                  </button>
                  <button
                    className="plain"
                    disabled={pageIndex >= totalPages - 1}
                    onClick={() => setPage(pageIndex + 1)}
                  >
                    Next
                  </button>
                </div>
              </div>
            </section>
          ) : detail && session ? (
            <SessionPage detail={detail} bindingId={session} />
          ) : detail ? (
            <section className="detail-layout" data-node-id="10:2373">
              <div className="detail-main">
                <div className="title-row">
                  <h1>{detail.title}</h1>
                  <div className="workflow-actions">
                    <button
                      className="primary"
                      disabled={
                        busy ||
                        !["ready", "stopped"].includes(detail.status) ||
                        !detail.bindings.length
                      }
                      onClick={() =>
                        perform(() => api(`/issues/${detail.id}/start`, "POST"))
                      }
                    >
                      Start
                    </button>
                    <button
                      disabled={
                        busy ||
                        !["routing", "running", "waiting_human"].includes(
                          detail.status,
                        )
                      }
                      onClick={() =>
                        perform(() => api(`/issues/${detail.id}/stop`, "POST"))
                      }
                    >
                      Stop
                    </button>
                    <div className="more-wrap">
                      <button
                        className="plain more-button"
                        aria-label="More actions"
                        onClick={() => setMore(!more)}
                      >
                        •••
                      </button>
                      {more && (
                        <div className="more-menu">
                          <button
                            className="plain"
                            disabled={!editable(detail.status)}
                            onClick={() => {
                              setMore(false);
                              setError("");
                              setModal("edit");
                            }}
                          >
                            Edit
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <div className="metadata">
                  <Badge status={detail.status} />
                  <Icon name="folder" />
                  <span>Agent platform</span>
                  <span>{`·  Created by ${(detail as Detail & { createdBy?: string }).createdBy || "you"}  ·  ${date(detail.createdAt)}`}</span>
                </div>
                <div className="description">
                  <h3>Description</h3>
                  <p>{detail.description}</p>
                </div>
                {detail.status === "running" && currentAgent && (
                  <div className="running-card" data-node-id="63:533">
                    <div>
                      <strong>
                        {currentAgent.name} ·{" "}
                        {(current as Turn & { task?: string })?.task ||
                          currentAgent.role}
                      </strong>
                      <p>
                        Turn {String(detail.turns.length).padStart(2, "0")} ·
                        Session {currentAgent.sessionId || "Starting…"} ·
                        Started {time(current!.startedAt)}
                      </p>
                    </div>
                    <button onClick={() => setSession(currentAgent.id)}>
                      Open chat
                    </button>
                  </div>
                )}
                <section className="activity-section">
                  <div className="activity-heading">
                    <h2>Activity</h2>
                    <span className="count">{detail.activities.length}</span>
                    <select
                      aria-label="Filter activity"
                      value={activityFilter}
                      onChange={(e) => setActivityFilter(e.target.value)}
                    >
                      <option value="all">All activity</option>
                      <option value="Jev">Jev</option>
                      <option value="Human">Human</option>
                      <option value="System">System</option>
                    </select>
                  </div>
                  <div className="activity-list">
                    {activities.map((a) => {
                      const decision = parse(a.detail);
                      const summary =
                        decision?.output?.detail ||
                        decision?.detail ||
                        a.detail;
                      const related = pending && a.id === pendingActivity?.id;
                      return (
                        <article
                          className={`activity ${a.actor === "Jev" ? "jev-activity" : ""}`}
                          key={a.id}
                        >
                          <span className="avatar">{a.actor[0]}</span>
                          <div className="activity-content">
                            <div className="activity-title">
                              <strong>
                                {a.actor} · {a.summary}
                              </strong>
                              <time>{time(a.createdAt)}</time>
                              {a.actor === "Jev" && (
                                <button
                                  className="plain inspect-button"
                                  aria-label={`Inspect ${a.summary}`}
                                  onClick={() => setInspect(a)}
                                >
                                  <Icon name="code" />
                                </button>
                              )}
                            </div>
                            {related && detail.status === "waiting_human" ? (
                              <RequestActions
                                request={pending}
                                busy={busy}
                                inspect={() => setInspect(a)}
                                submit={(answer, approved) =>
                                  perform(() =>
                                    api(
                                      `/issues/${detail.id}/requests/${pending.id}`,
                                      "POST",
                                      { answer, approved },
                                    ),
                                  )
                                }
                              />
                            ) : (
                              summary && <p>{summary}</p>
                            )}
                          </div>
                        </article>
                      );
                    })}
                    {pending &&
                      detail.status === "waiting_human" &&
                      !activities.some(
                        (a) =>
                          a.type === "human_requested" &&
                          a.summary === pending.title,
                      ) && (
                        <article className="activity">
                          <span className="avatar">H</span>
                          <div className="activity-content">
                            <div className="activity-title">
                              <strong>{pending.title}</strong>
                              <time>{time(pending.createdAt)}</time>
                            </div>
                            <RequestActions
                              request={pending}
                              busy={busy}
                              inspect={() =>
                                setInspect({
                                  id: pending.id,
                                  issueId: detail.id,
                                  actor: "Human",
                                  type: "request",
                                  summary: pending.title,
                                  detail: pending.detail,
                                  createdAt: pending.createdAt,
                                })
                              }
                              submit={(answer, approved) =>
                                perform(() =>
                                  api(
                                    `/issues/${detail.id}/requests/${pending.id}`,
                                    "POST",
                                    { answer, approved },
                                  ),
                                )
                              }
                            />
                          </div>
                        </article>
                      )}
                  </div>
                </section>
                <Composer comment />
              </div>
              <aside className="detail-aside">
                <div className="binding-card">
                  <div className="binding-heading">
                    <h3>Binding agents</h3>
                    <span>{detail.bindings.length}</span>
                    <button
                      className="plain"
                      disabled={!editable(detail.status)}
                      onClick={() => openBinding()}
                    >
                      + Add
                    </button>
                  </div>
                  {detail.bindings.map((b, index) => {
                    const hasHistory = detail.turns.some(
                      (t) => t.bindingId === b.id,
                    );
                    const active =
                      hasHistory && (currentAgent?.id === b.id || index === 0);
                    return (
                      <div key={b.id} className="binding-entry">
                        <button
                          className={`agent-binding ${active ? "active-binding" : ""}`}
                          aria-label={
                            hasHistory
                              ? `Open ${b.name} session`
                              : `Configure ${b.name} binding`
                          }
                          onClick={() =>
                            hasHistory ? setSession(b.id) : openBinding(b)
                          }
                        >
                          <div>
                            <strong>{b.name}</strong>
                            {active && (
                              <span>
                                {currentAgent?.id === b.id &&
                                detail.status === "running"
                                  ? "Running"
                                  : "Idle"}
                              </span>
                            )}
                          </div>
                          <p>{b.role}</p>
                        </button>
                        <div className="binding-settings">
                          <span>
                            Approval ·{" "}
                            {
                              approvalLabels[
                                b.approvalLevel ??
                                  defaultApprovalLevel(b.runtime)
                              ]
                            }
                          </span>
                          <button
                            className="plain"
                            aria-label={`Edit ${b.name} binding`}
                            disabled={
                              !editable(detail.status) || !!pending || busy
                            }
                            onClick={() => openBinding(b)}
                          >
                            Edit
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </aside>
            </section>
          ) : (
            <p className="empty">Issue not found.</p>
          )}
        </main>
      </div>
      {(modal === "create" || modal === "edit") && (
        <Dialog
          title={modal === "create" ? "New issue" : "Edit issue"}
          close={() => setModal(null)}
          error={error}
        >
          <IssueForm
            initial={modal === "edit" ? detail : null}
            busy={busy}
            close={() => setModal(null)}
            submit={(title, description) =>
              perform(async () => {
                if (modal === "edit" && detail)
                  await api(`/issues/${detail.id}`, "PATCH", {
                    title,
                    description,
                  });
                else {
                  const d = await api<Detail>("/issues", "POST", {
                    title,
                    description,
                  });
                  navigate(d.id);
                }
              }, true)
            }
          />
        </Dialog>
      )}
      {modal === "binding" && detail && (
        <Dialog title="Bind agent" close={() => setModal(null)} error={error}>
          <BindingForm
            initial={editingBinding}
            config={config}
            busy={busy}
            canEdit={editable(detail.status)}
            close={() => setModal(null)}
            submit={(data) =>
              perform(
                () =>
                  api(
                    `/issues/${detail.id}/bindings${editingBinding ? "/" + editingBinding.id : ""}`,
                    editingBinding ? "PATCH" : "POST",
                    data,
                  ),
                true,
              )
            }
          />
        </Dialog>
      )}
      {inspect && (
        <DecisionDialog activity={inspect} close={() => setInspect(null)} />
      )}
      {error && !modal && (
        <Dialog title="Unable to complete action" close={() => setError("")}>
          <p className="dialog-description">{error}</p>
          <div className="dialog-actions">
            <button onClick={() => setError("")}>Close</button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
function IssueForm({
  initial,
  busy,
  close,
  submit,
}: {
  initial: Detail | null;
  busy: boolean;
  close: () => void;
  submit: (title: string, description: string) => void;
}) {
  const [title, setTitle] = useState(initial?.title || ""),
    [description, setDescription] = useState(initial?.description || "");
  return (
    <form
      className="dialog-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit(title, description);
      }}
    >
      <label>
        Title
        <input
          required
          autoFocus
          maxLength={240}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label>
        Description
        <textarea
          required
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <div className="dialog-actions">
        <button type="button" onClick={close}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={busy || !title.trim() || !description.trim()}
        >
          {initial ? "Save changes" : "Create issue"}
        </button>
      </div>
    </form>
  );
}
function BindingForm({
  initial,
  config,
  busy,
  canEdit,
  close,
  submit,
}: {
  initial: Binding | null;
  config: Config | null;
  busy: boolean;
  canEdit: boolean;
  close: () => void;
  submit: (data: unknown) => void;
}) {
  const [runtime, setRuntime] = useState(initial?.runtime || "codex"),
    [role, setRole] = useState(initial?.role || ""),
    [approvalLevel, setApprovalLevel] = useState<ApprovalLevel>(
      initial?.approvalLevel ??
        defaultApprovalLevel(initial?.runtime || "codex"),
    );
  return (
    <>
      <p className="dialog-description">
        Configure an agent’s responsibility and approval level for this Issue.
      </p>
      <form
        className="dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit({
            runtime,
            approvalLevel,
            role,
            name:
              initial?.runtime === runtime
                ? initial.name
                : runtime === "codex"
                  ? "Codex"
                  : "Pi",
            cwd: initial?.cwd || config?.workspace || "",
            model: initial?.model || "",
          });
        }}
      >
        <label>
          Agent runtime
          <div className="select-field">
            <select
              value={runtime}
              disabled={!canEdit || busy}
              onChange={(e) => {
                const next = e.target.value as "codex" | "pi";
                setRuntime(next);
                setApprovalLevel(
                  initial?.runtime === next
                    ? (initial.approvalLevel ?? defaultApprovalLevel(next))
                    : defaultApprovalLevel(next),
                );
              }}
            >
              <option value="codex">Codex</option>
              <option value="pi">Pi</option>
            </select>
            <Icon name="chevron-down" />
          </div>
        </label>
        <label>
          Agent description
          <input
            autoFocus
            required
            value={role}
            disabled={!canEdit || busy}
            onChange={(e) => setRole(e.target.value)}
          />
        </label>
        <div className="approval-field">
          <label>
            Approval level
            <div className="select-field">
              <select
                value={approvalLevel}
                aria-label="Approval level"
                disabled={!canEdit || busy}
                aria-describedby="approval-description approval-runtime"
                onChange={(e) =>
                  setApprovalLevel(e.target.value as ApprovalLevel)
                }
              >
                {approvalLevels.map((level) => (
                  <option key={level} value={level}>
                    {approvalLabels[level]}
                  </option>
                ))}
              </select>
              <Icon name="chevron-down" />
            </div>
          </label>
          <p id="approval-description">
            {approvalDescriptions[runtime][approvalLevel]}
          </p>
          <p id="approval-runtime">
            {runtime === "codex"
              ? "Codex · Sandbox restrictions remain enabled."
              : "Pi · Tools use the permissions of the running environment."}
          </p>
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={busy || !canEdit || !role.trim() || !config}
          >
            {initial ? "Save binding" : "Bind agent"}
          </button>
        </div>
      </form>
    </>
  );
}
function RequestActions({
  request: r,
  busy,
  inspect,
  submit,
}: {
  request: HumanRequest;
  busy: boolean;
  inspect: () => void;
  submit: (answer: string, approved: boolean) => void;
}) {
  const [feedback, setFeedback] = useState(false),
    [answer, setAnswer] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const questions: { id: string; question: string }[] =
    r.native?.method === "item/tool/requestUserInput"
      ? r.native.params.questions
      : [];
  const response = questions.length
    ? JSON.stringify(
        Object.fromEntries(questions.map((q) => [q.id, [answers[q.id] || ""]])),
      )
    : answer;
  const valid = questions.length
    ? questions.every((q) => answers[q.id]?.trim())
    : !!answer.trim();
  return (
    <div className="request-actions">
      {r.kind === "approval" ? (
        <>
          <div className="approval-row">
            <span className="request-subject">{r.title}</span>
            <span className="muted">Waiting for review</span>
            <button onClick={inspect}>View diff</button>
            <button disabled={busy} onClick={() => setFeedback(!feedback)}>
              Reject
            </button>
            <button disabled={busy} onClick={() => submit("", true)}>
              Approve
            </button>
          </div>
          {feedback && (
            <form
              className="request-answer"
              onSubmit={(e) => {
                e.preventDefault();
                submit(answer, false);
              }}
            >
              <textarea
                aria-label="Requested changes"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                autoFocus
                required
              />
              <button disabled={busy || !answer.trim()}>Request changes</button>
            </form>
          )}
        </>
      ) : (
        <form
          className="request-answer"
          onSubmit={(e) => {
            e.preventDefault();
            submit(response, false);
          }}
        >
          <p>{r.detail}</p>
          {questions.length ? (
            questions.map((q) => (
              <label key={q.id}>
                {q.question}
                <input
                  required
                  value={answers[q.id] || ""}
                  onChange={(e) =>
                    setAnswers({ ...answers, [q.id]: e.target.value })
                  }
                />
              </label>
            ))
          ) : r.options.length ? (
            <select
              aria-label="Your answer"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
            >
              <option value="">Select an option</option>
              {r.options.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          ) : (
            <textarea
              aria-label="Your answer"
              required
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
            />
          )}
          <button disabled={busy || !valid}>Submit answer</button>
        </form>
      )}
    </div>
  );
}
function DecisionDialog({
  activity: a,
  close,
}: {
  activity: Activity;
  close: () => void;
}) {
  const payload = parse(a.detail);
  const output = payload?.output || payload || a.detail;
  const input = payload?.input;
  return (
    <Dialog
      title={a.actor === "Jev" ? "Jev decision" : a.summary}
      close={close}
      decision
    >
      {a.actor === "Jev" ? (
        <>
          <p className="decision-summary">{a.summary}</p>
          <p className="decision-meta">
            Decision {a.id.slice(0, 8)} · {time(a.createdAt)} · {a.type}
          </p>
          <div className="decision-result">
            <h3>Input snapshot → decision output</h3>
            <p>
              Inspect the context passed to Jev and the returned routing
              decision.
            </p>
          </div>
          <div className="decision-columns">
            <section>
              <h3>Input</h3>
              <pre>
                {input
                  ? JSON.stringify(input, null, 2)
                  : "Input snapshot was not recorded for this earlier decision."}
              </pre>
            </section>
            <section>
              <h3>Output</h3>
              <pre>
                {typeof output === "string"
                  ? output
                  : JSON.stringify(output, null, 2)}
              </pre>
            </section>
          </div>
        </>
      ) : (
        <pre className="operation-detail">{a.detail}</pre>
      )}
    </Dialog>
  );
}
function Composer({
  agent,
  comment = false,
}: {
  agent?: string;
  comment?: boolean;
}) {
  return (
    <div
      className={comment ? "comment-composer" : "chat-composer"}
      aria-label={comment ? "Comment composer" : "Message composer"}
    >
      <textarea
        readOnly
        aria-label={comment ? "Comment" : `Message ${agent}`}
        placeholder={comment ? "Leave a comment…" : `Message ${agent}…`}
      />
      <div className="composer-controls">
        <button className="plain" disabled aria-label="Attach file">
          <Icon name={comment ? "comment-attach" : "attach"} />
        </button>
        <button
          className={comment ? "plain" : "primary"}
          disabled
          aria-label="Send message"
        >
          <Icon name={comment ? "comment-send" : "send"} />
        </button>
      </div>
    </div>
  );
}
function SessionPage({
  detail: d,
  bindingId,
}: {
  detail: Detail;
  bindingId: string;
}) {
  const binding = d.bindings.find((b) => b.id === bindingId)!;
  const turns = d.turns.filter((t) => t.bindingId === bindingId);
  const latest = turns.at(-1);
  return (
    <section className="session-page" data-node-id="63:475">
      <div className="session-header">
        <h1>{binding.name}</h1>
        <Badge status={latest?.status === "running" ? "running" : d.status} />
      </div>
      <p className="session-meta">
        {binding.role} · Session {binding.sessionId || "—"}
      </p>
      <div className="conversation-history">
        {turns.map((t) => (
          <SessionTurn
            key={t.id}
            turn={t}
            index={d.turns.indexOf(t) + 1}
            detail={d}
            initiallyExpanded={t.id === latest?.id}
          />
        ))}
      </div>
      <Composer agent={binding.name} />
    </section>
  );
}
function SessionTurn({
  turn: t,
  index,
  detail: d,
  initiallyExpanded,
}: {
  initiallyExpanded: boolean;
  turn: Turn;
  index: number;
  detail: Detail;
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const messages = d.messages.filter((m) => m.turnId === t.id);
  const text =
    t.output ||
    messages
      .filter((m) => m.kind === "assistant_delta")
      .map((m) => m.text)
      .join("");
  const tools = messages.filter((m) => m.kind === "tool");
  const runningTools = tools.filter(
    (m) => parse(m.text)?.status === "Running",
  ).length;
  const elapsed = Math.max(
    0,
    Math.floor(
      (Date.parse(t.endedAt || new Date().toISOString()) -
        Date.parse(t.startedAt)) /
        1000,
    ),
  );
  const instruction =
    t.input.split("Task: ")[1]?.split("\n\nPrevious turns:")[0] || t.input;
  return (
    <section className="session-turn">
      {!initiallyExpanded && (
        <div className="turn-heading">
          <button className="plain" onClick={() => setExpanded(!expanded)}>
            {t.status === "running" ? "Working" : "Worked"} for {elapsed}s
            <Icon name="chevron-right" />
          </button>
          <span>
            Turn {String(index).padStart(2, "0")} · {time(t.startedAt)}
          </span>
        </div>
      )}
      {expanded && (
        <>
          <div className="task-message">
            <strong>Jev</strong>
            <p>{instruction}</p>
          </div>
          <div className="agent-answer">
            <div className="turn-heading">
              <span>
                {t.status === "running" ? "Working" : "Worked"} for {elapsed}s
              </span>
              <Icon name="chevron-right" />
            </div>
            {text && <p className="answer-text">{text}</p>}
            {tools.length > 0 && (
              <>
                <p className="tool-count">
                  {tools.length} tool calls
                  {runningTools > 0 && ` · ${runningTools} running`}
                </p>
                <div className="tool-trace">
                  {tools.map((m) => {
                    const tool = parse(m.text);
                    return (
                      <details key={m.id}>
                        <summary>
                          {tool?.toolName ||
                            tool?.command ||
                            tool?.type ||
                            "Tool execution"}{" "}
                          · {tool?.status || "Completed"}
                        </summary>
                        <pre>{m.text}</pre>
                      </details>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
