import { useEffect, useState } from "react";
import { Folder, GitBranch, FileText, Plus } from "lucide-react";
import type { State, Project, Worktree } from "../server/types";
import { Button, Field, Modal, Empty, DirectoryPicker } from "./components";
import { api, ApiError } from "./api";
import type { Action } from "./api";
import type { T } from "./i18n";
export function ProjectCreate({
  action,
  t,
  onClose,
  onCreate,
}: {
  action: Action;
  t: T;
  onClose: () => void;
  onCreate: (p: Project) => void;
}) {
  const [name, setName] = useState(""),
    [path, setPath] = useState(""),
    [pending, setPending] = useState(false);
  return (
    <Modal title={t("New project")} onClose={onClose}>
      <div className="space-y-4">
        <Field label={t("Project name")}>
          <input
            autoFocus
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label={t("Local directory")}>
          <DirectoryPicker value={path} onChange={setPath} t={t} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button
            variant="primary"
            disabled={pending || !name.trim() || !path.trim()}
            onClick={() => {
              setPending(true);
              void action("project.create", { name, path })
                .then((p) => onCreate(p))
                .catch(() => {})
                .finally(() => setPending(false));
            }}
          >
            {t("New project")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
export function Projects({
  state: s,
  action,
  t,
  onOpen,
}: {
  state: State;
  action: Action;
  t: T;
  onOpen: (id: string) => void;
}) {
  const [create, setCreate] = useState(false);
  return (
    <>
      <div className="flex items-center px-6 py-5">
        <h1 className="text-base font-semibold">{t("Projects")}</h1>
        <Button
          className="ml-auto"
          variant="primary"
          onClick={() => setCreate(true)}
        >
          <Plus size={13} />
          {t("New project")}
        </Button>
      </div>
      <div className="grid grid-cols-[2fr_1fr_90px_100px_1fr] gap-3 border-y border-border px-6 py-2 text-[11px] muted">
        {["Name", "Health", "Worktrees", "Active issues", "Last activity"].map(
          (x) => (
            <span key={x}>{t(x)}</span>
          ),
        )}
      </div>
      {!s.projects.length && <Empty>{t("No projects yet")}</Empty>}
      {s.projects.map((p) => {
        const bindings = s.bindings.filter(
          (b) => b.projectId === p.id && !b.removed,
        );
        const active = s.issues.filter(
          (i) =>
            ["In progress", "Human input"].includes(i.status) &&
            bindings.some((b) => b.issueId === i.id),
        );
        return (
          <button
            key={p.id}
            onClick={() => onOpen(p.id)}
            className="grid w-full grid-cols-[2fr_1fr_90px_100px_1fr] items-center gap-3 border-b border-border px-6 py-4 text-left hover:bg-muted"
          >
            <div className="flex items-center gap-3">
              <Folder size={16} className="text-violet-500" />
              <div>
                <p className="font-medium">{p.name}</p>
                <p className="mt-1 text-[11px] muted truncate">{p.path}</p>
              </div>
            </div>
            <span className="text-xs" title={p.healthReason}>
              {p.health === "healthy" ? "●" : "◌"} {t(p.health)}
            </span>
            <span>
              {s.worktrees.filter((w) => w.projectId === p.id).length}
            </span>
            <span>{active.length}</span>
            <span className="text-xs muted">
              {active
                .map((i) => i.updatedAt)
                .sort()
                .at(-1)
                ?.slice(0, 16) || "—"}
            </span>
          </button>
        );
      })}
      {create && (
        <ProjectCreate
          action={action}
          t={t}
          onClose={() => setCreate(false)}
          onCreate={(p) => {
            setCreate(false);
            onOpen(p.id);
          }}
        />
      )}
    </>
  );
}
function WorktreeCreate({
  project,
  action,
  t,
  onClose,
  onCreate,
}: {
  project: Project;
  action: Action;
  t: T;
  onClose: () => void;
  onCreate: (w: Worktree) => void;
}) {
  const [form, setForm] = useState({
    name: "",
    branch: "",
    path: "",
    specName: "",
    specDir: "docs",
  });
  const [pending, setPending] = useState(false);
  const field = (key: keyof typeof form, label: string) => (
    <Field label={t(label)}>
      <input
        className="field"
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
    </Field>
  );
  return (
    <Modal title={t("New worktree")} onClose={onClose}>
      <p className="mb-4 text-xs muted">
        {t(
          "Register an existing Git worktree; no directory or branch is created.",
        )}
      </p>
      <div className="space-y-4">
        {field("name", "Name")}
        <div className="grid grid-cols-2 gap-3">
          {field("branch", "Branch")}
          {field("specName", "Spec")}
        </div>
        {field("specDir", "Spec directory")}
        <Field label={t("Worktree directory")}>
          <DirectoryPicker
            value={form.path}
            onChange={(path) => setForm({ ...form, path })}
            t={t}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button
            variant="primary"
            disabled={pending || Object.values(form).some((x) => !x.trim())}
            onClick={() => {
              setPending(true);
              void action("worktree.create", { projectId: project.id, ...form })
                .then(onCreate)
                .catch(() => {})
                .finally(() => setPending(false));
            }}
          >
            {t("New worktree")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
export function ProjectDetail({
  project: p,
  state: s,
  action,
  t,
  onError,
}: {
  project: Project;
  state: State;
  action: Action;
  t: T;
  onError: (e: string) => void;
}) {
  const trees = s.worktrees.filter((w) => w.projectId === p.id);
  const [selected, setSelected] = useState(trees[0]?.id || ""),
    [doc, setDoc] = useState("product"),
    [create, setCreate] = useState(false);
  const w = trees.find((w) => w.id === selected) || trees[0];
  return (
    <>
      <div className="flex items-center gap-3 border-b border-border px-6 py-5">
        <Folder size={25} className="text-violet-500" />
        <div>
          <h1 className="font-semibold">{p.name}</h1>
          <p className="mt-1 text-xs muted">{p.path}</p>
          <p className="mt-1 text-[11px] muted">
            {t(p.health)} · {p.healthReason}
          </p>
        </div>
        <Button
          className="ml-auto"
          variant="primary"
          onClick={() => setCreate(true)}
        >
          <Plus size={13} />
          {t("New worktree")}
        </Button>
      </div>
      <div className="grid min-h-[calc(100vh-140px)] grid-cols-1 md:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="border-r border-border p-3">
          <p className="mb-3 px-2 text-[11px] muted">
            {t("Worktrees")} · {trees.length}
          </p>
          {trees.map((w) => (
            <Button
              key={w.id}
              onClick={() => setSelected(w.id)}
              className={`mb-1 w-full justify-start py-3 text-left ${w.id === selected ? "bg-muted" : ""}`}
            >
              <GitBranch size={14} />
              <span>
                <span className="block text-foreground">{w.name}</span>
                <span className="text-[10px]">{w.branch}</span>
              </span>
            </Button>
          ))}
          {!trees.length && <Empty>{t("No worktrees yet")}</Empty>}
        </aside>
        {w ? (
          <div className="min-w-0">
            <div className="border-b border-border px-6 py-4">
              <div className="flex items-center gap-2">
                <GitBranch size={14} />
                <strong>{w.name}</strong>
                <span className="muted">{w.branch}</span>
              </div>
              <p className="mt-2 text-xs muted">{w.path}</p>
              <p className="mt-4 flex items-center gap-2 text-xs">
                <FileText size={14} className="text-violet-500" />
                {w.specName}
                <span className="muted">{t("Bound spec")}</span>
              </p>
            </div>
            <div className="flex border-b border-border px-4">
              {["product", "tech"].map((d) => (
                <Button
                  key={d}
                  className={`h-10 rounded-none ${doc === d ? "border-b-2 border-foreground text-foreground" : ""}`}
                  onClick={() => setDoc(d)}
                >
                  <FileText size={12} />
                  {d.toUpperCase()}.md
                </Button>
              ))}
            </div>
            <SpecEditor
              key={`${w.id}:${doc}`}
              worktree={w}
              document={doc}
              state={s}
              action={action}
              t={t}
              onError={onError}
            />
          </div>
        ) : (
          <Empty>{t("No worktrees yet")}</Empty>
        )}
      </div>
      {create && (
        <WorktreeCreate
          project={p}
          action={action}
          t={t}
          onClose={() => setCreate(false)}
          onCreate={(w) => {
            setCreate(false);
            setSelected(w.id);
          }}
        />
      )}
    </>
  );
}
function SpecEditor({
  worktree: w,
  document: doc,
  state: s,
  action,
  t,
  onError,
}: {
  worktree: Worktree;
  document: string;
  state: State;
  action: Action;
  t: T;
  onError: (s: string) => void;
}) {
  const draftKey = `spec:${w.id}:${doc}`;
  const [loaded, setLoaded] = useState<{
    content: string;
    version: string;
    path: string;
  }>();
  const [value, setValue] = useState(""),
    [saved, setSaved] = useState(""),
    [pending, setPending] = useState(false),
    [conflict, setConflict] = useState<{
      content: string;
      version: string;
      path: string;
    }>();
  const [issueId, setIssue] = useState("");
  const [saveKey, setSaveKey] = useState(crypto.randomUUID());
  useEffect(() => {
    let disposed = false;
    void api(`/api/spec?worktreeId=${w.id}&document=${doc}`)
      .then((d) => {
        if (disposed) return;
        setLoaded(d);
        setSaved(d.content);
        const local = sessionStorage.getItem(draftKey);
        if (local) {
          try {
            const draft = JSON.parse(local);
            setValue(draft.content);
            if (draft.version !== d.version) setConflict(d);
          } catch {
            setValue(local);
          }
        } else setValue(d.content);
      })
      .catch((e) => onError(e.message));
    return () => {
      disposed = true;
    };
  }, [draftKey]);
  const edit = (v: string) => {
    setValue(v);
    setSaveKey(crypto.randomUUID());
    sessionStorage.setItem(
      draftKey,
      JSON.stringify({ content: v, version: loaded?.version }),
    );
  };
  const save = async () => {
    setPending(true);
    try {
      const r = await api(
        "/api/spec",
        "PUT",
        {
          worktreeId: w.id,
          document: doc,
          content: value,
          version: loaded?.version,
        },
        saveKey,
      );
      setLoaded(r.result);
      setSaved(value);
      setConflict(undefined);
      sessionStorage.removeItem(draftKey);
    } catch (e) {
      if (e instanceof ApiError && e.code === "SPEC_CONFLICT")
        setConflict(e.details);
      onError((e as Error).message);
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-3">
        <span className="min-w-0 flex-1 break-all text-[11px] muted">
          {loaded?.path}
        </span>
        <span className="text-xs muted">
          {!loaded
            ? t("Loading…")
            : conflict
              ? t("Conflict")
              : pending
                ? t("Saving…")
                : value === saved
                  ? t("Saved locally")
                  : t("Unsaved")}
        </span>
        <Button
          variant="outline"
          disabled={!loaded || pending || value === saved || !!conflict}
          onClick={() => void save()}
        >
          {t("Save")}
        </Button>
      </div>
      {conflict && (
        <div className="m-4 rounded border border-amber-400/50 bg-amber-400/5 p-4">
          <details>
            <summary>{t("External content")}</summary>
            <pre className="mt-2 text-xs">{conflict.content}</pre>
          </details>
          <Button
            className="mt-2"
            variant="outline"
            onClick={() => {
              setLoaded(conflict);
              setConflict(undefined);
              setSaved(conflict.content);
              sessionStorage.setItem(
                draftKey,
                JSON.stringify({ content: value, version: conflict.version }),
              );
              setSaveKey(crypto.randomUUID());
            }}
          >
            {t("Use latest version as base")}
          </Button>
        </div>
      )}
      <textarea
        aria-label={`${doc.toUpperCase()}.md`}
        disabled={!loaded}
        spellCheck={false}
        className="min-h-[450px] w-full resize-y bg-transparent px-6 py-5 font-mono text-xs leading-6 outline-none"
        value={value}
        onChange={(e) => edit(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-6 py-3">
        <select
          className="field max-w-64"
          value={issueId}
          onChange={(e) => setIssue(e.target.value)}
        >
          <option value="">{t("Select issue")}</option>
          {s.issues
            .filter(
              (i) =>
                i.status !== "Done" &&
                s.bindings.some(
                  (b) =>
                    b.issueId === i.id && b.worktreeId === w.id && !b.removed,
                ),
            )
            .map((i) => (
              <option key={i.id} value={i.id}>
                {i.number} · {i.title}
              </option>
            ))}
        </select>
        <Button
          variant="outline"
          disabled={!issueId || !value.trim() || value !== saved}
          onClick={() =>
            void action("artifact.publish", {
              issueId,
              title: `${w.specName} · ${doc.toUpperCase()}.md`,
              kind: "spec",
              content: saved,
              worktreeId: w.id,
            }).catch(() => {})
          }
        >
          {t("Publish version")}
        </Button>
      </div>
    </>
  );
}
