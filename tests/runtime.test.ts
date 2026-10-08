import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { codex } from "../server/runtime/codex.js";
import { pi } from "../server/runtime/pi.js";
import type {
  Binding,
  HumanRequest,
  RuntimeCallbacks,
} from "../server/types.js";
for (const [name, factory] of [
  ["codex", codex],
  ["pi", pi],
] as const) {
  test(`${name}: real subprocess framing, suspended approval, completion and exit`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "catcoon-runtime-"));
    const bin = join(dir, name);
    copyFileSync(resolve(`tests/fixtures/${name}.mjs`), bin);
    chmodSync(bin, 0o755);
    const env = name === "codex" ? "CODEX_BIN" : "PI_BIN";
    const previous = process.env[env];
    process.env[env] = bin;
    try {
      const binding: Binding = {
        id: "binding",
        issueId: "issue",
        name,
        runtime: name,
        role: "Test",
        cwd: process.cwd(),
        model: "",
        sessionId: null,
      };
      let request!: HumanRequest;
      let output = "",
        session = "",
        complete = false;
      const messages: string[] = [];
      let approvedAt = 0;
      let close!: (v?: unknown) => void;
      let fail!: (e: Error) => void;
      const closed = new Promise((resolve, reject) => {
        close = resolve;
        fail = reject;
      });
      const cb: RuntimeCallbacks = {
        spawned: (pid) => assert.ok(pid > 0),
        message: (_kind, text) => messages.push(text),
        session: (id) => (session = id),
        request: (r) => {
          request = {
            ...r,
            id: "r",
            issueId: "issue",
            turnId: "turn",
            status: "pending",
            answer: null,
            createdAt: new Date().toISOString(),
          };
        },
        complete: (text) => {
          complete = true;
          output = text;
          if (name === "pi")
            assert.ok(
              Date.now() - approvedAt >= 80,
              "Pi must wait for agent_settled rather than agent_end",
            );
        },
        error: fail,
        closed: close,
      };
      const handle = factory(binding, "Test prompt", cb);
      for (let i = 0; i < 100 && !request; i++)
        await new Promise((r) => setTimeout(r, 10));
      assert.ok(request, "Runtime approval must arrive");
      assert.equal(complete, false);
      assert.ok(
        messages.some((m) => m.includes("\u2028")),
        "JSON strings must retain Unicode line separators",
      );
      approvedAt = Date.now();
      handle.respond(request, "Approved", true);
      await closed;
      assert.ok(complete);
      assert.ok(session);
      if (name === "pi") assert.equal(output, "Approved work finished.");
    } finally {
      if (previous === undefined) delete process.env[env];
      else process.env[env] = previous;
      rmSync(dir, { recursive: true });
    }
  });
}

test("Codex multi-question answers are validated before replying to a native request", async () => {
  const { codexAnswers } = await import("../server/runtime/codex.js");
  assert.throws(
    () => codexAnswers([{ id: "target" }, { id: "mode" }], "plain answer"),
    /every question/,
  );
  assert.throws(
    () =>
      codexAnswers([{ id: "target" }, { id: "mode" }], '{"target":["server"]}'),
    /every question/,
  );
  assert.deepEqual(
    codexAnswers(
      [{ id: "target" }, { id: "mode" }],
      '{"target":["server"],"mode":["local"]}',
    ),
    { target: { answers: ["server"] }, mode: { answers: ["local"] } },
  );
});
