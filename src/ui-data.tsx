import { createContext, useContext, useEffect, useRef, useState } from "react";
import { FolderOpen } from "lucide-react";
import { api, useRelay } from "./api";
import type { State } from "../server/types";
const empty: State = {
  schemaVersion: 2,
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
  sessions: [],
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
  const key = `spec-${worktreeId}-${document}`;
  const [entry, setEntry] = useState<{
    key: string;
    content: string;
    version: string;
    status: string;
    path: string;
  }>({ key: "", content: "", version: "", status: "Loading…", path: "" });
  const current = useRef(entry);
  current.current = entry;
  useEffect(() => {
    if (!worktreeId) return;
    let alive = true;
    const load = async () => {
      try {
        const r = await api(
          `/api/spec?worktreeId=${worktreeId}&document=${document}`,
        );
        if (!alive) return;
        const draft = sessionStorage.getItem(key);
        const base = sessionStorage.getItem(key + "-base") || r.version;
        const changed = draft !== null && draft !== r.content;
        setEntry({
          key,
          content: draft ?? r.content,
          version: changed ? base : r.version,
          path: r.path,
          status: changed
            ? base !== r.version
              ? "Save failed / Conflict: external content changed; draft retained"
              : "Unsaved"
            : "Saved locally",
        });
      } catch (e) {
        if (alive)
          setEntry({
            key,
            content: sessionStorage.getItem(key) || "",
            version: "",
            path: "",
            status: String(e),
          });
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, [key]);
  useEffect(() => {
    if (entry.key !== key || entry.status !== "Unsaved" || !entry.version)
      return;
    const timer = setTimeout(async () => {
      const saved = entry;
      setEntry((s) => ({ ...s, status: "Saving…" }));
      try {
        const r = await api("/api/spec", "PUT", {
          worktreeId,
          document,
          content: saved.content,
          version: saved.version,
        });
        setEntry((s) =>
          s.key === key
            ? {
                ...s,
                version: r.version,
                status:
                  s.content === saved.content ? "Saved locally" : "Unsaved",
              }
            : s,
        );
        if (
          current.current.key === key &&
          current.current.content === saved.content
        ) {
          sessionStorage.removeItem(key);
          sessionStorage.removeItem(key + "-base");
        } else if (current.current.key === key)
          sessionStorage.setItem(key + "-base", r.version);
      } catch (e) {
        setEntry((s) =>
          s.key === key
            ? { ...s, status: "Save failed / Conflict: " + String(e) }
            : s,
        );
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [entry, key]);
  return {
    content: entry.key === key ? entry.content : "",
    status: entry.key === key ? entry.status : "Loading…",
    path: entry.path,
    setContent: (content: string) => {
      sessionStorage.setItem(key, content);
      sessionStorage.setItem(key + "-base", entry.version);
      setEntry((s) => ({
        ...s,
        content,
        status: s.status.startsWith("Save failed") ? s.status : "Unsaved",
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
