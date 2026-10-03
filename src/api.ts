import { useEffect, useRef, useState } from "react";
import type { State, StreamItem } from "../server/types";
export class ApiError extends Error {
  code: string;
  details: any;
  constructor(e: any) {
    super(e.message);
    this.code = e.code;
    this.details = e.details;
  }
}
export async function api(
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
) {
  const response = await fetch(path, {
    method,
    headers: body
      ? {
          "Content-Type": "application/json",
          "Idempotency-Key": key || crypto.randomUUID(),
        }
      : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error);
  return data;
}
export type Action = (
  type: string,
  payload?: Record<string, unknown>,
) => Promise<any>;
export function useRelay() {
  const [streamIssue, setStreamIssue] = useState("");
  const [streamItems, setStreamItems] = useState<Record<string, StreamItem[]>>(
    {},
  );
  const [state, setState] = useState<State>();
  const [connection, setConnection] = useState("");
  const [lastUpdate, setLast] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const operation = useRef(new Map<string, string>());
  const pendingCount = useRef(0);
  const load = async () => {
    try {
      const s = await api("/api/state");
      setState(s);
      setConnection("");
      setLast(new Date().toLocaleTimeString());
    } catch (e) {
      setConnection(e instanceof Error ? e.message : "Disconnected");
    }
  };
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!streamIssue) return;
    let alive = true,
      source: EventSource | undefined;
    void api("/api/issues/" + streamIssue + "/items")
      .then((snapshot) => {
        if (!alive) return;
        setStreamItems(
          Object.fromEntries(snapshot.runs.map((r: any) => [r.runId, r.items])),
        );
        source = new EventSource(
          "/api/stream?issueId=" + streamIssue + "&after=" + snapshot.lastSeq,
        );
        source.addEventListener("state.changed", () => void load());
        source.addEventListener("stream", (event) => {
          const p = JSON.parse((event as MessageEvent).data);
          setStreamItems((old) => {
            const items = old[p.runId] || [],
              previous = items.find((i) => i.itemKey === p.itemKey);
            if (previous && previous.lastSeq >= p.seq) return old;
            const item: StreamItem = {
              runId: p.runId,
              itemKey: p.itemKey,
              kind: p.kind,
              status: p.status,
              content:
                p.operation === "append"
                  ? (previous?.content || "") + p.data
                  : p.operation === "status"
                    ? previous?.content || ""
                    : p.data,
              metadata: { ...previous?.metadata, ...p.metadata },
              firstSeq: previous?.firstSeq || p.seq,
              lastSeq: p.seq,
            };
            return {
              ...old,
              [p.runId]: [
                ...items.filter((i) => i.itemKey !== p.itemKey),
                item,
              ].sort((a, b) => a.firstSeq - b.firstSeq),
            };
          });
        });
        source.onerror = () => setConnection("Stream reconnecting…");
        source.onopen = () => setConnection("");
      })
      .catch((e) => {
        if (alive) setConnection(String(e));
      });
    return () => {
      alive = false;
      source?.close();
    };
  }, [streamIssue]);
  const action: Action = async (type, payload = {}) => {
    const signature = JSON.stringify({ type, payload });
    if (!operation.current.has(signature))
      operation.current.set(signature, crypto.randomUUID());
    pendingCount.current++;
    setBusy(true);
    setError("");
    try {
      const r = await api(
        "/api/actions",
        "POST",
        { type, payload },
        operation.current.get(signature),
      );
      operation.current.delete(signature);
      await load();
      return r.result;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operation failed");
      throw e;
    } finally {
      pendingCount.current--;
      setBusy(pendingCount.current > 0);
    }
  };
  return {
    state,
    action,
    load,
    error,
    setError,
    busy,
    connection,
    lastUpdate,
    streamItems,
    setStreamIssue,
  };
}
export function useDraft(key: string) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const value = drafts[key] ?? sessionStorage.getItem(key) ?? "";
  const setValue = (next: string) => {
    sessionStorage.setItem(key, next);
    setDrafts((current) => ({ ...current, [key]: next }));
  };
  return [value, setValue] as const;
}
