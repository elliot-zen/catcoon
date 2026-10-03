import {
  useState,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type ButtonHTMLAttributes,
} from "react";
import {
  X,
  Folder,
  ChevronRight,
  ArrowUp,
  ShieldCheck,
  MessageSquare,
} from "lucide-react";
import type { Request, State, Artifact } from "../server/types";
import { api, useDraft } from "./api";
import type { Action } from "./api";
import type { T } from "./i18n";
export function Button({
  variant = "",
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) {
  return (
    <button {...props} className={`btn ${variant} ${className}`}>
      {children}
    </button>
  );
}
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium">{label}</span>
      {isValidElement(children) &&
      typeof children.type === "string" &&
      ["input", "select", "textarea"].includes(children.type)
        ? cloneElement(children as ReactElement<{ "aria-label"?: string }>, {
            "aria-label": label,
          })
        : children}
    </label>
  );
}
export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/25 px-4 py-16"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`w-full ${wide ? "max-w-3xl" : "max-w-lg"} rounded-xl border border-border bg-card shadow-xl`}
      >
        <header className="flex items-center border-b border-border px-5 py-3">
          <h2 className="flex-1 font-medium">{title}</h2>
          <Button aria-label="Close" onClick={onClose}>
            <X size={15} />
          </Button>
        </header>
        <div className="p-5">{children}</div>
      </section>
    </div>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
export function ArtifactView({ artifact: a, t }: { artifact: Artifact; t: T }) {
  return (
    <details className="rounded-md border border-border bg-background p-3">
      <summary className="text-xs">
        <span className="font-medium">{a.title}</span>
        <span className="ml-2 badge">{t(a.kind)}</span>
        <span className="ml-2 muted font-mono">{a.version.slice(0, 12)}</span>
      </summary>
      <div className="mt-2 text-[11px] muted">
        {a.createdAt}{" "}
        {a.runId && ` · ${t("Agent report — verify evidence")} · ${a.runId}`}
      </div>
      <pre className="mt-3 text-xs leading-6">{a.content}</pre>
    </details>
  );
}
export function RequestCard({
  request: r,
  state: s,
  action,
  t,
  busy = false,
}: {
  request: Request;
  state: State;
  action: Action;
  t: T;
  busy?: boolean;
}) {
  const [answer, setAnswer] = useDraft(`request:${r.id}`);
  const [changes, setChanges] = useState(false);
  const submit = (decision: string) =>
    void action("request.decide", {
      requestId: r.id,
      revision: r.revision,
      decision,
      answer,
    })
      .then(() => setAnswer(""))
      .catch(() => {});
  return (
    <div
      className="my-3 rounded-lg border border-border bg-card p-4"
      data-request-id={r.id}
    >
      <div className="flex items-center gap-2">
        <span className="text-violet-500">
          {r.kind === "input" ? (
            <MessageSquare size={15} />
          ) : (
            <ShieldCheck size={15} />
          )}
        </span>
        <span className="font-medium">
          {r.kind === "final" ? t("Final acceptance") : r.title}
        </span>
        <span className="ml-auto badge">{t(r.status)}</span>
      </div>
      <p className="mt-3 whitespace-pre-wrap leading-6">{r.body}</p>
      <div className="mt-2 text-[11px] muted">
        {t("Blocking scope")}:{" "}
        {r.scope === "issue"
          ? t("Whole issue")
          : r.scope
              .map((id) => s.tasks.find((x) => x.id === id)?.text || id)
              .join(" · ")}
      </div>
      {r.action && (
        <p className="my-2 text-xs">
          {t("Authorized action")}: {r.action}
        </p>
      )}
      {r.artifactIds.length > 0 && (
        <div className="mt-3 space-y-2">
          {r.artifactIds.map((id) => {
            const a = s.artifacts.find((a) => a.id === id);
            return a ? (
              <ArtifactView key={id} artifact={a} t={t} />
            ) : (
              <p key={id}>Missing material {id}</p>
            );
          })}
        </div>
      )}
      {r.status === "Pending" ? (
        <div className="mt-4">
          {r.kind === "input" ? (
            <>
              {r.options?.length ? (
                <div className="space-y-2">
                  {r.options.map((o) => (
                    <label
                      key={o.value}
                      className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 ${answer === o.value ? "border-violet-400 bg-violet-500/5" : "border-border"}`}
                    >
                      <input
                        type="radio"
                        name={r.id}
                        checked={answer === o.value}
                        onChange={() => setAnswer(o.value)}
                      />
                      <span>{o.label}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <textarea
                  className="field min-h-20"
                  placeholder={t("Answer")}
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                />
              )}
              <Button
                className="mt-3"
                variant="primary"
                disabled={busy || !answer.trim()}
                onClick={() => submit("answer")}
              >
                {t("Submit answer")}
                <ArrowUp size={12} />
              </Button>
            </>
          ) : (
            <>
              {changes && (
                <textarea
                  className="field mb-3"
                  autoFocus
                  placeholder={t("Changes requested")}
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                />
              )}
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => submit("approve")}
                >
                  {t("Approve")}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || (changes && !answer.trim())}
                  onClick={() =>
                    changes ? submit("changes") : setChanges(true)
                  }
                >
                  {t("Request changes")}
                </Button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="mt-4 border-t border-border pt-3 text-xs">
          <span className="muted">
            {r.decidedBy} · {r.decidedAt}
          </span>
          <p className="mt-1 whitespace-pre-wrap">
            {r.options?.find((o) => o.value === r.answer)?.label ||
              r.answer ||
              r.action}
          </p>
        </div>
      )}
    </div>
  );
}
export function DirectoryPicker({
  value,
  onChange,
  t,
}: {
  value: string;
  onChange: (s: string) => void;
  t: T;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{
    path: string;
    parent: string;
    directories: { name: string; path: string }[];
  }>();
  const [error, setError] = useState("");
  const load = async (path: string) => {
    try {
      setData(await api("/api/directories?path=" + encodeURIComponent(path)));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      <div className="flex gap-2">
        <input
          className="field"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="/absolute/path/to/repository"
        />
        <Button
          variant="outline"
          onClick={() => {
            setOpen(true);
            void load(value);
          }}
        >
          <Folder size={14} />
          {t("Browse")}
        </Button>
      </div>
      {open && (
        <Modal title={t("Directory")} onClose={() => setOpen(false)}>
          <div className="mb-2 break-all text-xs muted">{data?.path}</div>
          {error && <p className="mb-3 text-rose-500">{error}</p>}
          <div className="max-h-72 overflow-auto">
            <Button
              className="w-full justify-start"
              onClick={() => void load(data?.parent || "/")}
            >
              {t("Parent directory")}
            </Button>
            {data?.directories.map((d) => (
              <Button
                key={d.path}
                className="w-full justify-start"
                onClick={() => void load(d.path)}
              >
                <Folder size={14} />
                {d.name}
                <ChevronRight className="ml-auto" size={13} />
              </Button>
            ))}
          </div>
          <Button
            className="mt-4"
            variant="primary"
            disabled={!data}
            onClick={() => {
              onChange(data!.path);
              setOpen(false);
            }}
          >
            {t("Select this directory")}
          </Button>
        </Modal>
      )}
    </>
  );
}
