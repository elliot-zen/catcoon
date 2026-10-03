import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store, AppError, id, find, hash } from "../server/store.ts";
import {
  Domain,
  dependencies,
  task,
  artifact,
  makeRequest,
} from "../server/domain.ts";
import { Runtime as NativeRuntime, parseReport } from "../server/runtime.ts";
import { readSpec, saveSpec } from "../server/files.ts";
import { evaluate } from "../server/jev.ts";
import { createApp } from "../server/index.ts";
import type {
  Issue,
  Project,
  Worktree,
  Binding,
  Task,
  Run,
  Request,
  Artifact,
} from "../server/types.ts";
// Domain/routing tests isolate authenticated tools; native peers are tested separately.
class Runtime extends NativeRuntime {
  async prepareCodex(bindingId: string, path: string) {
    return this.session(bindingId, "codex", path);
  }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "relay-test-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "docs/PRODUCT.md"), "# Product");
  writeFileSync(join(repo, "docs/TECH.md"), "# Tech");
  const store = new Store(join(root, "data")),
    domain = new Domain(store),
    runtime = new Runtime(store);
  store.change((s) =>
    s.agents.push(
      {
        id: "codex",
        name: "Codex",
        command: "codex",
        version: "test",
        status: "available",
        heartbeat: "",
        reason: "",
      },
      {
        id: "pi",
        name: "Pi",
        command: "pi",
        version: "test",
        status: "available",
        heartbeat: "",
        reason: "",
      },
    ),
  );
  const issue = domain.action("issue.create", {
    title: "Build collaboration",
  }) as Issue;
  const project = domain.action("project.create", {
    name: "Backend",
    path: repo,
  }) as Project;
  const tree = domain.action("worktree.create", {
    projectId: project.id,
    name: "Main",
    branch: "main",
    path: repo,
    specName: "Core",
    specDir: "docs",
  }) as Worktree;
  const binding = domain.action("binding.save", {
    issueId: issue.id,
    projectId: project.id,
    worktreeId: tree.id,
    agentId: "codex",
    description: "Implement backend only",
  }) as Binding;
  const start = () => {
    domain.action("issue.control", { issueId: issue.id, command: "start" });
    return store.read().tasks[0];
  };
  const begin = () => {
    const t = start();
    return runtime.begin(
      t.id,
      binding.id,
      runtime.context(store.read(), t, binding),
      find(store.read().bindings, binding.id).revision,
    )!;
  };
  const done = () => {
    const r = begin();
    runtime.complete(
      r.id,
      true,
      "```json\n" +
        JSON.stringify({
          summary: "Finished",
          artifacts: [
            {
              title: "Evidence",
              kind: "report",
              content: "Inspectable changes",
            },
          ],
        }) +
        "\n```",
      "",
    );
    return r;
  };
  const close = () => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  };
  return {
    root,
    repo,
    store,
    domain,
    runtime,
    issue,
    project,
    tree,
    binding,
    start,
    begin,
    done,
    close,
  };
}
const code = (expected: string) => (e: unknown) =>
  e instanceof AppError && e.code === expected;
test("creation validates, persists unique numbers and is idempotent", () => {
  const f = fixture();
  try {
    assert.throws(
      () => f.domain.action("issue.create", { title: "  " }),
      code("INVALID_INPUT"),
    );
    const key = id();
    const a = f.domain.action("issue.create", { title: "two" }, key) as Issue;
    assert.deepEqual(f.domain.action("issue.create", { title: "two" }, key), a);
    assert.throws(
      () => f.domain.action("issue.create", { title: "three" }, key),
      code("IDEMPOTENCY_CONFLICT"),
    );
    assert.equal(f.store.read().issues.length, 2);
    assert.equal(a.number, "REL-2");
    assert.equal(a.status, "Todo");
    assert.equal(f.store.read().tasks.length, 0);
  } finally {
    f.close();
  }
});
test("bindings validate description, ownership, duplicates and snapshots", () => {
  const f = fixture();
  try {
    const base = {
      issueId: f.issue.id,
      projectId: f.project.id,
      worktreeId: f.tree.id,
      agentId: "codex",
    };
    assert.throws(
      () => f.domain.action("binding.save", { ...base, description: "x" }),
      code("DUPLICATE_BINDING"),
    );
    assert.throws(
      () =>
        f.domain.action("binding.save", {
          ...base,
          agentId: "pi",
          description: "  ",
        }),
      code("INVALID_INPUT"),
    );
    const other = f.domain.action("project.create", {
      name: "Alias",
      path: (() => {
        const p = join(f.root, "other");
        mkdirSync(p);
        execFileSync("git", ["init", "-b", "main", p], { stdio: "ignore" });
        return p;
      })(),
    }) as Project;
    assert.throws(
      () =>
        f.domain.action("binding.save", {
          ...base,
          projectId: other.id,
          agentId: "pi",
          description: "docs",
        }),
      code("INVALID_REPOSITORY"),
    );
    const r = f.begin();
    f.domain.action("binding.save", {
      ...base,
      id: f.binding.id,
      revision: 0,
      agentId: "pi",
      description: "Updated scope",
    });
    assert.equal(f.store.read().runs[0].snapshot.agentName, "Codex");
    assert.equal(
      f.store.read().runs[0].snapshot.description,
      "Implement backend only",
    );
    assert.throws(
      () =>
        f.domain.action("binding.remove", {
          bindingId: f.binding.id,
          reason: "replace",
        }),
      code("RESULT_UNKNOWN"),
    );
    assert.equal(r.status, "starting");
  } finally {
    f.close();
  }
});
test("scope dependency is preserved across read/archive and two decisions", () => {
  const f = fixture();
  try {
    const t = f.start();
    const a = f.domain.action("artifact.publish", {
      issueId: f.issue.id,
      title: "Spec",
      content: "v1",
    }) as Artifact;
    const make = () =>
      f.domain.action("request.create", {
        issueId: f.issue.id,
        title: "Review",
        kind: "approval",
        artifactIds: [a.id],
        action: "Implement v1",
        scope: [t.id],
      }) as Request;
    const r1 = make(),
      r2 = make();
    const n = f.store.read().notifications[0];
    f.domain.action("notification.update", {
      notificationId: n.id,
      read: true,
      archived: true,
    });
    assert.equal(f.store.read().requests[0].status, "Pending");
    assert.equal(dependencies(f.store.read(), t), false);
    f.domain.action("request.decide", {
      requestId: r1.id,
      revision: 0,
      decision: "approve",
    });
    assert.equal(dependencies(f.store.read(), t), false);
    assert.throws(
      () =>
        f.domain.action("request.decide", {
          requestId: r1.id,
          revision: 0,
          decision: "changes",
          answer: "No",
        }),
      code("REQUEST_RESOLVED"),
    );
    f.domain.action("request.decide", {
      requestId: r2.id,
      revision: 0,
      decision: "approve",
    });
    assert.equal(dependencies(f.store.read(), t), true);
    assert.equal(f.store.read().issues[0].status, "In progress");
  } finally {
    f.close();
  }
});
test("input requires explicit valid answer; ordinary comments grant nothing", () => {
  const f = fixture();
  try {
    const t = f.start();
    const r = f.domain.action("request.create", {
      issueId: f.issue.id,
      title: "Choose",
      kind: "input",
      options: [{ value: "one", label: "One" }],
      scope: [t.id],
    }) as Request;
    f.domain.action("comment.create", { issueId: f.issue.id, text: "Approve" });
    assert.equal(f.store.read().requests[0].status, "Pending");
    assert.throws(
      () =>
        f.domain.action("request.decide", {
          requestId: r.id,
          revision: 0,
          decision: "answer",
          answer: "two",
        }),
      code("INVALID_INPUT"),
    );
    assert.throws(
      () =>
        f.domain.action("request.decide", {
          requestId: r.id,
          revision: 0,
          decision: "approve",
        }),
      code("INVALID_INPUT"),
    );
    f.domain.action("request.decide", {
      requestId: r.id,
      revision: 0,
      decision: "answer",
      answer: "one",
    });
    assert.equal(f.store.read().requests[0].status, "Answered");
  } finally {
    f.close();
  }
});
test("routing answers accept a unique Agent name and preserve canonical binding plus idempotency", async () => {
  const f = fixture();
  try {
    const t = f.start();
    f.domain.action("issue.control", { issueId: f.issue.id, command: "pause" });
    // Only the candidates captured by this request may be selected.
    const pi = f.domain.action("binding.save", {
      issueId: f.issue.id,
      projectId: f.project.id,
      worktreeId: f.tree.id,
      agentId: "pi",
      description: "Handle documentation",
    }) as Binding;
    const q = f.store.change((s) =>
      f.runtime.human(
        s,
        find(s.tasks, t.id),
        "Low confidence; confirm work scope",
        true,
      ),
    ) as Request;
    assert.equal(q.status, "Pending");
    assert.equal(find(f.store.read().tasks, t.id).bindingId, undefined);
    const key = id();
    const payload = {
      requestId: q.id,
      revision: q.revision,
      decision: "answer",
      answer: "  cOdEx  ",
    };
    const result = f.domain.action("request.decide", payload, key) as Request;
    assert.equal(result.answer, f.binding.id);
    assert.equal(result.status, "Answered");
    assert.deepEqual(f.domain.action("request.decide", payload, key), result);
    assert.equal(find(f.store.read().tasks, t.id).bindingId, f.binding.id);
    assert.equal(
      f.store
        .read()
        .events.filter(
          (e) => e.requestId === q.id && e.type === "request.answer",
        ).length,
      1,
    );
    assert.equal(
      f.store.read().notifications.find((n) => n.requestId === q.id)?.archived,
      true,
    );
    await f.runtime.tick();
    assert.equal(f.store.read().runs.length, 0); // Answering cannot bypass Pause.
    const restricted = f.domain.action("request.create", {
      issueId: f.issue.id,
      taskId: t.id,
      title: "Codex candidate only",
      kind: "input",
      routeTask: true,
      options: [{ value: f.binding.id, label: "Codex backend binding" }],
    }) as Request;
    assert.throws(
      () =>
        f.domain.action("request.decide", {
          requestId: restricted.id,
          revision: 0,
          decision: "answer",
          answer: "Pi",
        }),
      code("INVALID_INPUT"),
    );
    assert.equal(
      find(f.store.read().requests, restricted.id).status,
      "Pending",
    );
    assert.notEqual(find(f.store.read().tasks, t.id).bindingId, pi.id);
  } finally {
    f.close();
  }
});

test("routing names and duplicate labels never guess between bindings; copied full rows remain usable", () => {
  const f = fixture();
  try {
    // Add a second legitimate Worktree using the same tool.
    execFileSync(
      "git",
      [
        "-C",
        f.repo,
        "-c",
        "user.name=Relay Test",
        "-c",
        "user.email=relay@example.test",
        "commit",
        "--allow-empty",
        "-m",
        "fixture",
      ],
      { stdio: "ignore" },
    );
    const path = join(f.root, "second");
    execFileSync(
      "git",
      ["-C", f.repo, "worktree", "add", "-b", "second", path],
      { stdio: "ignore" },
    );
    const tree = f.domain.action("worktree.create", {
      projectId: f.project.id,
      name: "Second",
      branch: "second",
      path,
      specName: "Core",
      specDir: "docs",
    }) as Worktree;
    const second = f.domain.action("binding.save", {
      issueId: f.issue.id,
      projectId: f.project.id,
      worktreeId: tree.id,
      agentId: "codex",
      description: "Implement second scope",
    }) as Binding;
    const t = f.start();
    const q = f.store.change((s) =>
      f.runtime.human(s, find(s.tasks, t.id), "Choose work scope", true),
    ) as Request;
    const before = f.store.read();
    assert.throws(
      () =>
        f.domain.action("request.decide", {
          requestId: q.id,
          revision: 0,
          decision: "answer",
          answer: "Codex",
        }),
      (e: unknown) =>
        code("INVALID_INPUT")(e) &&
        (e as Error).message.includes("More than one"),
    );
    assert.deepEqual(f.store.read(), before); // No task, notification or decision changes.
    const option = q.options!.find((o) => o.value === second.id)!;
    f.domain.action("request.decide", {
      requestId: q.id,
      revision: 0,
      decision: "answer",
      answer: `${option.label} · ${option.value}`,
    });
    assert.equal(find(f.store.read().tasks, t.id).bindingId, second.id);
    const dup = f.domain.action("request.create", {
      issueId: f.issue.id,
      taskId: t.id,
      title: "Duplicate descriptions",
      kind: "input",
      routeTask: true,
      options: [
        { value: f.binding.id, label: "Same scope" },
        { value: second.id, label: "Same scope" },
      ],
    }) as Request;
    assert.throws(
      () =>
        f.domain.action("request.decide", {
          requestId: dup.id,
          revision: 0,
          decision: "answer",
          answer: "Same scope",
        }),
      code("INVALID_INPUT"),
    );
    assert.equal(find(f.store.read().requests, dup.id).status, "Pending");
    f.domain.action("request.decide", {
      requestId: dup.id,
      revision: 0,
      decision: "answer",
      answer: f.binding.id,
    });
    assert.equal(find(f.store.read().tasks, t.id).bindingId, f.binding.id);
  } finally {
    f.close();
  }
});

test("option values take precedence over labels; routing aliases cannot revive removed bindings or answer ordinary options", () => {
  const f = fixture();
  try {
    const ordinary = f.domain.action("request.create", {
      issueId: f.issue.id,
      title: "Choose policy",
      kind: "input",
      options: [{ value: "policy", label: "Codex backend policy" }],
    }) as Request;
    assert.throws(
      () =>
        f.domain.action("request.decide", {
          requestId: ordinary.id,
          revision: 0,
          decision: "answer",
          answer: "Codex",
        }),
      code("INVALID_INPUT"),
    );
    const exact = f.domain.action("request.create", {
      issueId: f.issue.id,
      title: "Overlapping values and labels",
      kind: "input",
      options: [
        { value: "Codex", label: "Explicit value" },
        { value: "other", label: "Codex" },
      ],
    }) as Request;
    const result = f.domain.action("request.decide", {
      requestId: exact.id,
      revision: 0,
      decision: "answer",
      answer: "Codex",
    }) as Request;
    assert.equal(result.answer, "Codex");
    const t = f.start();
    const q = f.store.change((s) =>
      f.runtime.human(s, find(s.tasks, t.id), "Confirm scope", true),
    ) as Request;
    f.domain.action("binding.remove", {
      bindingId: f.binding.id,
      reason: "Scope removed",
    });
    const before = f.store.read();
    assert.throws(
      () =>
        f.domain.action("request.decide", {
          requestId: q.id,
          revision: 0,
          decision: "answer",
          answer: "Codex",
        }),
      code("STALE_VERSION"),
    );
    assert.deepEqual(f.store.read(), before);
  } finally {
    f.close();
  }
});

test("pause plus approval cannot dispatch; final acceptance alone completes", () => {
  const f = fixture();
  try {
    const r = f.done();
    f.domain.action("issue.control", { issueId: f.issue.id, command: "final" });
    const q = f.store.read().requests[0];
    f.domain.action("issue.control", { issueId: f.issue.id, command: "pause" });
    f.domain.action("request.decide", {
      requestId: q.id,
      revision: 0,
      decision: "approve",
    });
    assert.equal(f.store.read().issues[0].status, "Done");
    f.runtime.complete(r.id, true, "Late output", "");
    assert.equal(f.store.read().issues[0].status, "Done");
    assert.ok(f.store.read().events.some((e) => e.type === "run.late"));
    assert.throws(
      () =>
        f.domain.action("task.create", { issueId: f.issue.id, text: "extra" }),
      code("DEPENDENCY_BLOCKED"),
    );
    f.domain.action("issue.control", {
      issueId: f.issue.id,
      command: "reopen",
      text: "New goal",
    });
    assert.equal(f.store.read().issues[0].paused, true);
    assert.equal(f.store.read().tasks.length, 2);
  } finally {
    f.close();
  }
});
test("final acceptance revalidates added work; approval without material rejected", () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        f.domain.action("request.create", {
          issueId: f.issue.id,
          title: "Review",
          kind: "approval",
          action: "do things",
        }),
      code("INVALID_INPUT"),
    );
    f.done();
    f.domain.action("issue.control", { issueId: f.issue.id, command: "final" });
    const q = f.store.read().requests[0];
    f.domain.action("task.create", {
      issueId: f.issue.id,
      text: "Additional work",
    });
    assert.throws(
      () =>
        f.domain.action("request.decide", {
          requestId: q.id,
          revision: 0,
          decision: "approve",
        }),
      code("DEPENDENCY_BLOCKED"),
    );
    assert.equal(f.store.read().requests[0].status, "Pending");
  } finally {
    f.close();
  }
});
test("artifact replacement expires exact old approval while drafts do not", () => {
  const f = fixture();
  try {
    const a = f.domain.action("artifact.publish", {
      issueId: f.issue.id,
      title: "v1",
      content: "first",
    }) as Artifact;
    const q = f.domain.action("request.create", {
      issueId: f.issue.id,
      title: "Review",
      kind: "approval",
      artifactIds: [a.id],
      action: "implement",
      scope: "issue",
    }) as Request;
    saveSpec(
      f.tree,
      "product",
      "# New draft",
      readSpec(f.tree, "product").version,
    );
    assert.equal(f.store.read().requests[0].status, "Pending");
    f.domain.action("artifact.publish", {
      issueId: f.issue.id,
      title: "v2",
      content: "second",
      supersedesId: a.id,
    });
    assert.equal(f.store.read().requests[0].status, "Superseded");
    assert.throws(
      () =>
        f.domain.action("request.decide", {
          requestId: q.id,
          revision: 0,
          decision: "approve",
        }),
      code("REQUEST_RESOLVED"),
    );
  } finally {
    f.close();
  }
});
test("spec CAS keeps external content, rejects escaping directories", () => {
  const f = fixture();
  try {
    const read = readSpec(f.tree, "product");
    writeFileSync(read.path, "external");
    assert.throws(
      () => saveSpec(f.tree, "product", "my edit", read.version),
      code("SPEC_CONFLICT"),
    );
    assert.equal(readFileSync(read.path, "utf8"), "external");
    const out = join(f.root, "out");
    mkdirSync(out);
    symlinkSync(out, join(f.repo, "escape"));
    assert.throws(
      () => readSpec({ ...f.tree, specDir: "escape" }, "product"),
      code("PATH_OUTSIDE_WORKTREE"),
    );
    assert.throws(
      () => readSpec({ ...f.tree, specDir: "../out" }, "tech"),
      code("PATH_OUTSIDE_WORKTREE"),
    );
    const fresh = readSpec(f.tree, "product");
    saveSpec(f.tree, "product", "resolved", fresh.version);
    assert.equal(readSpec(f.tree, "product").content, "resolved");
  } finally {
    f.close();
  }
});
test("worktree mutex and restart preserve unknown execution until evidence", () => {
  const f = fixture();
  try {
    const r = f.begin();
    const issue = f.domain.action("issue.create", {
      title: "Second writer",
    }) as Issue;
    const b = f.domain.action("binding.save", {
      issueId: issue.id,
      projectId: f.project.id,
      worktreeId: f.tree.id,
      agentId: "codex",
      description: "Second",
    }) as Binding;
    f.domain.action("issue.control", { issueId: issue.id, command: "start" });
    const t = f.store.read().tasks.find((t) => t.issueId === issue.id)!;
    assert.throws(
      () => f.runtime.begin(t.id, b.id, "context", 0),
      code("WORKTREE_BUSY"),
    );
    f.domain.recover();
    assert.equal(f.store.read().runs[0].status, "unknown");
    assert.equal(f.store.read().tasks[0].status, "unknown");
    assert.throws(
      () =>
        f.domain.action("task.retry", { taskId: r.taskId, reason: "retry" }),
      code("RESULT_UNKNOWN"),
    );
    assert.throws(
      () => f.runtime.begin(t.id, b.id, "context", 0),
      code("WORKTREE_BUSY"),
    );
    f.domain.action("run.reconcile", {
      runId: r.id,
      outcome: "stopped",
      evidence: "Checked old process is absent and Git diff captured",
    });
    assert.ok(f.runtime.begin(t.id, b.id, "context", 0));
    assert.equal(
      f.store.read().runs[0].result,
      "Checked old process is absent and Git diff captured",
    );
  } finally {
    f.close();
  }
});
test("Agent approval is rejected and clarification task answer resumes original", () => {
  const f = fixture();
  try {
    const r = f.begin();
    f.runtime.complete(
      r.id,
      true,
      "```json\n" +
        JSON.stringify({
          summary: "Blocked",
          requests: [
            {
              kind: "input",
              title: "Which field?",
              body: "Contract unclear",
              routeToAgent: true,
            },
          ],
        }) +
        "\n```",
      "",
    );
    let s = f.store.read();
    const original = s.tasks[0],
      answer = s.tasks[1],
      q = s.requests[0];
    assert.equal(original.status, "waiting");
    assert.equal(answer.requestId, q.id);
    assert.equal(dependencies(s, answer), true);
    const r2 = f.runtime.begin(answer.id, f.binding.id, "context", 0)!;
    f.runtime.complete(
      r2.id,
      true,
      "```json\n" +
        JSON.stringify({
          summary: "Explained",
          answer: { requestId: q.id, text: "Use field id" },
        }) +
        "\n```",
      "",
    );
    s = f.store.read();
    assert.equal(s.requests[0].status, "Answered");
    assert.equal(dependencies(s, s.tasks[0]), true);
    assert.ok(f.runtime.begin(original.id, f.binding.id, "resume", 0));
  } finally {
    f.close();
  }
});
test("missing bound material blocks handoff; report parsing does not invent completion", () => {
  const f = fixture();
  try {
    rmSync(join(f.repo, "docs/TECH.md"));
    mkdirSync(join(f.repo, "docs/TECH.md"));
    assert.throws(() =>
      f.runtime.context(f.store.read(), f.start(), f.binding),
    );
    assert.equal(parseReport("Finished all tests"), undefined);
    assert.equal(parseReport('```json\n{"summary":"ok"}\n```')?.summary, "ok");
  } finally {
    f.close();
  }
});
test("failure is not automatically replayed and no secret appears in public state", () => {
  const f = fixture();
  try {
    f.store.saveKey("sensitive-key-123");
    const r = f.begin();
    f.runtime.complete(
      r.id,
      false,
      "",
      "Bearer sensitive-key-123 authentication failed",
    );
    const s = f.store.read();
    assert.equal(s.runs[0].status, "failed");
    assert.equal(s.tasks[0].status, "waiting");
    assert.match(s.tasks[0].reason || "", /Execution failed/);
    assert.equal(s.agents[0].status, "authentication required");
    assert.ok(
      !JSON.stringify(f.store.publicState()).includes("sensitive-key-123"),
    );
    assert.ok(!JSON.stringify(f.store.publicState()).includes("context"));
  } finally {
    f.close();
  }
});
test("Jev uses correct typed wire format, confidence and finite retries", async () => {
  const attempts: number[] = [];
  let payload: any;
  let count = 0;
  const fetcher = (async (_url: any, opts: any) => {
    payload = JSON.parse(opts.body);
    count++;
    if (count < 2) return new Response("{}", { status: 429 });
    return Response.json({
      model: "jev-test",
      answers: {
        route: {
          type: "choice",
          choice: "binding",
          confidence: 0.9,
          probabilities: { binding: 0.95, human: 0.05 },
        },
      },
    });
  }) as typeof fetch;
  const result = await evaluate(
    "key",
    { task: "x" },
    { binding: "frontend", human: "human" },
    (n) => attempts.push(n),
    fetcher,
  );
  assert.equal(result.choice, "binding");
  assert.equal(payload.model, "jev-latest");
  assert.equal(payload.questions.route.type, "choice");
  assert.equal(count, 2);
  assert.ok(attempts.includes(2));
  let unauthorized = 0;
  await assert.rejects(
    evaluate("bad", {}, { human: "human" }, undefined, (async () => {
      unauthorized++;
      return new Response("{}", { status: 401 });
    }) as typeof fetch),
    code("JEV_UNAVAILABLE"),
  );
  assert.equal(unauthorized, 1);
});
test("HTTP persistence, idempotency, same-origin writes and secret boundaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-api-"));
  const app = createApp(root, { worker: false });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const addr = app.server.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}`;
  try {
    const key = id(),
      post = (body: any, origin?: string) =>
        fetch(url + "/api/actions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": key,
            ...(origin ? { Origin: origin } : {}),
          },
          body: JSON.stringify(body),
        });
    const body = { type: "issue.create", payload: { title: "API Issue" } };
    assert.equal((await post(body, "https://evil.example")).status, 403);
    const first = await (await post(body)).json();
    const second = await (await post(body)).json();
    assert.equal(first.result.id, second.result.id);
    assert.equal(
      (await post({ ...body, payload: { title: "Changed" } })).status,
      409,
    );
    app.store.saveKey("secret-do-not-expose");
    const state = await (await fetch(url + "/api/state")).json();
    assert.equal(state.issues.length, 1);
    assert.equal(state.settings.configured, true);
    assert.ok(!JSON.stringify(state).includes("secret-do-not-expose"));
    const newStore = new Store(root);
    assert.equal(newStore.read().issues[0].title, "API Issue");
    newStore.close();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("replacement approval moves only its dependent tasks; revision bypasses rejected proposal", () => {
  const f = fixture();
  try {
    const t = f.start();
    const a = f.domain.action("artifact.publish", {
      issueId: f.issue.id,
      title: "Version1",
      content: "v1",
    }) as Artifact;
    const r = f.domain.action("request.create", {
      issueId: f.issue.id,
      title: "Review v1",
      kind: "approval",
      artifactIds: [a.id],
      action: "implement v1",
      scope: "issue",
    }) as Request;
    const next = f.domain.action("task.create", {
      issueId: f.issue.id,
      text: "Implement approved version",
      dependencyIds: [r.id],
    }) as Task;
    f.domain.action("request.decide", {
      requestId: r.id,
      revision: 0,
      decision: "changes",
      answer: "Add validation",
    });
    let s = f.store.read();
    const revision = s.tasks.find((t) => t.sourceId === r.id)!;
    assert.equal(dependencies(s, revision), true);
    assert.equal(dependencies(s, next), false);
    const a2 = f.domain.action("artifact.publish", {
      issueId: f.issue.id,
      title: "Version2",
      content: "v2",
      supersedesId: a.id,
    }) as Artifact;
    const r2 = f.domain.action("request.create", {
      issueId: f.issue.id,
      title: "Review v2",
      kind: "approval",
      artifactIds: [a2.id],
      action: "implement v2",
      scope: "issue",
      supersedesId: r.id,
    }) as Request;
    assert.deepEqual(
      f.store.read().tasks.find((t) => t.id === next.id)!.dependencyIds,
      [r2.id],
    );
    assert.equal(dependencies(f.store.read(), next), false);
    f.domain.action("request.decide", {
      requestId: r2.id,
      revision: 0,
      decision: "approve",
    });
    s = f.store.read();
    assert.equal(
      dependencies(
        s,
        s.tasks.find((t) => t.id === next.id)!,
      ),
      true,
    );
    assert.equal(s.requests.find((q) => q.id === r.id)!.supersededById, r2.id);
  } finally {
    f.close();
  }
});

test("final changes produce revision and a fresh final approval, never reuse decision", () => {
  const f = fixture();
  try {
    f.done();
    f.domain.action("issue.control", { issueId: f.issue.id, command: "final" });
    const q = f.store.read().requests[0];
    f.domain.action("request.decide", {
      requestId: q.id,
      revision: 0,
      decision: "changes",
      answer: "Revise evidence",
    });
    const revision = f.store.read().tasks.find((t) => t.sourceId === q.id)!;
    assert.equal(dependencies(f.store.read(), revision), true);
    const r = f.runtime.begin(revision.id, f.binding.id, "revision", 0)!;
    f.runtime.complete(
      r.id,
      true,
      "```json\n" +
        JSON.stringify({
          summary: "Revised",
          artifacts: [
            {
              title: "Revised evidence",
              content: "Actual verification results",
            },
          ],
        }) +
        "\n```",
      "",
    );
    f.domain.action("issue.control", { issueId: f.issue.id, command: "final" });
    let s = f.store.read();
    const q2 = s.requests.find(
      (q) => q.kind === "final" && q.status === "Pending",
    )!;
    assert.notEqual(q2.id, q.id);
    assert.equal(s.requests.find((r) => r.id === q.id)!.status, "Superseded");
    f.domain.action("request.decide", {
      requestId: q2.id,
      revision: 0,
      decision: "approve",
    });
    assert.equal(f.store.read().issues[0].status, "Done");
  } finally {
    f.close();
  }
});

test("Agent request escalates to same Human request without duplicate question", () => {
  const f = fixture();
  try {
    const r = f.begin();
    f.runtime.complete(
      r.id,
      true,
      "```json\n" +
        JSON.stringify({
          summary: "Question",
          requests: [
            {
              kind: "input",
              title: "Missing contract",
              body: "Which field?",
              routeToAgent: true,
            },
          ],
        }) +
        "\n```",
      "",
    );
    let s = f.store.read();
    assert.equal(s.issues[0].status, "In progress");
    const q = s.requests[0],
      resolver = s.tasks[1];
    f.store.change((s) => {
      f.runtime.human(s, find(s.tasks, resolver.id), "No matching binding");
    });
    s = f.store.read();
    assert.equal(s.requests.length, 1);
    assert.equal(s.requests[0].recipient, "Human");
    assert.equal(s.notifications[0].archived, false);
    f.domain.action("request.decide", {
      requestId: q.id,
      revision: 0,
      decision: "answer",
      answer: "Use id",
    });
    s = f.store.read();
    assert.equal(s.tasks[1].status, "done");
    assert.equal(dependencies(s, s.tasks[0]), true);
  } finally {
    f.close();
  }
});

test("malformed Agent handoff is atomic and cannot leave partial approval or tasks", () => {
  const f = fixture();
  try {
    const r = f.begin();
    f.runtime.complete(
      r.id,
      true,
      "```json\n" +
        JSON.stringify({
          summary: "Invalid",
          artifacts: [{ title: "Good artifact", content: "x" }],
          requests: [
            {
              kind: "approval",
              title: "valid",
              artifactIndexes: [0],
              action: "continue",
            },
            { kind: "final", title: "bad" },
          ],
          tasks: [{ text: "must not survive" }],
        }) +
        "\n```",
      "",
    );
    const s = f.store.read();
    assert.equal(s.requests.filter((q) => q.kind === "approval").length, 0);
    assert.equal(s.tasks.length, 1);
    assert.equal(s.artifacts.length, 1);
    assert.equal(s.artifacts[0].title, "Invalid handoff — inspect output");
    assert.equal(s.tasks[0].status, "waiting");
  } finally {
    f.close();
  }
});

test("Jev race discards obsolete decision and low confidence asks once", async () => {
  const f = fixture();
  try {
    f.store.saveKey("test");
    let calls = 0;
    const fetcher = (async (_url: any, options: any) => {
      calls++;
      const body = JSON.parse(options.body);
      return Response.json({
        model: "jev-test",
        answers: {
          route: {
            type: "choice",
            choice: f.binding.id,
            confidence: 0.2,
            probabilities: { [f.binding.id]: 0.55, human: 0.45 },
          },
        },
      });
    }) as typeof fetch;
    const runtime = new Runtime(f.store, fetcher);
    const t = f.start();
    await runtime.dispatch(t.id);
    assert.equal(f.store.read().runs.length, 0);
    assert.equal(f.store.read().requests.length, 1);
    await runtime.tick();
    assert.equal(calls, 1);
    assert.equal(f.store.read().requests.length, 1);
  } finally {
    f.close();
  }
});

test("Pi RPC records real observable events, filters reasoning, and waits for settled", async () => {
  const f = fixture();
  const old = process.env.PATH;
  try {
    const bin = join(f.root, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "pi"),
      `#!/usr/bin/env node
const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);const send=x=>console.log(JSON.stringify(x));if(m.type==='get_state')send({id:m.id,type:'response',success:true,data:{sessionFile:process.argv[process.argv.indexOf('--session')+1],sessionId:'native-pi'}});if(m.type==='prompt'){send({id:m.id,type:'response',success:true});send({type:'tool_execution_end',name:'test command',result:{exit_code:1,output:'failed'}});send({type:'message_end',message:{role:'assistant',content:[{type:'thinking',thinking:'PRIVATE-THOUGHT'},{type:'text',text:JSON.stringify({summary:'Done',artifacts:[{kind:'report',title:'Evidence',content:'actual reported commands'}]})}],stopReason:'stop'}});send({type:'agent_end',willRetry:true});setTimeout(()=>send({type:'agent_settled'}),50);}});
`,
      { mode: 0o755 },
    );
    process.env.PATH = bin + ":" + old;
    f.domain.action("binding.save", {
      id: f.binding.id,
      issueId: f.issue.id,
      projectId: f.project.id,
      worktreeId: f.tree.id,
      agentId: "pi",
      description: "Pi evidence",
      revision: 0,
    });
    const r = f.begin();
    f.runtime.launch(r);
    for (
      let n = 0;
      n < 100 && f.store.read().runs[0].status !== "completed";
      n++
    )
      await new Promise((r) => setTimeout(r, 20));
    const s = f.store.read();
    assert.equal(s.runs[0].status, "completed");
    assert.equal(s.tasks[0].status, "done");
    assert.ok(s.sessions[0].sessionFile);
    assert.ok(s.runs[0].nativeTurnId);
    assert.ok(!JSON.stringify(s).includes("PRIVATE-THOUGHT"));
    assert.equal(f.store.db.prepare("SELECT * FROM locks").all().length, 0);
  } finally {
    f.runtime.shutdown();
    process.env.PATH = old;
    f.close();
  }
});
test("native abort confirms settled before unlocking and preserves correction", async () => {
  const f = fixture();
  const old = process.env.PATH;
  try {
    const bin = join(f.root, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "pi"),
      `#!/usr/bin/env node
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);console.log(JSON.stringify({id:m.id,type:'response',success:true,data:m.type==='get_state'?{sessionId:'pi'}:{}}));if(m.type==='abort')setTimeout(()=>console.log(JSON.stringify({type:'agent_settled'})),60);});
`,
      { mode: 0o755 },
    );
    process.env.PATH = bin + ":" + old;
    f.domain.action("binding.save", {
      id: f.binding.id,
      issueId: f.issue.id,
      projectId: f.project.id,
      worktreeId: f.tree.id,
      agentId: "pi",
      description: "Pi controlled abort",
      revision: 0,
    });
    const r = f.begin();
    f.runtime.launch(r);
    for (
      let n = 0;
      n < 100 && f.store.read().runs[0].status === "starting";
      n++
    )
      await new Promise((r) => setTimeout(r, 10));
    f.domain.action("issue.control", {
      issueId: f.issue.id,
      command: "stop",
      text: "Stop writing and inspect current diff",
    });
    assert.equal(f.store.db.prepare("SELECT * FROM locks").all().length, 1);
    await f.runtime.tick();
    assert.equal(f.store.read().runs[0].status, "stopping");
    for (
      let n = 0;
      n < 100 && f.store.read().runs[0].status === "stopping";
      n++
    )
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(f.store.read().runs[0].status, "stopped");
    assert.equal(f.store.db.prepare("SELECT * FROM locks").all().length, 0);
    assert.equal(
      f.store.read().tasks[1].text,
      "Stop writing and inspect current diff",
    );
  } finally {
    f.runtime.shutdown();
    process.env.PATH = old;
    f.close();
  }
});

test("asynchronous Jev result is discarded when binding changes while waiting", async () => {
  const f = fixture();
  try {
    f.store.saveKey("test");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runtime = new Runtime(f.store, (async () => {
      await gate;
      return Response.json({
        model: "jev-test",
        answers: {
          route: {
            type: "choice",
            choice: f.binding.id,
            confidence: 0.95,
            probabilities: { [f.binding.id]: 0.99, human: 0.01 },
          },
        },
      });
    }) as typeof fetch);
    const t = f.start();
    const work = runtime.dispatch(t.id);
    f.domain.action("binding.save", {
      ...f.binding,
      revision: 0,
      description: "Changed work scope",
    });
    release();
    await work;
    assert.equal(f.store.read().runs.length, 0);
    assert.equal(f.store.read().requests.length, 0);
    assert.equal(f.store.read().bindings[0].description, "Changed work scope");
  } finally {
    f.close();
  }
});

test("automatic chain budget pauses with one Human request and Resume resets only budget", async () => {
  const f = fixture();
  try {
    const t = f.start();
    f.store.change((s) => {
      for (let n = 0; n < 64; n++)
        s.runs.push({
          id: id(),
          issueId: f.issue.id,
          taskId: "history",
          bindingId: f.binding.id,
          snapshot: {
            ...f.binding,
            path: f.repo,
            branch: "main",
            projectName: "Backend",
            agentName: "Codex",
            command: "codex",
          },
          context: "history",
          status: "completed",
          startedAt: new Date().toISOString(),
        });
    });
    await f.runtime.dispatch(t.id);
    let s = f.store.read();
    assert.equal(s.issues[0].paused, true);
    assert.equal(s.requests.length, 1);
    await f.runtime.tick();
    assert.equal(f.store.read().requests.length, 1);
    const q = s.requests[0];
    f.domain.action("request.decide", {
      requestId: q.id,
      revision: 0,
      decision: "answer",
      answer: "Reviewed scope and progress",
    });
    f.domain.action("issue.control", {
      issueId: f.issue.id,
      command: "resume",
    });
    s = f.store.read();
    assert.equal(s.issues[0].runBudgetStart, 64);
    assert.equal(s.tasks.length, 1);
    assert.equal(s.runs.length, 64);
  } finally {
    f.close();
  }
});

test("replacing approved execution basis requests stop while keeping the worktree locked", () => {
  const f = fixture();
  try {
    const t = f.start();
    const a = f.domain.action("artifact.publish", {
      issueId: f.issue.id,
      title: "Approved spec",
      content: "v1",
    }) as Artifact;
    const q = f.domain.action("request.create", {
      issueId: f.issue.id,
      kind: "approval",
      title: "Implement v1",
      artifactIds: [a.id],
      action: "Implement v1",
      scope: [t.id],
    }) as Request;
    f.domain.action("request.decide", {
      requestId: q.id,
      revision: 0,
      decision: "approve",
    });
    const r = f.runtime.begin(t.id, f.binding.id, "approved context", 0)!;
    f.domain.action("artifact.publish", {
      issueId: f.issue.id,
      title: "New basis",
      content: "v2",
      supersedesId: a.id,
    });
    const s = f.store.read();
    assert.equal(s.runs[0].status, "stopping");
    assert.equal(s.runs[0].context, "approved context");
    assert.equal(s.requests[0].status, "Superseded");
    assert.equal(f.store.db.prepare("SELECT * FROM locks").all().length, 1);
  } finally {
    f.close();
  }
});

test("unreadable link cannot masquerade as a published contract and binary input requires clarification", () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        f.domain.action("artifact.publish", {
          issueId: f.issue.id,
          title: "Contract",
          kind: "contract",
          content: "https://unreadable.example/contract",
        }),
      code("MATERIAL_UNREADABLE"),
    );
    assert.equal(f.store.read().artifacts.length, 0);
    const t = f.start();
    f.store.change((s) =>
      s.attachments.push({
        id: id(),
        issueId: f.issue.id,
        name: "requirements.png",
        mime: "image/png",
        content: "AA==",
        createdAt: new Date().toISOString(),
      }),
    );
    assert.throws(
      () => f.runtime.context(f.store.read(), t, f.binding),
      code("DEPENDENCY_BLOCKED"),
    );
    const q = f.store.change((s) =>
      f.runtime.human(
        s,
        find(s.tasks, t.id),
        "Binary attachments require a textual interpretation. Supply the necessary content in your answer before execution.",
      ),
    );
    f.domain.action("request.decide", {
      requestId: q.id,
      revision: 0,
      decision: "answer",
      answer: "The image specifies a form with title and description fields.",
    });
    assert.match(
      f.runtime.context(f.store.read(), f.store.read().tasks[0], f.binding),
      /The image specifies a form/,
    );
  } finally {
    f.close();
  }
});

test("development proxy allows browser same-origin writes and rejects another origin", async () => {
  const { createServer: createViteServer, loadConfigFromFile } =
    await import("vite");
  const root = mkdtempSync(join(tmpdir(), "relay-origin-"));
  const app = createApp(root, { worker: false });
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  const apiPort = (app.server.address() as { port: number }).port;
  const loaded = await loadConfigFromFile({
    command: "serve",
    mode: "development",
  });
  assert.ok(loaded);
  const proxy = loaded.config.server?.proxy?.["/api"];
  assert.ok(proxy && typeof proxy === "object");
  const vite = await createViteServer({
    ...loaded.config,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      ...loaded.config.server,
      port: 0,
      strictPort: false,
      proxy: { "/api": { ...proxy, target: `http://127.0.0.1:${apiPort}` } },
    },
  });
  try {
    await vite.listen();
    const port = (vite.httpServer!.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${port}`;
    const post = (requestOrigin: string) =>
      fetch(origin + "/api/actions", {
        method: "POST",
        headers: {
          Origin: requestOrigin,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
          "Idempotency-Key": id(),
        },
        body: JSON.stringify({
          type: "issue.create",
          payload: { title: "Created through development proxy" },
        }),
      });
    const response = await post(origin);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(
      (await response.json()).result.title,
      "Created through development proxy",
    );
    assert.equal((await post("https://other.example")).status, 403);
    assert.equal(app.store.read().issues.length, 1);
  } finally {
    await vite.close();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Start and Agent handoff automatically route across bindings after Human approval", async () => {
  const f = fixture();
  try {
    const implementation = f.domain.action("binding.save", {
      issueId: f.issue.id,
      projectId: f.project.id,
      worktreeId: f.tree.id,
      agentId: "pi",
      description: "Implement the approved specification and verify it",
    }) as Binding;
    f.store.saveKey("test");
    const routed: any[] = [];
    const launched: Run[] = [];
    const runtime = new Runtime(f.store, (async (_url, options) => {
      const state = JSON.parse(String(options!.body)).state;
      routed.push(state);
      const choice =
        state.task.text === "Implement the approved specification"
          ? implementation.id
          : f.binding.id;
      return Response.json({
        model: "jev-test",
        answers: {
          route: {
            type: "choice",
            choice,
            confidence: 0.95,
            probabilities: { [choice]: 0.95, human: 0.05 },
          },
        },
      });
    }) as typeof fetch);
    // Capture dispatches without running authenticated model processes.
    runtime.launch = (run) => {
      launched.push(run);
    };
    const advance = async () => {
      await runtime.tick();
      for (let n = 0; n < 100 && runtime.inflight.size; n++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(runtime.inflight.size, 0);
    };
    await advance();
    assert.equal(launched.length, 0);
    f.start();
    await advance();
    assert.equal(launched.length, 1);
    assert.equal(launched[0].bindingId, f.binding.id);
    runtime.complete(
      launched[0].id,
      true,
      JSON.stringify({
        summary:
          "Specification ready for review; implementation follows approval",
        artifacts: [
          {
            kind: "spec",
            title: "Reviewable specification",
            content: "Exact scoped specification",
          },
        ],
        requests: [
          {
            kind: "approval",
            title: "Review specification",
            body: "Approve this version before implementation",
            artifactIndexes: [0],
            action: "Implement the approved specification",
            scope: "issue",
          },
        ],
        tasks: [{ text: "Implement the approved specification" }],
      }),
      "",
    );
    let state = f.store.read();
    const approval = state.requests.find((r) => r.kind === "approval")!;
    assert.ok(approval);
    assert.equal(state.issues[0].status, "Human input");
    assert.equal(state.tasks.length, 2);
    assert.deepEqual(state.tasks[1].dependencyIds, [approval.id]);
    assert.equal(state.tasks[1].sourceId, launched[0].id);
    assert.equal(state.artifacts[0].runId, launched[0].id);
    assert.equal(state.notifications[0].requestId, approval.id);
    await advance();
    await advance();
    assert.equal(launched.length, 1);
    assert.equal(routed.length, 1);
    f.domain.action("request.decide", {
      requestId: approval.id,
      revision: approval.revision,
      decision: "approve",
    });
    await advance();
    assert.equal(launched.length, 2);
    assert.equal(launched[1].bindingId, implementation.id);
    assert.equal(
      routed[1].requests.find((r: Request) => r.id === approval.id).status,
      "Approved",
    );
    assert.match(launched[1].context, /Exact scoped specification/);
    assert.match(launched[1].context, /Approved/);
    runtime.complete(
      launched[1].id,
      true,
      JSON.stringify({
        summary: "Implementation and verification completed",
        artifacts: [
          {
            kind: "test",
            title: "Verification evidence",
            content: "Inspectable verification output",
          },
        ],
      }),
      "",
    );
    await advance();
    state = f.store.read();
    const final = state.requests.find((r) => r.kind === "final")!;
    assert.ok(final);
    assert.equal(final.status, "Pending");
    assert.equal(final.artifactIds.length, 2);
    assert.equal(launched.length, 2);
    f.domain.action("request.decide", {
      requestId: final.id,
      revision: final.revision,
      decision: "approve",
    });
    await advance();
    assert.equal(f.store.read().issues[0].status, "Done");
    assert.equal(launched.length, 2);
  } finally {
    f.close();
  }
});
