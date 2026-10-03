import { EventEmitter } from "node:events";
import { Store, now } from "./store.ts";
import type { Run, StreamItem } from "./types.ts";
export class Streams extends EventEmitter {
  store: Store;
  messages = new Map<string, number>();
  constructor(store: Store) {
    super();
    this.store = store;
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS stream_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,issue_id TEXT NOT NULL,run_id TEXT NOT NULL,session_id TEXT NOT NULL,turn_id TEXT,item_key TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,at TEXT NOT NULL,received_at TEXT NOT NULL,dedup_key TEXT UNIQUE);
 CREATE INDEX IF NOT EXISTS streams_issue ON stream_events(issue_id,seq);CREATE INDEX IF NOT EXISTS streams_run ON stream_events(run_id,seq);
 CREATE TABLE IF NOT EXISTS stream_items(run_id TEXT NOT NULL,item_key TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,content TEXT NOT NULL,first_seq INTEGER NOT NULL,last_seq INTEGER NOT NULL,metadata TEXT NOT NULL,PRIMARY KEY(run_id,item_key));CREATE INDEX IF NOT EXISTS items_run ON stream_items(run_id,first_seq);`);
  }
  items(runId: string): StreamItem[] {
    return (
      this.store.db
        .prepare("SELECT * FROM stream_items WHERE run_id=? ORDER BY first_seq")
        .all(runId) as any[]
    ).map((x) => ({
      runId: x.run_id,
      itemKey: x.item_key,
      kind: x.kind,
      status: x.status,
      content: x.content,
      metadata: JSON.parse(x.metadata),
      firstSeq: x.first_seq,
      lastSeq: x.last_seq,
    }));
  }
  snapshot(issueId: string) {
    this.store.db.exec("BEGIN");
    try {
      const runs = this.store
        .read()
        .runs.filter((r) => r.issueId === issueId)
        .map((r) => ({ runId: r.id, items: this.items(r.id) }));
      const lastSeq = Number(
        (
          this.store.db
            .prepare("SELECT COALESCE(MAX(seq),0) n FROM stream_events")
            .get() as any
        ).n,
      );
      this.store.db.exec("COMMIT");
      return { runs, lastSeq };
    } catch (e) {
      this.store.db.exec("ROLLBACK");
      throw e;
    }
  }
  replay(issueId: string, after: number) {
    return (
      this.store.db
        .prepare(
          "SELECT seq,payload FROM stream_events WHERE issue_id=? AND seq>? ORDER BY seq",
        )
        .all(issueId, after) as any[]
    ).map((x) => ({ ...JSON.parse(x.payload), seq: x.seq }));
  }
  write(
    r: Run,
    itemKey: string,
    kind: StreamItem["kind"],
    operation: "append" | "replace" | "status",
    data: string,
    metadata: any = {},
    status = "running",
    dedupKey?: string,
  ) {
    const full = this.store.redact(data);
    metadata = this.store.redacted(metadata);
    const metadataTruncated =
      Buffer.byteLength(JSON.stringify(metadata)) > 32 * 1024;
    if (metadataTruncated)
      metadata = {
        title: String(metadata.title || "Tool call").slice(0, 2000),
        parameters: "[Truncated: parameters exceed 32KB]",
      };
    const budget = 63 * 1024 - Buffer.byteLength(JSON.stringify(metadata));
    const truncated = metadataTruncated || Buffer.byteLength(full) > budget;
    const content = truncated
      ? Buffer.from(full).subarray(0, budget).toString("utf8") +
        "\n[Truncated: event exceeds 64KB]"
      : full;
    const key = r.sessionId + ":" + r.nativeTurnId + ":" + itemKey;
    const old = this.items(r.id).find((x) => x.itemKey === key);
    const payload = {
      issueId: r.issueId,
      runId: r.id,
      sessionId: r.sessionId,
      turnId: r.nativeTurnId,
      itemKey: key,
      kind,
      operation,
      data: content,
      metadata: {
        ...metadata,
        truncated:
          operation === "replace"
            ? truncated
            : !!old?.metadata.truncated || truncated,
      },
      status,
    };
    while (Buffer.byteLength(JSON.stringify(payload)) > 63 * 1024) {
      payload.metadata.truncated = true;
      payload.data =
        payload.data.slice(0, Math.floor(payload.data.length / 2)) +
        "\n[Truncated: event exceeds 64KB]";
    }
    this.store.db.exec("BEGIN IMMEDIATE");
    let seq: number;
    try {
      const row = this.store.db
        .prepare(
          "INSERT OR IGNORE INTO stream_events(issue_id,run_id,session_id,turn_id,item_key,kind,payload,at,received_at,dedup_key) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          r.issueId,
          r.id,
          r.sessionId,
          r.nativeTurnId || null,
          key,
          kind,
          JSON.stringify(payload),
          now(),
          now(),
          dedupKey || null,
        );
      if (!row.changes) {
        this.store.db.exec("COMMIT");
        return;
      }
      seq = Number(row.lastInsertRowid);
      const next =
        operation === "append"
          ? (old?.content || "") + payload.data
          : operation === "status"
            ? old?.content || ""
            : payload.data;
      this.store.db
        .prepare(
          "INSERT INTO stream_items VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(run_id,item_key) DO UPDATE SET kind=excluded.kind,status=excluded.status,content=excluded.content,last_seq=excluded.last_seq,metadata=excluded.metadata",
        )
        .run(
          r.id,
          key,
          kind,
          status,
          next,
          old?.firstSeq || seq,
          seq,
          JSON.stringify({ ...old?.metadata, ...payload.metadata }),
        );
      this.store.db.exec("COMMIT");
    } catch (e) {
      this.store.db.exec("ROLLBACK");
      throw e;
    }
    this.emit("stream", { ...payload, seq });
  }
  codex(r: Run, m: any) {
    const p = m.params || {},
      name = m.method;
    if (name === "item/agentMessage/delta")
      this.write(r, p.itemId, "answer", "append", p.delta || "");
    if (name === "item/reasoning/summaryTextDelta")
      this.write(
        r,
        p.itemId + ":summary:" + p.summaryIndex,
        "thinking",
        "append",
        p.delta || "",
      );
    if (name === "item/commandExecution/outputDelta")
      this.write(r, p.itemId, "tool", "append", p.delta || "");
    if (name === "item/started" || name === "item/completed") {
      const item = p.item;
      if (!item?.id) return;
      const done = name === "item/completed",
        status = done
          ? item.status === "failed" ||
            item.isError ||
            (typeof item.exitCode === "number" && item.exitCode !== 0)
            ? "failed"
            : "completed"
          : "running";
      if (item.type === "agentMessage")
        this.write(
          r,
          item.id,
          "answer",
          done ? "replace" : "status",
          done ? item.text || "" : "",
          {},
          status,
          done ? r.id + ":" + item.id + ":final" : undefined,
        );
      else if (item.type === "reasoning") {
        for (const [index, part] of (item.summary || []).entries())
          this.write(
            r,
            item.id + ":summary:" + index,
            "thinking",
            done ? "replace" : "status",
            typeof part === "string" ? part : part.text || "",
            {},
            status,
            done ? r.id + ":" + item.id + ":summary:" + index : undefined,
          );
      } else if (item.type !== "userMessage") {
        const read = item.commandActions?.find((a: any) => a.type === "read");
        const title = read
          ? "Read " + (read.path || read.name || item.command)
          : item.type === "commandExecution"
            ? "Exec " + item.command
            : item.name || item.tool || item.type;
        const out = item.aggregatedOutput ?? item.result ?? item.output;
        this.write(
          r,
          item.id,
          "tool",
          done && out !== undefined ? "replace" : "status",
          typeof out === "string"
            ? out
            : out === undefined
              ? ""
              : JSON.stringify(out),
          {
            title,
            parameters: item.arguments || item.command || item.changes || item,
            exitCode: item.exitCode,
            type: item.type,
          },
          status,
          done ? r.id + ":" + item.id + ":final" : undefined,
        );
      }
    }
  }
  pi(r: Run, m: any) {
    if (m.type === "message_start") {
      const prev = this.messages.get(r.id) || 0;
      this.messages.set(r.id, prev + 1);
    }
    const message = this.messages.get(r.id) || 1;
    if (m.type === "message_update") {
      const e = m.assistantMessageEvent || {},
        index = e.contentIndex ?? 0;
      const kind = e.type?.startsWith("thinking")
        ? "thinking"
        : e.type?.startsWith("text")
          ? "answer"
          : undefined;
      if (kind && e.type.endsWith("_delta"))
        this.write(
          r,
          "message:" + message + ":" + index,
          kind,
          "append",
          e.delta || "",
        );
      if (kind && e.type.endsWith("_end"))
        this.write(
          r,
          "message:" + message + ":" + index,
          kind,
          "replace",
          e.content || "",
          {},
          "completed",
        );
    }
    if (m.type === "message_end" && m.message?.role === "assistant")
      for (const [index, b] of (m.message.content || []).entries()) {
        if (b.type === "text" || b.type === "thinking")
          this.write(
            r,
            "message:" + message + ":" + index,
            b.type === "text" ? "answer" : "thinking",
            "replace",
            b.text || b.thinking || "",
            {},
            "completed",
            r.id + ":message:" + message + ":" + index + ":final",
          );
      }
    if (m.type?.startsWith("tool_execution_")) {
      const tool = m.toolName || m.name || "tool",
        result = m.result || m.partialResult;
      this.write(
        r,
        m.toolCallId || tool,
        "tool",
        result ? "replace" : "status",
        result ? JSON.stringify(result) : "",
        {
          title:
            tool === "read"
              ? "Read " + (m.args?.path || "")
              : tool === "bash"
                ? "Exec " + (m.args?.command || "")
                : tool,
          parameters: m.args,
          parentToolCallId: m.parentToolCallId,
          isError: m.isError,
        },
        m.type === "tool_execution_end"
          ? m.isError
            ? "failed"
            : "completed"
          : "running",
        m.type === "tool_execution_end"
          ? r.id + ":" + m.toolCallId + ":final"
          : undefined,
      );
    }
  }
}
