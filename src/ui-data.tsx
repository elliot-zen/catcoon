import { createContext, useContext, useEffect, useRef, useState } from "react";
import { FolderOpen } from "lucide-react";
import { api, useRelay } from "./api";
import type { State } from "../server/types";
const empty: State = {
  schemaVersion: 3,
  revision: 0,
  nextIssue: 1,
  issues: [],
  projects: [],
  worktrees: [],
  agents: [],
  bindings: [],
  tasks: [],
  runs: [],
  events: [],
  requests: [],
  notifications: [],
  artifacts: [],
  comments: [],
  attachments: [],
  specs: [],
  specVersions: [],
  evaluations: [],
  contextSnapshots: [],
  labelCatalog: [],
  settings: { configured: false, testedAt: "", connection: "not tested" },
};
export const Backend = createContext<
  ReturnType<typeof useRelay> & { data: State }
>(null!);
export function useBackend() {
  return useContext(Backend);
}
export function useData() {
  const relay = useRelay();
  return { ...relay, data: relay.state || empty };
}
export function relative(value: string) {
  if (!value) return "—";
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 1000),
  );
  return seconds < 60
    ? "Now"
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)}h`
        : new Date(value).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          });
}
export const time = (value: string) =>
  value ? new Date(value).toLocaleString() : "—";
export function useSpec(
  worktreeId: string | undefined,
  document: "product" | "tech",
) {
  const { data } = useBackend();
  const w = data.worktrees.find((w) => w.id === worktreeId);
  const specId = w?.specId,
    key = "spec-" + specId + "-" + document;
  const [entry, setEntry] = useState({
    key: "",
    content: "",
    revision: 0,
    status: "Loading…",
  });
  const current = useRef(entry);
  current.current = entry;
  useEffect(() => {
    if (!specId) return;
    let alive = true;
    void api("/api/spec?specId=" + specId + "&document=" + document)
      .then((r) => {
        if (!alive) return;
        const draft = sessionStorage.getItem(key),
          base = sessionStorage.getItem(key + "-base"),
          changed = draft !== null && draft !== r.content;
        setEntry({
          key,
          content: draft ?? r.content,
          revision: changed && base !== null ? Number(base) : r.draftRevision,
          status: changed
            ? base !== null && Number(base) !== r.draftRevision
              ? "Save failed / Conflict: shared draft changed; input retained"
              : "Unsaved"
            : "Saved",
        });
      })
      .catch((e) => {
        if (alive)
          setEntry({
            key,
            content: sessionStorage.getItem(key) || "",
            revision: 0,
            status: String(e),
          });
      });
    return () => {
      alive = false;
    };
  }, [key]);
  useEffect(() => {
    if (entry.key !== key || entry.status !== "Unsaved" || !specId) return;
    const timer = setTimeout(async () => {
      const saved = entry;
      setEntry((x) => ({ ...x, status: "Saving…" }));
      try {
        const r = await api("/api/spec", "PUT", {
          specId,
          document,
          content: saved.content,
          draftRevision: saved.revision,
        });
        setEntry((x) =>
          x.key === key
            ? {
                ...x,
                revision: r.draftRevision,
                status: x.content === saved.content ? "Saved" : "Unsaved",
              }
            : x,
        );
        if (
          current.current.key === key &&
          current.current.content === saved.content
        ) {
          sessionStorage.removeItem(key);
          sessionStorage.removeItem(key + "-base");
        } else if (current.current.key === key)
          sessionStorage.setItem(key + "-base", String(r.draftRevision));
      } catch (e) {
        setEntry((x) =>
          x.key === key
            ? { ...x, status: "Save failed / Conflict: " + String(e) }
            : x,
        );
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [entry, key, specId, document]);
  return {
    content: entry.key === key ? entry.content : "",
    status: entry.key === key ? entry.status : "Loading…",
    path: "System Spec " + specId,
    setContent: (content: string) => {
      sessionStorage.setItem(key, content);
      sessionStorage.setItem(key + "-base", String(entry.revision));
      setEntry((x) => ({
        ...x,
        content,
        status: x.status.startsWith("Save failed") ? x.status : "Unsaved",
      }));
    },
  };
}
export default function DirectoryField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (path: string) => void;
  placeholder: string;
}) {
  const [listing, setListing] = useState<
    | {
        path: string;
        parent: string;
        directories: { name: string; path: string }[];
      }
    | undefined
  >();
  const [error, setError] = useState("");
  const browse = async (path = value || "") => {
    try {
      setListing(
        await api("/api/directories?path=" + encodeURIComponent(path)),
      );
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <div className="relative">
      <div className="flex gap-2">
        <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-zinc-50 px-3 text-xs text-muted-foreground">
          <FolderOpen size={14} />
          <input
            aria-label={placeholder}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            className="min-w-0 flex-1 bg-transparent outline-none"
          />
        </div>
        <button
          type="button"
          onClick={() => (listing ? setListing(undefined) : void browse())}
          className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground hover:bg-muted"
        >
          Browse
        </button>
      </div>
      {listing && (
        <div className="absolute z-50 mt-1 max-h-56 w-full overflow-auto rounded-md border border-border bg-card p-1 text-xs shadow-lg">
          <button
            className="w-full px-2 py-1.5 text-left hover:bg-muted"
            onClick={() => void browse(listing.parent)}
          >
            ..
          </button>
          <button
            className="w-full px-2 py-1.5 text-left hover:bg-muted"
            onClick={() => {
              onChange(listing.path);
              setListing(undefined);
            }}
          >
            {listing.path}
          </button>
          {listing.directories.map((dir) => (
            <button
              key={dir.path}
              className="w-full px-2 py-1.5 text-left hover:bg-muted"
              onClick={() => {
                onChange(dir.path);
                void browse(dir.path);
              }}
            >
              {dir.name}/
            </button>
          ))}
        </div>
      )}
      {error && <span className="text-xs text-rose-600">{error}</span>}
    </div>
  );
}
export async function filesPayload(files: File[]) {
  return await Promise.all(
    files.map(async (f) => {
      if (f.size > 5 * 1024 * 1024) throw new Error("File exceeds 5MB");
      const bytes = new Uint8Array(await f.arrayBuffer());
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      return {
        name: f.name,
        mime: f.type || "application/octet-stream",
        content: btoa(binary),
      };
    }),
  );
}
