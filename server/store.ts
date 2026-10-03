import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { State } from "./types.ts";
import { EventEmitter } from "node:events";
export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export class AppError extends Error {
  status: number;
  code: string;
  details: unknown;
  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const fail = (
  status: number,
  code: string,
  message: string,
  details?: unknown,
): never => {
  throw new AppError(status, code, message, details);
};
export function text(value: unknown, label: string, max = 100000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    return fail(
      400,
      "INVALID_INPUT",
      `${label} is required (maximum ${max} characters)`,
    );
  return value.trim();
}
export function find<T extends { id: string }>(items: T[], value: unknown): T {
  return (
    items.find((x) => x.id === value) ??
    fail(404, "NOT_FOUND", "Object not found")
  );
}
export function initial(): State {
  return {
    schemaVersion: 3,
    specs: [],
    specVersions: [],
    evaluations: [],
    contextSnapshots: [],
    labelCatalog: [
      { name: "Bug", color: "bg-[#f05256]" },
      { name: "Feature", color: "bg-[#bb80ff]" },
      { name: "Improvement", color: "bg-blue-400" },
    ],
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
    settings: { configured: false, testedAt: "", connection: "not tested" },
  };
}
export class Store {
  changes = new EventEmitter();
  db: DatabaseSync;
  dir: string;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.db = new DatabaseSync(join(dir, "relay.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL,revision INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS operations(key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,response TEXT NOT NULL,created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS locks(path TEXT PRIMARY KEY,run_id TEXT NOT NULL UNIQUE);",
    );
    this.db
      .prepare("INSERT OR IGNORE INTO state VALUES(1,?,0)")
      .run(JSON.stringify(initial()));
    if (this.read().schemaVersion !== 3) {
      this.db.close();
      throw new Error(
        "Unsupported database schema. Stop Relay and run npm run db:reset.",
      );
    }
    if (process.env.TYPESAFE_API_KEY && !existsSync(join(dir, "secret.json")))
      this.saveKey(process.env.TYPESAFE_API_KEY);
  }
  read(): State {
    return JSON.parse(
      (
        this.db.prepare("SELECT json FROM state WHERE id=1").get() as {
          json: string;
        }
      ).json,
    );
  }
  change<T>(fn: (s: State) => T, key?: string, fingerprint = ""): T {
    this.db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      if (key) {
        const old = this.db
          .prepare("SELECT * FROM operations WHERE key=?")
          .get(key) as { fingerprint: string; response: string } | undefined;
        if (old) {
          if (old.fingerprint !== fingerprint)
            fail(
              409,
              "IDEMPOTENCY_CONFLICT",
              "This key was already used for another operation",
            );
          this.db.exec("COMMIT");
          return JSON.parse(old.response);
        }
      }
      const s = this.read();
      const result = fn(s);
      s.revision++;
      this.db
        .prepare("UPDATE state SET json=?,revision=? WHERE id=1")
        .run(JSON.stringify(s), s.revision);
      if (key)
        this.db
          .prepare("INSERT INTO operations VALUES(?,?,?,?)")
          .run(key, fingerprint, JSON.stringify(result ?? null), now());
      this.db.exec("COMMIT");
      committed = true;
      this.changes.emit("change", s.revision);
      return result;
    } catch (e) {
      if (!committed) this.db.exec("ROLLBACK");
      throw e;
    }
  }
  cached(key: string, fingerprint: string): unknown | undefined {
    const r = this.db
      .prepare("SELECT fingerprint,response FROM operations WHERE key=?")
      .get(key) as { fingerprint: string; response: string } | undefined;
    if (!r) return;
    if (r.fingerprint !== fingerprint)
      fail(
        409,
        "IDEMPOTENCY_CONFLICT",
        "This key was already used for another operation",
      );
    return JSON.parse(r.response);
  }
  key(): string {
    try {
      return JSON.parse(readFileSync(join(this.dir, "secret.json"), "utf8"))
        .apiKey;
    } catch {
      return "";
    }
  }
  saveKey(apiKey: string) {
    const path = join(this.dir, "secret.json");
    writeFileSync(path + ".tmp", JSON.stringify({ apiKey }), { mode: 0o600 });
    renameSync(path + ".tmp", path);
    chmodSync(path, 0o600);
  }
  redact(value: string, secret = this.key()): string {
    return (secret ? value.split(secret).join("[REDACTED]") : value)
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(
        /((?:api[_-]?key|token|password|secret)\s*[=:]\s*)["']?[^\s,"'}]+/gi,
        "$1[REDACTED]",
      );
  }
  publicState() {
    const s = this.read();
    const {
      contextSnapshots,
      evaluations,
      specs,
      specVersions,
      ...publicData
    } = s;
    return this.redacted({
      ...publicData,
      specs: specs.map(({ draft, ...spec }) => ({
        ...spec,
        draft: { revision: draft.revision, baseVersionId: draft.baseVersionId },
      })),
      specVersions: specVersions.map(
        ({ product, tech, ...version }) => version,
      ),
      evaluations: evaluations.map(
        ({ input, answer, ...evaluation }) => evaluation,
      ),
      settings: { ...s.settings, configured: !!this.key() },
      attachments: s.attachments.map(({ content, ...a }) => a),
      runs: s.runs.map(({ contextRef, ...r }) => r),
    });
  }
  redacted<T>(value: T): T {
    const secret = this.key();
    const walk = (x: any): any =>
      typeof x === "string"
        ? this.redact(x, secret)
        : Array.isArray(x)
          ? x.map(walk)
          : x && typeof x === "object"
            ? Object.fromEntries(
                Object.entries(x).map(([key, v]) => [
                  key,
                  typeof v === "string" &&
                  /^(authorization|api[_-]?key|token|password|secret)$/i.test(
                    key,
                  )
                    ? "[REDACTED]"
                    : walk(v),
                ]),
              )
            : x;
    return walk(value);
  }
  close() {
    this.db.close();
  }
}
