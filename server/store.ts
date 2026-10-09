import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Issue,
  Binding,
  Turn,
  HumanRequest,
  Activity,
  Detail,
  Message,
  Status,
} from "./types.js";
export const now = () => new Date().toISOString();
export const uid = () => randomUUID();
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS issues(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,status TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0,currentTurnId TEXT,stopReason TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,completedAt TEXT);
 CREATE TABLE IF NOT EXISTS bindings(id TEXT PRIMARY KEY,issueId TEXT NOT NULL REFERENCES issues(id),name TEXT NOT NULL,runtime TEXT NOT NULL,role TEXT NOT NULL,cwd TEXT NOT NULL,model TEXT NOT NULL,sessionId TEXT);
 CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY,issueId TEXT NOT NULL REFERENCES issues(id),bindingId TEXT NOT NULL REFERENCES bindings(id),generation INTEGER NOT NULL,status TEXT NOT NULL,input TEXT NOT NULL,output TEXT NOT NULL,startedAt TEXT NOT NULL,endedAt TEXT);
 CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,issueId TEXT NOT NULL REFERENCES issues(id),turnId TEXT REFERENCES turns(id),kind TEXT NOT NULL,title TEXT NOT NULL,detail TEXT NOT NULL,options TEXT NOT NULL,status TEXT NOT NULL,answer TEXT,native TEXT,createdAt TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS activities(id TEXT PRIMARY KEY,issueId TEXT NOT NULL REFERENCES issues(id),actor TEXT NOT NULL,type TEXT NOT NULL,summary TEXT NOT NULL,detail TEXT NOT NULL,createdAt TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,turnId TEXT NOT NULL REFERENCES turns(id),kind TEXT NOT NULL,text TEXT NOT NULL,createdAt TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS one_live_turn ON turns(issueId) WHERE status='running';
 CREATE UNIQUE INDEX IF NOT EXISTS one_pending_request ON requests(issueId) WHERE status='pending';
 CREATE TABLE IF NOT EXISTS workers(id TEXT PRIMARY KEY REFERENCES turns(id),pid INTEGER NOT NULL,birth TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS turn_messages ON messages(turnId,id);
 `);
    // Backfill only once so later user choices survive subsequent startups.
    const columns = this.db.prepare("PRAGMA table_info(bindings)").all();
    if (!columns.some((column) => column.name === "approvalLevel")) {
      this.transaction(() => {
        this.db
          .exec(`ALTER TABLE bindings ADD COLUMN approvalLevel TEXT NOT NULL DEFAULT 'strict' CHECK(approvalLevel IN ('strict','on-request','automatic'));
          UPDATE bindings SET approvalLevel='on-request' WHERE runtime='codex';`);
      });
    }
    // Old Codex Automatic was sandboxed. Do not silently expand its access.
    const version = this.db.prepare("PRAGMA user_version").get()!;
    if (Number(version.user_version) < 1) {
      this.transaction(() => {
        const affected = this.db
          .prepare(
            `SELECT b.id,b.issueId FROM bindings b
          JOIN issues i ON i.id=b.issueId
          WHERE b.runtime='codex' AND b.approvalLevel='automatic'`,
          )
          .all();
        this.db.exec(`UPDATE bindings SET approvalLevel='on-request'
          WHERE runtime='codex' AND approvalLevel='automatic';
          PRAGMA user_version=1;`);
        for (const binding of affected) {
          this.activity(
            String(binding.issueId),
            "System",
            "approval_migrated",
            "Codex approval level migrated to On-request approval",
            `Binding ${binding.id}: the previous Automatic mode was sandboxed. Select Fully automatic explicitly to grant full access.`,
          );
        }
      });
    }
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  insert(table: string, data: Record<string, unknown>) {
    const keys = Object.keys(data);
    this.db
      .prepare(
        `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
      )
      .run(...(Object.values(data) as any[]));
  }
  update(table: string, id: string, data: Record<string, unknown>) {
    this.db
      .prepare(
        `UPDATE ${table} SET ${Object.keys(data)
          .map((k) => `${k}=?`)
          .join(",")} WHERE id=?`,
      )
      .run(...(Object.values(data) as any[]), id);
  }
  issue(id: string) {
    return this.db
      .prepare("SELECT * FROM issues WHERE id=?")
      .get(id) as unknown as Issue | undefined;
  }
  list() {
    return this.db
      .prepare("SELECT * FROM issues ORDER BY updatedAt DESC")
      .all() as unknown as Issue[];
  }
  bindings(id: string) {
    return this.db
      .prepare("SELECT * FROM bindings WHERE issueId=? ORDER BY rowid")
      .all(id) as unknown as Binding[];
  }
  turns(id: string) {
    return this.db
      .prepare("SELECT * FROM turns WHERE issueId=? ORDER BY rowid")
      .all(id) as unknown as Turn[];
  }
  requests(id: string): HumanRequest[] {
    return this.db
      .prepare("SELECT * FROM requests WHERE issueId=? ORDER BY rowid")
      .all(id)
      .map((r: any) => ({
        ...r,
        options: JSON.parse(r.options),
        native: r.native ? JSON.parse(r.native) : null,
      }));
  }
  pending(id: string) {
    return this.requests(id).find((r) => r.status === "pending");
  }
  detail(id: string): Detail | undefined {
    const issue = this.issue(id);
    if (!issue) return;
    return {
      ...issue,
      bindings: this.bindings(id),
      turns: this.turns(id),
      requests: this.requests(id),
      activities: this.db
        .prepare("SELECT * FROM activities WHERE issueId=? ORDER BY rowid DESC")
        .all(id) as unknown as Activity[],
      messages: this.db
        .prepare(
          "SELECT m.* FROM messages m JOIN turns t ON t.id=m.turnId WHERE t.issueId=? ORDER BY m.id",
        )
        .all(id) as unknown as Message[],
    };
  }
  activity(
    issueId: string,
    actor: string,
    type: string,
    summary: string,
    detail = "",
  ) {
    this.insert("activities", {
      id: uid(),
      issueId,
      actor,
      type,
      summary,
      detail,
      createdAt: now(),
    });
    this.update("issues", issueId, { updatedAt: now() });
  }
  status(id: string, status: Status, extra: Record<string, unknown> = {}) {
    this.update("issues", id, { status, updatedAt: now(), ...extra });
  }
  addRequest(r: HumanRequest) {
    this.insert("requests", {
      ...r,
      options: JSON.stringify(r.options),
      native: r.native ? JSON.stringify(r.native) : null,
    });
  }
  message(turnId: string, kind: string, text: string) {
    this.insert("messages", { turnId, kind, text, createdAt: now() });
    return Number(
      this.db.prepare("SELECT last_insert_rowid() AS id").get()!.id,
    );
  }
  close() {
    this.db.close();
  }
}
