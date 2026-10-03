import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.ts";
import { Store, id } from "../server/store.ts";
import { Streams } from "../server/streams.ts";
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
test("Reset replaces schema and clears business state, operations, locks and stream tables; keys and native files survive", async () => {
  const f = fixture();
  let closed = false;
  try {
    f.store.saveKey("retained-test-key");
    mkdirSync(join(f.store.dir, "pi"), { recursive: true });
    writeFileSync(join(f.store.dir, "pi", "native.jsonl"), "Native history");
    f.domain.action(
      "comment.create",
      { issueId: f.issue.id, text: "Persisted" },
      id(),
    );
    f.start();
    const run = f.runtime.begin(f.state().tasks[0].id, f.binding.id, "spec")!;
    f.runtime.streams.write(
      run,
      "answer",
      "answer",
      "append",
      "Persisted stream",
    );
    f.runtime.shutdown();
    f.store.change((s) => (s.schemaVersion = 2));
    f.store.close();
    closed = true;
    assert.throws(
      () => new Store(join(f.root, "data")),
      /Unsupported database schema/,
    );
    const script = "../scripts/db-reset.mjs";
    const { resetDatabase } = await import(script);
    resetDatabase(join(f.root, "data"));
    const reopened = new Store(join(f.root, "data"));
    try {
      const state = reopened.read();
      assert.equal(state.schemaVersion, 3);
      for (const key of [
        "issues",
        "projects",
        "worktrees",
        "specs",
        "specVersions",
        "runs",
        "events",
        "requests",
        "artifacts",
        "evaluations",
        "contextSnapshots",
      ])
        assert.equal((state as any)[key].length, 0, key);
      for (const table of [
        "operations",
        "locks",
        "stream_events",
        "stream_items",
      ])
        assert.equal(
          (reopened.db.prepare("SELECT COUNT(*) n FROM " + table).get() as any)
            .n,
          0,
          table,
        );
      assert.equal(reopened.key(), "retained-test-key");
      assert.equal(
        readFileSync(join(reopened.dir, "pi", "native.jsonl"), "utf8"),
        "Native history",
      );
      new Streams(reopened);
    } finally {
      reopened.close();
    }
  } finally {
    if (closed) rmSync(f.root, { recursive: true, force: true });
    else f.close();
  }
});
