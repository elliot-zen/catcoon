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
import { sessionTools } from "./session-tools";
import { Icon } from "./icons";
type Row = Issue & { bindings: Binding[]; runningAgent: string | null };
type Config = {
  workspace: string;
  pathStyle: "posix" | "windows";
  jevConfigured: boolean;
  runtimeAvailable: Record<string, boolean>;
};
const labels: Record<Status, string> = {
  waiting_binding: "Waiting for binding",
  ready: "Open",
  routing: "Routing",
  running: "Running",
  waiting_human: "Needs attention",
  stopping: "Stopping",
  stopped: "Stopped",
  done: "Done",
};
const editable = (s: Status) =>
  ["waiting_binding", "ready", "stopped"].includes(s);
class ApiError extends Error {
  constructor(
    message: string,
    public field?: string,
  ) {
    super(message);
  }
}
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
  if (!res.ok)
    throw new ApiError(result.error || "Request failed.", result.field);
  return result;
}
function Badge({ status }: { status: Status }) {
  return (
    <span className={`badge badge-${status}`} data-status={status}>
      {labels[status]}
    </span>
  );
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
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
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
    [directoryError, setDirectoryError] = useState(""),
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
    setDirectoryError("");
    try {
      await fn();
      if (close) setModal(null);
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.field === "cwd")
        setDirectoryError(e.message);
      else setError((e as Error).message);
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
    setDirectoryError("");
    setEditingBinding(b);
    setModal("binding");
  }
  function editIssue() {
    setMore(false);
    setError("");
    setModal("edit");
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
  const humanRequestRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (pending && !session)
      humanRequestRef.current?.scrollIntoView({ block: "start" });
  }, [pending?.id, session]);

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
                  <Icon name="plus" />
                  New issue
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
            <SessionPage
              key={`${detail.id}:${session}`}
              detail={detail}
              bindingId={session}
              refresh={refresh}
              openIssue={() => setSession(null)}
            />
          ) : detail ? (
            <section className="detail-layout" data-node-id="10:2373">
              <div className="detail-main">
                {pending && (
                  <section
                    ref={humanRequestRef}
                    className="human-request"
                    aria-label="Human request"
                  >
                    <div className="activity-title">
                      <strong>Human · {pending.title}</strong>
                      <time>{time(pending.createdAt)}</time>
                    </div>
                    {detail.status === "waiting_human" ? (
                      <RequestActions
                        key={pending.id}
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
                    ) : (
                      <p className="muted">
                        This request is pending. Start the issue to approve or
                        answer it.
                      </p>
                    )}
                  </section>
                )}
                <div className="title-row">
                  <div className="issue-title">
                    <h1>{detail.title}</h1>
                    <button
                      className="plain issue-edit"
                      aria-label="Edit issue"
                      title="Edit issue"
                      disabled={busy}
                      onClick={editIssue}
                    >
                      <Icon name="edit" />
                    </button>
                  </div>
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
                        <Icon name="more" />
                      </button>
                      {more && (
                        <div className="more-menu">
                          <button
                            className="plain"
                            disabled={busy}
                            onClick={editIssue}
                          >
                            Edit
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
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
                            {summary && <p>{summary}</p>}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              </div>
              <aside className="detail-aside">
                <section
                  className="properties-card"
                  aria-label="Issue properties"
                >
                  <h3>Properties</h3>
                  <dl>
                    <dt>Status</dt>
                    <dd>
                      <Badge status={detail.status} />
                    </dd>
                    <dt>Folder</dt>
                    <dd className="property-folder">
                      <Icon name="folder" />
                      <span>Agent platform</span>
                    </dd>
                    <dt>Created by</dt>
                    <dd>
                      {(detail as Detail & { createdBy?: string }).createdBy ||
                        "you"}
                    </dd>
                    <dt>Created</dt>
                    <dd>
                      <time
                        dateTime={detail.createdAt}
                        title={new Date(detail.createdAt).toLocaleString()}
                      >
                        {date(detail.createdAt)}
                      </time>
                    </dd>
                    <dt>Updated</dt>
                    <dd>
                      <time
                        dateTime={detail.updatedAt}
                        title={new Date(detail.updatedAt).toLocaleString()}
                      >
                        {date(detail.updatedAt)}
                      </time>
                    </dd>
                    {detail.completedAt && (
                      <>
                        <dt>Completed</dt>
                        <dd>
                          <time
                            dateTime={detail.completedAt}
                            title={new Date(
                              detail.completedAt,
                            ).toLocaleString()}
                          >
                            {date(detail.completedAt)}
                          </time>
                        </dd>
                      </>
                    )}
                  </dl>
                </section>
                <div className="binding-card">
                  <div className="binding-heading">
                    <h3>Binding agents</h3>
                    <span>{detail.bindings.length}</span>
                    <button
                      className="plain"
                      aria-label="+ Add"
                      disabled={
                        !editable(detail.status) || !!pending?.native || busy
                      }
                      onClick={() => openBinding()}
                    >
                      <Icon name="plus" />
                      Add
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
                          <p className="binding-directory" title={b.cwd}>
                            {b.cwd}
                          </p>
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
                        </div>
                        <BindingActions
                          binding={b}
                          canEdit={editable(detail.status) && !busy}
                          edit={() => openBinding(b)}
                          session={() => setSession(b.id)}
                        />
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
        <Dialog
          title={editingBinding ? "Edit binding" : "Bind agent"}
          close={() => {
            if (!busy) setModal(null);
          }}
          error={error}
        >
          <BindingForm
            initial={editingBinding}
            config={config}
            busy={busy}
            canEdit={editable(detail.status)}
            approvalOnly={!!pending?.native}
            directoryLocked={
              !!editingBinding &&
              (!!editingBinding.sessionId ||
                detail.turns.some((t) => t.bindingId === editingBinding.id))
            }
            directoryError={directoryError}
            clearDirectoryError={() => setDirectoryError("")}
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
function BindingActions({
  binding,
  canEdit,
  edit,
  session,
}: {
  binding: Binding;
  canEdit: boolean;
  edit: () => void;
  session: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    ref.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <div
      className="binding-actions more-wrap"
      ref={ref}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          setOpen(false);
          trigger.current?.focus();
        }
        if (
          open &&
          ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
        ) {
          event.preventDefault();
          const items = Array.from(
            ref.current!.querySelectorAll<HTMLButtonElement>(
              '[role="menuitem"]:not(:disabled)',
            ),
          );
          const current = items.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : (current +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    items.length) %
                  items.length;
          items[next]?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        className="plain more-button"
        aria-label={`${binding.name} binding actions`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={`binding-menu-${binding.id}`}
        onClick={() => setOpen(!open)}
      >
        <Icon name="more" />
      </button>
      {open && (
        <div
          className="more-menu"
          role="menu"
          aria-label={`${binding.name} binding actions`}
          id={`binding-menu-${binding.id}`}
        >
          <button
            className="plain"
            role="menuitem"
            aria-label={`Edit ${binding.name} binding`}
            disabled={!canEdit}
            onClick={() => {
              setOpen(false);
              edit();
            }}
          >
            Edit
          </button>
          <button
            className="plain"
            role="menuitem"
            aria-label={`Open ${binding.name} session`}
            onClick={() => {
              setOpen(false);
              session();
            }}
          >
            Session
          </button>
        </div>
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
  approvalOnly = false,
  directoryLocked,
  directoryError,
  clearDirectoryError,
  close,
  submit,
}: {
  initial: Binding | null;
  config: Config | null;
  busy: boolean;
  canEdit: boolean;
  approvalOnly?: boolean;
  directoryLocked: boolean;
  directoryError: string;
  clearDirectoryError: () => void;
  close: () => void;
  submit: (data: unknown) => void;
}) {
  const [runtime, setRuntime] = useState(initial?.runtime || "codex"),
    [role, setRole] = useState(initial?.role || ""),
    [cwd, setCwd] = useState(initial?.cwd ?? config?.workspace ?? ""),
    [approvalLevel, setApprovalLevel] = useState<ApprovalLevel>(
      initial?.approvalLevel ??
        defaultApprovalLevel(initial?.runtime || "codex"),
    );
  const directoryTouched = useRef(false);
  useEffect(() => {
    if (!initial && !directoryTouched.current && config)
      setCwd(config.workspace || "");
  }, [config, initial]);
  const path = cwd.trim();
  const absolute =
    config?.pathStyle === "windows"
      ? /^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i.test(path)
      : path.startsWith("/");
  const localDirectoryError = !path
    ? "Working directory is required."
    : !absolute || path.includes("\0")
      ? "Enter an absolute path on the agent’s machine."
      : "";
  const fieldError = directoryError || localDirectoryError;
  return (
    <>
      <p className="dialog-description">
        {approvalOnly
          ? "Update the approval level for future turns. The suspended turn keeps its current policy and pending request."
          : "Set this agent’s responsibility, working directory, and approval level."}
      </p>
      <form
        className="dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (
            busy ||
            !canEdit ||
            localDirectoryError ||
            !role.trim() ||
            !config
          )
            return;
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
            cwd: path,
            model: initial?.model || "",
          });
        }}
      >
        <label>
          Agent runtime
          <div className="select-field">
            <select
              value={runtime}
              aria-label="Agent runtime"
              disabled={!canEdit || busy || approvalOnly}
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
            autoFocus={!approvalOnly}
            required
            value={role}
            disabled={!canEdit || busy || approvalOnly}
            onChange={(e) => setRole(e.target.value)}
          />
        </label>
        <div className="directory-field">
          <label htmlFor="binding-directory">Working directory *</label>
          <input
            id="binding-directory"
            required
            value={cwd}
            placeholder={
              config?.pathStyle === "windows"
                ? "C:\\projects\\my-project"
                : "/path/to/project"
            }
            readOnly={directoryLocked || approvalOnly}
            disabled={!canEdit || busy}
            aria-invalid={!!fieldError}
            aria-describedby={`directory-help${fieldError ? " directory-error" : ""}`}
            onChange={(e) => {
              directoryTouched.current = true;
              setCwd(e.target.value);
              clearDirectoryError();
            }}
          />
          <p id="directory-help">
            {directoryLocked ? (
              "This session uses the saved directory. Bind a new agent to choose another directory."
            ) : (
              <>
                Enter an existing absolute path on the agent’s machine.
                <br />
                Prefilled with the project directory. Saved for this agent only.
              </>
            )}
          </p>
          {fieldError && (
            <p id="directory-error" role="alert" className="directory-error">
              {fieldError}
            </p>
          )}
        </div>
        <div className="approval-field">
          <label>
            Approval level
            <div className="select-field">
              <select
                value={approvalLevel}
                autoFocus={approvalOnly}
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
              ? approvalLevel === "automatic"
                ? "Codex · Full access; sandbox disabled."
                : "Codex · Sandbox restrictions enabled; approvals reviewed by you."
              : "Pi · Tools use the permissions of the running environment."}
          </p>
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={
              busy ||
              !canEdit ||
              !role.trim() ||
              !config ||
              !!localDirectoryError
            }
          >
            {busy
              ? initial
                ? "Saving…"
                : "Binding…"
              : initial
                ? "Save binding"
                : "Bind agent"}
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
            {r.native?.method === "mcpServer/elicitation/request" &&
              r.native.params.mode === "url" &&
              /^https?:\/\//.test(r.native.params.url) && (
                <a href={r.native.params.url} target="_blank" rel="noreferrer">
                  Complete verification
                </a>
              )}
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
          {r.native?.method === "mcpServer/elicitation/request" && (
            <p>Enter a JSON object matching the requested form fields.</p>
          )}
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
  value,
  onChange,
  send,
  sending,
  blocked,
}: {
  agent: string;
  value: string;
  onChange: (value: string) => void;
  send: () => void;
  sending: boolean;
  blocked: boolean;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  return (
    <form
      className="chat-composer"
      aria-label="Message composer"
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest("button"))
          inputRef.current?.focus();
      }}
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <textarea
        ref={inputRef}
        aria-label={`Message ${agent}`}
        placeholder={`Message ${agent}…`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={20000}
        readOnly={sending}
        onKeyDown={(e) => {
          if (
            e.key === "Enter" &&
            !e.shiftKey &&
            !e.nativeEvent.isComposing &&
            e.keyCode !== 229
          ) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="composer-controls">
        <span className="muted">
          {sending ? "Sending…" : "Enter to send · Shift+Enter for a new line"}
        </span>
        <button
          className="primary"
          disabled={sending || blocked || !value.trim()}
          aria-label="Send message"
          type="submit"
        >
          <Icon name="send" />
        </button>
      </div>
    </form>
  );
}
function SessionPage({
  detail: d,
  bindingId,
  refresh,
  openIssue,
}: {
  detail: Detail;
  bindingId: string;
  refresh: () => Promise<void>;
  openIssue: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const historyRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const binding = d.bindings.find((b) => b.id === bindingId)!;
  const turns = d.turns.filter((t) => t.bindingId === bindingId);
  const latest = turns.at(-1);
  useEffect(() => {
    const history = historyRef.current;
    if (history && follow.current) history.scrollTop = history.scrollHeight;
  }, [d.messages.at(-1)?.id, latest?.id, latest?.output]);
  const current = d.turns.find((t) => t.id === d.currentTurnId);
  const pending = d.requests.find((r) => r.status === "pending");
  const blocked = pending
    ? "A human decision is required. Review the request at the top of the issue."
    : d.status === "running" && current?.bindingId !== bindingId
      ? "Another agent is working. Wait for it to finish or stop the issue before sending."
      : ["routing", "stopping", "waiting_human"].includes(d.status)
        ? "Wait for the current step to finish before sending."
        : "";
  async function send() {
    const message = draft.trim();
    if (!message || blocked || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setError("");
    try {
      await api(`/issues/${d.id}/bindings/${bindingId}/messages`, "POST", {
        message,
        turnId: d.currentTurnId,
      });
      follow.current = true;
      setDraft("");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      await refresh();
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }
  return (
    <section className="session-page" data-node-id="63:475">
      <div className="session-header">
        <h1>{binding.name}</h1>
        <Badge status={latest?.status === "running" ? "running" : d.status} />
      </div>
      <p className="session-meta">
        {binding.role} · Session {binding.sessionId || "—"}
      </p>
      <div
        className="conversation-history"
        ref={historyRef}
        onScroll={(e) => {
          const element = e.currentTarget;
          follow.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            80;
        }}
      >
        {!turns.length && <p className="muted">No session history yet.</p>}
        {turns.map((t) => (
          <SessionTurn
            key={t.id}
            turn={t}
            detail={d}
            initiallyExpanded={t.id === latest?.id}
          />
        ))}
      </div>
      <div className="session-compose">
        {blocked && (
          <div className="session-notice" role="status">
            <span>{blocked}</span>
            <button onClick={openIssue}>Open issue</button>
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <Composer
          agent={binding.name}
          value={draft}
          onChange={setDraft}
          send={() => void send()}
          sending={sending}
          blocked={!!blocked}
        />
      </div>
    </section>
  );
}
function SessionTurn({
  turn: t,
  detail: d,
  initiallyExpanded,
}: {
  initiallyExpanded: boolean;
  turn: Turn;
  detail: Detail;
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [clock, setClock] = useState(Date.now);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const active = t.status === "running" && !t.endedAt;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const messages = d.messages.filter((m) => m.turnId === t.id);
  const text =
    t.output ||
    messages
      .filter((m) => m.kind === "assistant_delta")
      .map((m) => m.text)
      .join("") ||
    messages.filter((m) => m.kind === "assistant").at(-1)?.text ||
    "";
  const tools = sessionTools(messages);
  const thinking = active && !text && !tools.length;
  const elapsed = Math.max(
    0,
    Math.floor(
      ((t.endedAt ? Date.parse(t.endedAt) : clock) - Date.parse(t.startedAt)) /
        1000,
    ),
  );
  const instruction =
    t.input
      .split("Task: ")[1]
      ?.split(/\n\n(?:Execution mode:|Previous turns:)/)[0] || t.input;
  const human = messages.find((m) => m.kind === "user");
  const steered = messages.some((m) =>
    ["user_steer", "user_pending", "user_unconfirmed"].includes(m.kind),
  );
  const conversation: {
    id: number;
    kind: "assistant" | "user" | "pending" | "unconfirmed";
    text: string;
  }[] = [];
  let deltaSeen = false;
  for (const m of messages) {
    if (["user_steer", "user_pending", "user_unconfirmed"].includes(m.kind)) {
      conversation.push({
        id: m.id,
        kind:
          m.kind === "user_pending"
            ? "pending"
            : m.kind === "user_unconfirmed"
              ? "unconfirmed"
              : "user",
        text: m.text,
      });
    } else if (
      m.kind === "assistant_delta" ||
      (m.kind === "assistant" && !deltaSeen)
    ) {
      const previous = conversation.at(-1);
      if (previous?.kind === "assistant") previous.text += m.text;
      else conversation.push({ id: m.id, kind: "assistant", text: m.text });
      if (m.kind === "assistant_delta") deltaSeen = true;
    } else if (m.kind === "assistant") {
      deltaSeen = false;
    }
  }
  const streamed = conversation
    .filter((entry) => entry.kind === "assistant")
    .map((entry) => entry.text)
    .join("");
  const progress = thinking
    ? "Thinking…"
    : t.status === "waiting_approval"
      ? "Waiting for approval"
      : t.status === "failed"
        ? `Failed after ${elapsed} s`
        : t.status === "interrupted"
          ? `Interrupted after ${elapsed} s`
          : `${active ? "Working" : "Worked"} for ${elapsed} s`;
  async function copyAnswer() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setCopyError("");
    } catch {
      setCopyError("Could not copy the answer. Select the text to copy it.");
    }
  }
  return (
    <section className="session-turn">
      {(human?.text || instruction) && (
        <div className="task-message">
          {!human && <strong>Jev</strong>}
          <p>{human?.text || instruction}</p>
        </div>
      )}
      <div className="agent-answer">
        <div className={`turn-heading ${thinking ? "thinking" : ""}`}>
          {tools.length ? (
            <button
              className="plain"
              aria-expanded={expanded}
              aria-label={`${progress}, ${expanded ? "hide" : "show"} tool activity`}
              onClick={() => setExpanded(!expanded)}
            >
              {progress}
              <Icon name={expanded ? "chevron-down" : "chevron-right"} />
            </button>
          ) : (
            <span>{progress}</span>
          )}
        </div>
        {tools.length > 0 && expanded && (
          <div className="tool-trace" aria-label="Tool activity">
            {tools.map((tool) => (
              <details
                key={tool.id}
                className={`session-tool tool-${tool.status}`}
              >
                <summary>
                  <span className="tool-status" aria-label={tool.status} />
                  <span>{tool.label}</span>
                </summary>
                <pre>{tool.detail}</pre>
              </details>
            ))}
          </div>
        )}
        {!steered && text && <p className="answer-text">{text}</p>}
        {steered &&
          conversation.map((entry) =>
            entry.kind === "assistant" ? (
              <p key={entry.id} className="answer-text">
                {entry.text}
              </p>
            ) : (
              <div key={entry.id} className="task-message">
                {entry.kind !== "user" && (
                  <strong>
                    {entry.kind === "pending" ? "Sending…" : ""}
                    {entry.kind === "unconfirmed"
                      ? " · Delivery unconfirmed after restart"
                      : ""}
                  </strong>
                )}
                <p>{entry.text}</p>
              </div>
            ),
          )}
        {steered &&
          t.status === "completed" &&
          t.output &&
          !streamed.endsWith(t.output) && (
            <p className="answer-text">{t.output}</p>
          )}
        {steered && t.status === "failed" && t.output && (
          <p className="form-error" role="alert">
            {t.output}
          </p>
        )}
        {t.status === "completed" && text && (
          <div className="answer-actions">
            <button
              className="plain copy-answer"
              aria-label={copied ? "Answer copied" : "Copy answer"}
              onClick={() => void copyAnswer()}
            >
              <Icon name="copy" />
            </button>
            {copied && <span role="status">Copied</span>}
          </div>
        )}
        {copyError && (
          <p className="form-error" role="alert">
            {copyError}
          </p>
        )}
      </div>
    </section>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
