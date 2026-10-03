import { useEffect, useState } from "react";
import {
  Box,
  Search,
  Plus,
  Inbox as InboxIcon,
  Bot,
  Folder,
  Settings as SettingsIcon,
  Moon,
  Sun,
  Languages,
  ChevronRight,
  Archive,
  Eye,
  EyeOff,
  X,
  Menu,
} from "lucide-react";
import { useRelay } from "./api";
import type { Action } from "./api";
import type { State } from "../server/types";
import { activeRun } from "../server/types";
import { Button, Empty, RequestCard } from "./components";
import { Issues, IssueDetail, IssueCreate } from "./Issues";
import { Projects, ProjectDetail } from "./Projects";
import { zh, eventNames } from "./i18n";
import type { T } from "./i18n";
function SettingsPage({
  state: s,
  action,
  t,
  busy,
}: {
  state: State;
  action: Action;
  t: T;
  busy: boolean;
}) {
  const [key, setKey] = useState(""),
    [show, setShow] = useState(false),
    [changed, setChanged] = useState(false);
  return (
    <main className="mx-auto max-w-3xl px-8 py-10">
      <h1 className="text-lg font-semibold">{t("Settings")}</h1>
      <section className="mt-8 rounded-lg border border-border bg-card p-6">
        <h2 className="font-medium">{t("Jev API key")}</h2>
        <p className="mt-2 text-xs muted">
          {t("Saved configuration is used for connection tests.")}
        </p>
        <div className="mt-5 flex gap-2">
          <input
            aria-label={t("Jev API key")}
            autoComplete="off"
            className="field"
            type={show ? "text" : "password"}
            value={key}
            placeholder={s.settings.configured ? "••••••••••••••••" : "ts-…"}
            onChange={(e) => {
              setKey(e.target.value);
              setChanged(true);
            }}
          />
          <Button
            aria-label={show ? "Hide key" : "Show key"}
            onClick={() => setShow(!show)}
          >
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </Button>
        </div>
        <div className="mt-4 flex gap-2">
          <Button
            variant="primary"
            disabled={busy || !key.trim()}
            onClick={() =>
              void action("settings.save", { apiKey: key })
                .then(() => {
                  setKey("");
                  setChanged(false);
                })
                .catch(() => {})
            }
          >
            {t("Save changes")}
          </Button>
          <Button
            variant="outline"
            disabled={busy || changed || !s.settings.configured}
            onClick={() => void action("settings.test").catch(() => {})}
          >
            {t("Test connection")}
          </Button>
        </div>
        <p className="mt-4 text-xs muted">
          {changed
            ? t("Unsaved")
            : t(s.settings.configured ? "Configured" : "Not configured")}
        </p>
        {!changed && s.settings.testedAt && (
          <p
            className={`mt-2 text-xs ${s.settings.connection === "connected" ? "text-emerald-600" : "text-rose-500"}`}
          >
            {s.settings.connection === "connected"
              ? t("Connected")
              : s.settings.connection}{" "}
            · {new Date(s.settings.testedAt).toLocaleString()}
          </p>
        )}
      </section>
    </main>
  );
}
function AgentPage({
  state: s,
  action,
  t,
}: {
  state: State;
  action: Action;
  t: T;
}) {
  const installed = s.agents.filter((a) => a.status !== "missing");
  return (
    <main>
      <div className="flex items-center px-6 py-6">
        <div>
          <h1 className="text-base font-semibold">{t("Agent")}</h1>
          <p className="mt-2 text-xs muted">
            {installed.filter((a) => a.status === "available").length}{" "}
            {t("Available")} ·{" "}
            {t(
              "Version probe confirms the tool responds; execution checks authentication.",
            )}
          </p>
        </div>
        <Button
          className="ml-auto"
          variant="outline"
          onClick={() => void action("agents.refresh").catch(() => {})}
        >
          {t("Refresh")}
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead className="border-y border-border bg-muted/30 text-[11px] muted">
            <tr>
              {["Service", "Status", "Version", "Active runs", "Heartbeat"].map(
                (x) => (
                  <th key={x} className="px-6 py-3 font-normal">
                    {t(x)}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {s.agents.map((a) => (
              <tr key={a.id} className="border-b border-border">
                <td className="px-6 py-5">
                  <span className="flex items-center gap-2">
                    <Bot size={16} className="text-violet-500" />
                    {a.name}
                  </span>
                  <span className="mt-1 block text-[11px] muted">
                    {a.command}
                  </span>
                </td>
                <td className="px-6 py-5">
                  <span
                    className={
                      a.status === "available"
                        ? "text-emerald-600"
                        : "text-amber-500"
                    }
                  >
                    {t(a.status)}
                  </span>
                  <p className="mt-1 max-w-64 text-[10px] muted">{a.reason}</p>
                </td>
                <td className="px-6 py-5 text-xs muted">{a.version || "—"}</td>
                <td className="px-6 py-5">
                  {
                    s.runs.filter(
                      (r) => r.snapshot.agentId === a.id && activeRun(r),
                    ).length
                  }
                </td>
                <td className="px-6 py-5 text-xs muted">
                  {a.heartbeat ? new Date(a.heartbeat).toLocaleString() : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
function InboxPage({
  state: s,
  action,
  t,
  onOpen,
  busy,
}: {
  state: State;
  action: Action;
  t: T;
  onOpen: (id: string) => void;
  busy: boolean;
}) {
  const [archived, setArchived] = useState(false),
    [filter, setFilter] = useState("All"),
    [selected, setSelected] = useState("");
  const ns = s.notifications
    .filter(
      (n) =>
        n.archived === archived && (filter === "All" || n.category === filter),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const n = s.notifications.find((x) => x.id === selected);
  const r = s.requests.find((r) => r.id === n?.requestId);
  const i = s.issues.find((i) => i.id === r?.issueId);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
        <Button
          className={!archived ? "bg-muted" : ""}
          onClick={() => {
            setArchived(false);
            setSelected("");
          }}
        >
          {t("Inbox")}
        </Button>
        <Button
          className={archived ? "bg-muted" : ""}
          onClick={() => {
            setArchived(true);
            setSelected("");
          }}
        >
          {t("Archived")}
        </Button>
        <div className="ml-auto flex gap-1">
          {["All", "Triage", "Review", "Agent"].map((f) => (
            <Button
              key={f}
              className={filter === f ? "bg-muted" : ""}
              onClick={() => {
                setFilter(f);
                setSelected("");
              }}
            >
              {t(f)}
            </Button>
          ))}
        </div>
      </div>
      <div className="grid min-h-[calc(100vh-90px)] grid-cols-1 md:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="border-r border-border">
          {!ns.length && <Empty>{t("No notifications")}</Empty>}
          {ns.map((n) => {
            const request = s.requests.find((r) => r.id === n.requestId);
            return (
              <button
                key={n.id}
                className={`w-full border-b border-border px-5 py-4 text-left hover:bg-muted ${selected === n.id ? "bg-muted" : ""}`}
                onClick={() => {
                  setSelected(n.id);
                  if (!n.read)
                    void action("notification.update", {
                      notificationId: n.id,
                      read: true,
                    }).catch(() => {});
                }}
              >
                <div className="flex items-center gap-2 text-[11px] muted">
                  <span
                    className={`size-1.5 rounded-full ${n.read ? "bg-transparent" : "bg-violet-500"}`}
                  />
                  {n.category}
                  <span className="ml-auto">
                    {new Date(n.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <p className="mt-2 text-xs font-medium">{request?.title}</p>
                <p className="mt-2 text-[11px] muted">
                  {t(request?.status || "Unknown")}
                </p>
              </button>
            );
          })}
        </aside>
        <section className="min-w-0 p-6 md:px-10">
          {n && r ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" onClick={() => onOpen(r.issueId)}>
                  {i?.number} <ChevronRight size={12} />
                  {t("Open issue")}
                </Button>
                <Button
                  className="ml-auto"
                  onClick={() =>
                    void action("notification.update", {
                      notificationId: n.id,
                      archived: !n.archived,
                    }).catch(() => {})
                  }
                >
                  <Archive size={13} />
                  {t(n.archived ? "Unarchive" : "Archive")}
                </Button>
              </div>
              <h1 className="mt-6 text-base font-semibold">{r.title}</h1>
              <RequestCard
                key={r.id}
                request={r}
                state={s}
                action={action}
                t={t}
                busy={busy}
              />
            </>
          ) : (
            <Empty>{t("Choose a notification")}</Empty>
          )}
        </section>
      </div>
    </>
  );
}
export default function App() {
  const relay = useRelay();
  const {
    state: s,
    action,
    error,
    setError,
    busy,
    connection,
    lastUpdate,
  } = relay;
  const [route, setRoute] = useState(location.hash.slice(1) || "issues");
  const [create, setCreate] = useState(false),
    [search, setSearch] = useState(""),
    [theme, setTheme] = useState(localStorage.getItem("theme") || "light"),
    [language, setLanguage] = useState(
      localStorage.getItem("language") || "en",
    ),
    [sidebar, setSidebar] = useState(false);
  const t: T = (key) =>
    language === "zh" ? zh[key] || key : eventNames[key] || key;
  useEffect(() => {
    const update = () => {
      setRoute(location.hash.slice(1) || "issues");
      setSidebar(false);
    };
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("theme", theme);
  }, [theme]);
  useEffect(() => {
    document.documentElement.lang = language;
    localStorage.setItem("language", language);
  }, [language]);
  const navigate = (route: string) => {
    location.hash = route;
  };
  const [view, selected] = route.split("/");
  const issue = s?.issues.find((i) => i.id === selected),
    project = s?.projects.find((p) => p.id === selected);
  const nav = (
    label: string,
    icon: React.ReactNode,
    page: string,
    count?: number,
  ) => (
    <Button
      onClick={() => navigate(page)}
      className={`mb-0.5 h-8 w-full justify-start text-[13px] font-normal ${view === page || (page === "issues" && view === "issue") || (page === "projects" && view === "project") ? "bg-sidebar-accent text-foreground" : ""}`}
    >
      {icon}
      <span className="flex-1 text-left">{t(label)}</span>
      {count !== undefined && (
        <span className="text-[11px] muted">{count}</span>
      )}
    </Button>
  );
  return (
    <div className="flex min-h-screen bg-canvas text-foreground">
      <aside
        className={`${sidebar ? "fixed inset-y-0 left-0 z-40 shadow-xl" : "hidden"} w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar p-3 md:sticky md:top-0 md:flex md:h-screen`}
      >
        <div className="flex h-9 items-center gap-2 px-2 text-sm font-semibold">
          <span className="flex size-5 items-center justify-center rounded bg-violet-600 text-white">
            <Box size={12} />
          </span>
          Relay{" "}
          <Button
            className="ml-auto md:hidden"
            onClick={() => setSidebar(false)}
          >
            <X size={14} />
          </Button>
        </div>
        <div className="mt-4">
          {nav("Search", <Search size={14} />, "search")}
          <Button
            className="h-8 w-full justify-start"
            onClick={() => setCreate(true)}
          >
            <Plus size={14} />
            {t("New issue")}
          </Button>
        </div>
        <nav className="mt-5">
          {nav(
            "Inbox",
            <InboxIcon size={14} />,
            "inbox",
            s?.notifications.filter((n) => !n.read && !n.archived).length || 0,
          )}
          {nav("Issues", <Box size={14} />, "issues", s?.issues.length || 0)}
          {nav(
            "Agent",
            <Bot size={14} />,
            "agents",
            s?.agents.filter((a) => a.status !== "missing").length || 0,
          )}
          {nav(
            "Projects",
            <Folder size={14} />,
            "projects",
            s?.projects.length || 0,
          )}
        </nav>
        <p className="mt-6 px-2 text-[11px] muted">{t("Projects")}</p>
        <nav className="mt-2">
          {s?.projects.map((p) => (
            <Button
              key={p.id}
              className="w-full justify-start pl-4 text-xs"
              onClick={() => navigate(`project/${p.id}`)}
            >
              <span className="size-1.5 rounded-full bg-violet-500" />
              {p.name}
            </Button>
          ))}
        </nav>
        <div className="mt-auto flex gap-1 border-t border-sidebar-border pt-3">
          <Button
            aria-label={t("Settings")}
            className={view === "settings" ? "bg-muted" : ""}
            onClick={() => navigate("settings")}
          >
            <SettingsIcon size={14} />
          </Button>
          <Button
            aria-label="Toggle theme"
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          >
            {theme === "light" ? <Moon size={14} /> : <Sun size={14} />}
          </Button>
          <Button
            aria-label="Switch language"
            onClick={() => setLanguage(language === "en" ? "zh" : "en")}
          >
            <Languages size={14} />
          </Button>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 flex h-10 items-center gap-2 border-b border-border bg-canvas/95 px-4 backdrop-blur">
          <Button className="md:hidden" onClick={() => setSidebar(!sidebar)}>
            <Menu size={14} />
          </Button>
          <Box size={14} className="text-blue-500" />
          <span className="text-xs font-medium">Relay</span>
          <ChevronRight size={12} className="muted" />
          {view === "search" ? (
            <>
              <input
                autoFocus
                className="min-w-0 flex-1 bg-transparent outline-none text-xs"
                placeholder={t("Search by number, title or project")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <Button onClick={() => setSearch("")}>{t("Clear")}</Button>
              )}
            </>
          ) : (
            <span className="truncate text-xs">
              {issue
                ? `${issue.number} · ${issue.title}`
                : project
                  ? project.name
                  : t(
                      view === "agents"
                        ? "Agent"
                        : view === "inbox"
                          ? "Inbox"
                          : view === "settings"
                            ? "Settings"
                            : view === "projects"
                              ? "Projects"
                              : "Issues",
                    )}
            </span>
          )}
          {connection && (
            <span className="ml-auto text-[10px] text-rose-500">
              {t("Connection lost")} · {t("Last updated")} {lastUpdate}
            </span>
          )}
        </header>
        {error && (
          <div
            role="alert"
            className="flex items-center gap-2 border-b border-rose-300 bg-rose-500/5 px-5 py-3 text-xs text-rose-500"
          >
            {error}
            <Button className="ml-auto" onClick={() => setError("")}>
              <X size={12} />
            </Button>
          </div>
        )}
        {!s ? (
          <Empty>{t("Loading…")}</Empty>
        ) : view === "issue" && issue ? (
          <IssueDetail
            key={issue.id}
            issue={issue}
            state={s}
            action={action}
            t={t}
            busy={busy}
          />
        ) : view === "project" && project ? (
          <ProjectDetail
            key={project.id}
            project={project}
            state={s}
            action={action}
            t={t}
            onError={setError}
          />
        ) : view === "projects" ? (
          <Projects
            state={s}
            action={action}
            t={t}
            onOpen={(id) => navigate(`project/${id}`)}
          />
        ) : view === "settings" ? (
          <SettingsPage state={s} action={action} t={t} busy={busy} />
        ) : view === "agents" ? (
          <AgentPage state={s} action={action} t={t} />
        ) : view === "inbox" ? (
          <InboxPage
            state={s}
            action={action}
            t={t}
            onOpen={(id) => navigate(`issue/${id}`)}
            busy={busy}
          />
        ) : (
          <Issues
            state={s}
            t={t}
            onOpen={(id) => navigate(`issue/${id}`)}
            onCreate={() => setCreate(true)}
            search={view === "search" ? search : undefined}
          />
        )}
      </div>
      {create && (
        <IssueCreate
          action={action}
          t={t}
          onClose={() => setCreate(false)}
          onCreate={(i, more) => {
            if (!more) {
              setCreate(false);
              navigate(`issue/${i.id}`);
            }
          }}
        />
      )}
    </div>
  );
}
