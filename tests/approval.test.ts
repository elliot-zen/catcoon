import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import { Orchestrator } from "../server/orchestrator.js";
import { createApp } from "../server/app.js";
import { piNeedsApproval } from "../server/runtime/pi-policy.js";
import registerApproval from "../server/runtime/pi-approval.js";
import type { ApprovalLevel } from "../server/types.js";

test("legacy bindings receive runtime defaults once, and edited levels survive reopening", () => {
  const dir = mkdtempSync(join(tmpdir(), "catcoon-migrate-"));
  const path = join(dir, "legacy.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE bindings(id TEXT PRIMARY KEY,issueId TEXT NOT NULL,name TEXT NOT NULL,runtime TEXT NOT NULL,role TEXT NOT NULL,cwd TEXT NOT NULL,model TEXT NOT NULL,sessionId TEXT);
    INSERT INTO bindings VALUES ('c','issue','Codex','codex','Build','/tmp','','thread'), ('p','issue','Pi','pi','Review','/tmp','','session');`);
  legacy.close();
  let store = new Store(path);
  try {
    assert.deepEqual(
      store.bindings("issue").map((b) => [b.approvalLevel, b.sessionId]),
      [
        ["on-request", "thread"],
        ["strict", "session"],
      ],
    );
    store.update("bindings", "c", { approvalLevel: "automatic" });
    store.update("bindings", "p", { approvalLevel: "on-request" });
    store.close();
    store = new Store(path);
    assert.deepEqual(
      store.bindings("issue").map((b) => b.approvalLevel),
      ["automatic", "on-request"],
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});

test("binding API validates levels, preserves omitted edits, and defaults on runtime changes", async () => {
  const store = new Store(":memory:");
  const engine = new Orchestrator(store, {
    route: async () => ({ action: "done", detail: "Done" }),
  });
  const id = engine.createIssue("Approvals", "Configure approvals").id;
  const app = createApp(engine);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/issues/${id}/bindings`;
  const data = {
    name: "Codex",
    runtime: "codex",
    role: "Build",
    cwd: process.cwd(),
    model: "",
  };
  const send = (url: string, method: string, body: unknown) =>
    fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    assert.equal(
      (await send(base, "POST", { ...data, approvalLevel: "full-access" }))
        .status,
      400,
    );
    assert.equal(store.bindings(id).length, 0);
    assert.equal((await send(base, "POST", data)).status, 201);
    const binding = store.bindings(id)[0];
    assert.equal(binding.approvalLevel, "on-request");
    store.update("bindings", binding.id, { sessionId: "kept-thread" });
    for (const approvalLevel of [
      "strict",
      "automatic",
      "on-request",
    ] as const) {
      assert.equal(
        (
          await send(`${base}/${binding.id}`, "PATCH", {
            ...data,
            approvalLevel,
          })
        ).status,
        200,
      );
      assert.equal(store.bindings(id)[0].approvalLevel, approvalLevel);
      assert.equal(store.bindings(id)[0].sessionId, "kept-thread");
    }
    await send(`${base}/${binding.id}`, "PATCH", {
      ...data,
      approvalLevel: "automatic",
    });
    await send(`${base}/${binding.id}`, "PATCH", { ...data, role: "Updated" });
    assert.equal(store.bindings(id)[0].approvalLevel, "automatic");
    await send(`${base}/${binding.id}`, "PATCH", { ...data, runtime: "pi" });
    assert.equal(store.bindings(id)[0].approvalLevel, "strict");
    assert.equal(store.bindings(id)[0].sessionId, null);
    await send(base, "POST", { ...data, runtime: "pi" });
    assert.equal(store.bindings(id)[1].approvalLevel, "strict");
    assert.equal(
      (
        await send(`${base}/${binding.id}`, "PATCH", {
          ...data,
          approvalLevel: null,
        })
      ).status,
      400,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});

test("Pi on-request checks workspace writes including symlinks and rejects compound shell auto-approval", () => {
  const dir = mkdtempSync(join(tmpdir(), "catcoon-policy-"));
  const cwd = join(dir, "workspace");
  mkdirSync(cwd);
  mkdirSync(join(dir, "outside"));
  symlinkSync(join(dir, "outside"), join(cwd, "linked"));
  symlinkSync(join(dir, "missing-outside"), join(cwd, "dangling"));
  symlinkSync(cwd, join(cwd, "internal"));
  const needs = (
    toolName: string,
    input: Record<string, unknown>,
    level: ApprovalLevel = "on-request",
  ) => piNeedsApproval(level, { toolName, input }, cwd);
  try {
    for (const tool of ["write", "edit"]) {
      assert.equal(needs(tool, { path: "src/new/file.ts" }), false);
      assert.equal(needs(tool, { path: "internal/file.ts" }), false);
      for (const path of [
        "../outside/file.ts",
        join(dir, "workspace-other/file.ts"),
        "linked/new/file.ts",
        "dangling/file.ts",
        "dangling",
        "~/outside.ts",
        "@../outside/file.ts",
        `file://${dir}/outside/file.ts`,
        "linked\u00a0/file.ts",
        "",
      ]) {
        assert.equal(needs(tool, { path }), true, path);
      }
      assert.equal(needs(tool, { path: "file.ts" }, "strict"), true);
    }
    for (const command of [
      "pwd",
      "ls -la",
      "cat 'hello world.txt'",
      "head -n 20 README.md",
      "tail -20 log",
      "wc -l src/main.tsx",
    ])
      assert.equal(needs("bash", { command }), false, command);
    for (const command of [
      "rm -rf src",
      "npm test",
      "git push",
      "curl https://example.com",
      "ls; rm -rf src",
      "cat x > y",
      "ls | sh",
      "ls $(touch x)",
      "ls `touch x`",
      "ls\nrm x",
      "l\\s",
      "bash -c ls",
      "env ls",
      "ls ${PATH}",
      "",
      "ls & echo x",
      "\u00a0ls",
      "ls\u00a0malicious-command",
      "\vls",
    ])
      assert.equal(needs("bash", { command }), true, command);
    assert.equal(needs("bash", { command: "ls" }, "strict"), true);
    assert.equal(needs("customTool", {}), true);
    for (const level of ["strict", "on-request", "automatic"] as const)
      assert.equal(needs("read", { path: "/tmp/anything" }, level), false);
    assert.equal(needs("bash", { command: "rm -rf src" }, "automatic"), false);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("Pi extension suspends before tool execution; rejection blocks and invalid config stays strict", async () => {
  const previous = process.env.CATCOON_APPROVAL_LEVEL;
  try {
    for (const level of ["strict", "on-request", "automatic", "invalid"]) {
      process.env.CATCOON_APPROVAL_LEVEL = level;
      let handler!: (event: any, ctx: any) => Promise<any>;
      registerApproval({
        on: (_name: string, callback: typeof handler) => {
          handler = callback;
        },
      });
      let confirm!: (approved: boolean) => void;
      let prompts = 0;
      let settled = false;
      const result = handler(
        { toolName: "bash", input: { command: "npm test" } },
        {
          cwd: process.cwd(),
          ui: {
            confirm: () => {
              prompts++;
              return new Promise<boolean>((r) => {
                confirm = r;
              });
            },
          },
        },
      ).then((r) => {
        settled = true;
        return r;
      });
      await Promise.resolve();
      if (level === "automatic") {
        assert.equal(prompts, 0);
        assert.equal(await result, undefined);
      } else {
        assert.equal(prompts, 1);
        assert.equal(settled, false, "Tool gate must await the human reply");
        confirm(false);
        assert.equal((await result).block, true);
        assert.equal(
          await handler(
            { toolName: "write", input: { path: "new.ts" } },
            {
              cwd: process.cwd(),
              ui: { confirm: async () => true },
            },
          ),
          undefined,
          "An approved operation may continue",
        );
      }
    }
  } finally {
    if (previous === undefined) delete process.env.CATCOON_APPROVAL_LEVEL;
    else process.env.CATCOON_APPROVAL_LEVEL = previous;
  }
});
