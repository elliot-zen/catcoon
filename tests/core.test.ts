import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, typed, settle } from "./helpers.ts";
import { find, AppError, id } from "../server/store.ts";
import {
  saveDraft,
  readDocument,
  publishVersion,
  approvalIds,
} from "../server/specs.ts";
import { artifact, makeRequest, task, finalReady } from "../server/domain.ts";
import { jevContext } from "../server/context.ts";
import { questionsFor, evaluate, validateAnswers } from "../server/jev.ts";
import { sessions } from "../server/types.ts";
const code = (expected: string) => (e: unknown) =>
  e instanceof AppError && e.code === expected;
function model(f: ReturnType<typeof fixture>, choose: (input: any) => any) {
  f.store.saveKey("test-key");
  f.runtime.triage.fetcher = async (_url, options) => {
    const body = JSON.parse(String(options!.body));
    return new Response(JSON.stringify(choose(body.state)), { status: 200 });
  };
}
function begin(
  f: ReturnType<typeof fixture>,
  mode: "spec" | "implement" | "inspect" = "spec",
) {
  f.start();
  return f.runtime.begin(f.state().tasks[0].id, f.binding.id, mode)!;
}
function finish(
  f: ReturnType<typeof fixture>,
  r: any,
  text = "Read the repository and produced an inspectable result.",
) {
  f.runtime.started(r.id, r.sessionId, id());
  f.runtime.complete(r.id, true, text, "");
}
test("Description editing preserves text, uses CAS, and leaves unstarted Issues in Todo", () => {
  const f = fixture();
  try {
    const initial = f.state().issues[0];
    f.domain.action("issue.update", {
      issueId: initial.id,
      revision: initial.revision,
      description: "First line\nSecond line",
    });
    const changed = f.state().issues[0];
    assert.equal(changed.description, "First line\nSecond line");
    assert.equal(changed.targetRevision, initial.targetRevision + 1);
    assert.equal(changed.status, "Todo");
    assert.equal(f.state().tasks.length, 0);
    assert.throws(
      () =>
        f.domain.action("issue.update", {
          issueId: initial.id,
          revision: initial.revision,
          description: "Overwrite",
        }),
      code("STALE_VERSION"),
    );
    f.domain.action("issue.update", {
      issueId: changed.id,
      revision: changed.revision,
      description: changed.description,
    });
    assert.equal(f.state().issues[0].targetRevision, changed.targetRevision);
    const current = f.state().issues[0];
    f.domain.action("issue.update", {
      issueId: current.id,
      revision: current.revision,
      description: "",
    });
    assert.equal(f.state().issues[0].description, "");
  } finally {
    f.close();
  }
});
test("Target edits replace outstanding work and requests while retaining history and requiring fresh approval", async () => {
  const f = fixture();
  try {
    f.approve();
    assert.equal(
      approvalIds(
        f.state(),
        f.issue.id,
        find(f.state().worktrees, f.tree.id),
        "implement",
      ).length,
      1,
    );
    const r = begin(f, "implement");
    const update = () =>
      f.domain.action("issue.update", {
        issueId: f.issue.id,
        revision: f.state().issues[0].revision,
        description: "New target\nVerify farewell",
      });
    assert.throws(update, code("WORKTREE_BUSY"));
    assert.equal(f.state().issues[0].targetRevision, 1);
    finish(f, r, "Implemented greeting and ran its tests.");
    model(f, (input) => typed(input, "final", "none", "human", 1));
    await settle(f.runtime);
    const final = f.state().requests.find((q) => q.kind === "final")!;
    assert.ok(final);
    const oldTask = f.store.change((s) => {
      const t = task(s, f.issue.id, "Old follow-up");
      makeRequest(s, {
        issueId: f.issue.id,
        kind: "input",
        title: "Old question",
        scope: "issue",
      });
      return t;
    });
    f.domain.action("issue.control", { issueId: f.issue.id, command: "pause" });
    update();
    const s = f.state(),
      i = s.issues[0];
    assert.equal(i.control, "paused");
    assert.equal(i.status, "In progress");
    assert.equal(i.triage.dirty, true);
    assert.equal(i.targetRevision, 2);
    assert.equal(find(s.tasks, oldTask.id).status, "cancelled");
    assert.deepEqual(
      s.tasks.filter((t) => t.status === "pending").map((t) => t.text),
      ["New target\nVerify farewell"],
    );
    assert.equal(find(s.requests, final.id).status, "Superseded");
    assert.equal(
      s.requests.find((q) => q.title === "Old question")!.status,
      "Superseded",
    );
    assert.ok(s.notifications.every((n) => n.archived));
    assert.equal(
      s.requests.find((q) => q.action?.type === "approve_spec")!.status,
      "Approved",
    );
    assert.deepEqual(
      approvalIds(s, i.id, find(s.worktrees, f.tree.id), "implement"),
      [],
    );
    assert.equal(find(s.runs, r.id).status, "completed");
    assert.equal(
      find(s.runs, r.id).result,
      "Implemented greeting and ran its tests.",
    );
    assert.equal(find(s.runs, r.id).snapshot.targetRevision, 1);
    assert.throws(() => f.decide(final.id), code("REQUEST_RESOLVED"));
  } finally {
    f.close();
  }
});
test("Worktrees require exact project Spec/version; shared drafts use CAS and versions are immutable", () => {
  const f = fixture();
  try {
    const w2 = f.secondTree();
    assert.equal(w2.specId, f.tree.specId);
    assert.equal(w2.specVersionId, f.tree.specVersionId);
    const old = readDocument(
      f.state(),
      f.tree.specId,
      "product",
      f.tree.specVersionId,
    );
    f.store.change((s) =>
      saveDraft(s, {
        specId: f.tree.specId,
        document: "product",
        content: "new text",
        draftRevision: 0,
      }),
    );
    assert.equal(
      readDocument(f.state(), w2.specId, "product").content,
      "new text",
    );
    assert.throws(
      () =>
        f.store.change((s) =>
          saveDraft(s, {
            specId: f.tree.specId,
            document: "tech",
            content: "stale text",
            draftRevision: 0,
          }),
        ),
      code("SPEC_CONFLICT"),
    );
    assert.equal(
      readDocument(f.state(), f.tree.specId, "product", f.tree.specVersionId)
        .content,
      old.content,
    );
    const v = f.store.change((s) => publishVersion(s, f.tree.specId, 1));
    assert.equal(v.product, "new text");
    assert.equal(v.number, 2);
    assert.equal(
      find(f.state().worktrees, f.tree.id).specVersionId,
      f.tree.specVersionId,
    );
    assert.throws(() =>
      f.domain.action("worktree.create", {
        projectId: f.project.id,
        name: "bad",
        path: f.repo,
        branch: "main",
        specName: "local",
        specDir: "docs",
      }),
    );
  } finally {
    f.close();
  }
});
test("Spec proposal freezes pair, approval upgrades exactly listed Worktrees and automatically allows implementation", async () => {
  const f = fixture();
  try {
    const w2 = f.secondTree(),
      r = begin(f);
    f.runtime.started(r.id, r.sessionId, "turn");
    const result = f.runtime.handleTool(
      r.id,
      "relay_report",
      {
        specProposal: {
          specId: f.tree.specId,
          baseVersionId: f.tree.specVersionId,
          draftRevision: 0,
          product: "# Greeting\nHello world",
          tech: "# Function\nTest greeting",
          upgradeTargets: [
            {
              worktreeId: f.tree.id,
              fromVersionId: f.tree.specVersionId,
              worktreeRevision: 0,
            },
          ],
        },
      },
      "call-1",
    );
    assert.deepEqual(
      f.runtime.handleTool(
        r.id,
        "relay_report",
        {
          specProposal: {
            specId: f.tree.specId,
            baseVersionId: f.tree.specVersionId,
            draftRevision: 0,
            product: "# Greeting\nHello world",
            tech: "# Function\nTest greeting",
            upgradeTargets: [
              {
                worktreeId: f.tree.id,
                fromVersionId: f.tree.specVersionId,
                worktreeRevision: 0,
              },
            ],
          },
        },
        "call-1",
      ),
      result,
    );
    assert.equal(f.state().specVersions.length, 2);
    assert.equal(f.state().requests.length, 1);
    f.runtime.complete(r.id, true, "A frozen Spec is ready for approval.", "");
    const q = f.state().requests[0];
    assert.match(q.body, /V1 → V2/);
    f.decide(q.id);
    const upgraded = find(f.state().worktrees, f.tree.id);
    assert.notEqual(upgraded.specVersionId, f.tree.specVersionId);
    assert.equal(
      find(f.state().worktrees, w2.id).specVersionId,
      w2.specVersionId,
    );
    assert.equal(
      approvalIds(f.state(), f.issue.id, upgraded, "implement").length,
      1,
    );
    model(f, (input) => typed(input, "dispatch", "implement"));
    await settle(f.runtime);
    assert.equal(f.launched.length, 1);
    assert.equal(f.launched[0].mode, "implement");
    assert.equal(f.launched[0].snapshot.specVersionId, upgraded.specVersionId);
    assert.equal(f.launched[0].sessionId, r.sessionId);
  } finally {
    f.close();
  }
});
test("Combined approval rejects stale or busy targets atomically", () => {
  const f = fixture();
  try {
    const r = begin(f);
    f.runtime.started(r.id, r.sessionId, "turn");
    f.domain.report(
      r.id,
      {
        specProposal: {
          specId: f.tree.specId,
          baseVersionId: f.tree.specVersionId,
          draftRevision: 0,
          product: "P",
          tech: "T",
          upgradeTargets: [
            {
              worktreeId: f.tree.id,
              fromVersionId: f.tree.specVersionId,
              worktreeRevision: 0,
            },
          ],
        },
      },
      id(),
    );
    const q = f.state().requests[0];
    assert.throws(() => f.decide(q.id), code("WORKTREE_BUSY"));
    assert.equal(find(f.state().requests, q.id).status, "Pending");
    f.runtime.complete(r.id, true, "Proposal created.", "");
    f.store.change((s) => find(s.worktrees, f.tree.id).revision++);
    assert.throws(() => f.decide(q.id), code("STALE_VERSION"));
    assert.equal(
      find(f.state().worktrees, f.tree.id).specVersionId,
      f.tree.specVersionId,
    );
  } finally {
    f.close();
  }
});
test("Malformed reports roll back all material and cannot forge decisions or final acceptance", () => {
  const f = fixture();
  try {
    const r = begin(f);
    const before = f.state();
    assert.throws(
      () =>
        f.domain.report(
          r.id,
          {
            artifacts: [{ title: "Valid", content: "First" }],
            requests: [{ kind: "final", title: "Bypass" }],
          },
          id(),
        ),
      code("INVALID_INPUT"),
    );
    assert.deepEqual(f.state().artifacts, before.artifacts);
    assert.throws(
      () => f.domain.report(r.id, { approved: true }, id()),
      code("INVALID_INPUT"),
    );
    assert.throws(() =>
      f.domain.report(
        r.id,
        {
          requests: [
            {
              kind: "approval",
              title: "Bad",
              body: { evil: 1 },
              artifactIndexes: [],
              action: { type: "review", description: "test" },
            },
          ],
        },
        id(),
      ),
    );
  } finally {
    f.close();
  }
});
test("Natural answers return to Triage without final JSON, follow-up tasks or direct Done", async () => {
  const f = fixture();
  try {
    model(f, (input) =>
      typed(input, "dispatch", input.recentRuns.length ? "inspect" : "spec"),
    );
    f.start();
    await settle(f.runtime);
    const r = f.launched[0];
    assert.equal(f.state().issues[0].status, "In progress");
    finish(f, r, "I inspected the feature. More implementation is needed.");
    await settle(f.runtime);
    assert.equal(f.launched.length, 2);
    assert.equal(f.launched[1].mode, "inspect");
    assert.equal(find(f.state().runs, r.id).status, "completed");
    assert.equal(f.state().tasks.length, 1);
    assert.equal(f.state().requests.length, 0);
    assert.notEqual(f.state().issues[0].status, "Done");
  } finally {
    f.close();
  }
});
test("Actual evidence and goal evaluation produce final request; only Human decision reaches Done, Reopen stays paused", async () => {
  const f = fixture();
  try {
    f.approve();
    const r = begin(f, "implement");
    finish(f, r, "Implemented greeting. Executed tests; 2 passed, 0 failed.");
    model(f, (input) => typed(input, "final", "none", "human", 0.99));
    await settle(f.runtime);
    const final = f.state().requests.find((q) => q.kind === "final")!;
    assert.ok(final);
    assert.equal(f.state().issues[0].status, "Human input");
    f.decide(final.id);
    const done = f.state().issues[0];
    assert.throws(
      () =>
        f.domain.action("issue.update", {
          issueId: done.id,
          revision: done.revision,
          description: "Change the completed goal",
        }),
      code("DEPENDENCY_BLOCKED"),
    );
    assert.equal(f.state().issues[0].targetRevision, done.targetRevision);
    assert.equal(f.state().issues[0].status, "Done");
    f.domain.action("comment.create", {
      issueId: f.issue.id,
      text: "Historical comment",
    });
    assert.equal(f.state().issues[0].status, "Done");
    f.domain.action("issue.control", {
      issueId: f.issue.id,
      command: "reopen",
      text: "New behavior",
    });
    assert.equal(f.state().issues[0].status, "In progress");
    assert.equal(f.state().issues[0].control, "paused");
  } finally {
    f.close();
  }
});
test("Final changes create a revision which completes before new final acceptance", async () => {
  const f = fixture();
  try {
    f.approve();
    finish(f, begin(f, "implement"), "Implemented and tested.");
    model(f, (input) => typed(input, "final", "none", "human", 0.99));
    await settle(f.runtime);
    const final = f.state().requests.find((q) => q.kind === "final")!;
    f.decide(final.id, "changes", "Improve greeting punctuation.");
    model(f, (input) => typed(input, "dispatch", "revise"));
    await settle(f.runtime);
    const r = f.launched.at(-1)!;
    assert.equal(find(f.state().tasks, r.taskId).kind, "revision");
    finish(f, r, "Fixed punctuation and ran tests.");
    model(f, (input) => typed(input, "final", "none", "human", 0.99, 0.99));
    await settle(f.runtime);
    assert.equal(find(f.state().tasks, r.taskId).status, "done");
    assert.equal(
      f
        .state()
        .requests.filter((q) => q.kind === "final" && q.status === "Pending")
        .length,
      1,
    );
  } finally {
    f.close();
  }
});
test("Configuration restoration resolves configuration requests without fake answers", async () => {
  const f = fixture();
  try {
    f.start();
    await settle(f.runtime);
    const missing = f.state().requests[0];
    assert.equal(missing.conditionKey, "jev.key");
    model(f, (input) => typed(input));
    await settle(f.runtime);
    assert.equal(find(f.state().requests, missing.id).status, "Resolved");
    assert.equal(find(f.state().requests, missing.id).answer, undefined);
    assert.equal(f.launched.length, 1);
  } finally {
    f.close();
  }
});
test("Jev failure preserves queue and retries only after a real configuration change", async () => {
  const f = fixture();
  try {
    f.store.saveKey("test-key");
    let calls = 0;
    f.runtime.triage.fetcher = async () => {
      calls++;
      return new Response("unauthorized", { status: 401 });
    };
    f.start();
    await settle(f.runtime);
    assert.equal(calls, 1);
    await settle(f.runtime);
    assert.equal(calls, 1);
    assert.equal(f.state().tasks[0].status, "waiting");
    model(f, (input) => typed(input));
    f.store.change((s) => {
      s.issues[0].triage.dirty = true;
      s.issues[0].triage.evaluationRevision++;
    });
    await settle(f.runtime);
    assert.equal(f.launched.length, 1);
    assert.equal(f.state().requests[0].status, "Resolved");
  } finally {
    f.close();
  }
});
test("Typed Jev questions validate exact candidates, probabilities, Noul and low confidence", async () => {
  const f = fixture();
  try {
    const input = jevContext(f.state(), f.issue.id, id()),
      qs = questionsFor(input);
    assert.deepEqual(Object.keys(qs), [
      "next_action",
      "dispatch_mode",
      "route",
      "goal_complete",
    ]);
    const good = typed(input);
    validateAnswers(qs, good.answers);
    assert.throws(
      () =>
        validateAnswers(qs, {
          ...good.answers,
          route: { ...good.answers.route, choice: "codex" },
        }),
      code("JEV_INVALID_RESPONSE"),
    );
    assert.throws(
      () =>
        validateAnswers(qs, {
          ...good.answers,
          goal_complete: { type: "noul", noul: 2 },
        }),
      code("JEV_INVALID_RESPONSE"),
    );
    model(f, (input) => {
      const result = typed(input);
      result.answers.route.confidence = 0.2;
      return result;
    });
    f.start();
    await settle(f.runtime);
    assert.equal(f.launched.length, 0);
    assert.equal(f.state().requests[0].routeTask, true);
    f.decide(f.state().requests[0].id, "answer", "Pi");
    assert.equal(f.state().requests[0].answer, f.binding.id);
  } finally {
    f.close();
  }
});
test("Stale Jev responses cannot dispatch against changed binding or Pause", async () => {
  const f = fixture();
  try {
    f.store.saveKey("test-key");
    let release!: (r: Response) => void;
    let input: any;
    f.runtime.triage.fetcher = async (_u, o) => {
      input = JSON.parse(String(o!.body)).state;
      return new Promise<Response>((r) => (release = r));
    };
    f.start();
    await f.runtime.tick();
    await new Promise((r) => setImmediate(r));
    f.domain.action("issue.control", { issueId: f.issue.id, command: "pause" });
    release(new Response(JSON.stringify(typed(input))));
    await settle(f.runtime);
    assert.equal(f.launched.length, 0);
    assert.equal(f.state().evaluations[0].status, "discarded");
    assert.equal(f.state().issues[0].triage.dirty, true);
  } finally {
    f.close();
  }
});
test("Issue sessions are independent per binding and description changes preserve the session", () => {
  const f = fixture();
  try {
    const b2 = f.domain.action("binding.save", {
      issueId: f.issue.id,
      projectId: f.project.id,
      worktreeId: f.tree.id,
      agentId: "codex",
      description: "Frontend",
    }) as any;
    const x = f.runtime.session(f.binding.id, "pi", f.repo),
      y = f.runtime.session(b2.id, "codex", f.repo);
    assert.notEqual(x.id, y.id);
    assert.equal(f.state().issues[0].sessions.length, 2);
    assert.equal((f.state() as any).sessions, undefined);
    const b = find(f.state().bindings, f.binding.id);
    f.domain.action("binding.save", {
      ...b,
      description: "Changed instructions",
    });
    assert.equal(f.runtime.session(b.id, "pi", f.repo).id, x.id);
    const w2 = f.secondTree();
    f.domain.action("binding.save", {
      ...find(f.state().bindings, b.id),
      worktreeId: w2.id,
      description: "Other tree",
    });
    const newer = f.runtime.session(b.id, "pi", w2.path);
    assert.equal(newer.parentSessionId, x.id);
    assert.equal(newer.generation, 2);
    assert.equal(find(sessions(f.state()), x.id).status, "archived");
  } finally {
    f.close();
  }
});
test("Issue serialization and canonical directory lock protect different issues", () => {
  const f = fixture();
  try {
    const r = begin(f);
    assert.equal(f.runtime.begin(r.taskId!, f.binding.id, "spec"), undefined);
    const i2 = f.domain.action("issue.create", { title: "Other" }) as any,
      b2 = f.domain.action("binding.save", {
        issueId: i2.id,
        projectId: f.project.id,
        worktreeId: f.tree.id,
        agentId: "pi",
        description: "Other",
      }) as any;
    f.domain.action("issue.control", { issueId: i2.id, command: "start" });
    assert.throws(
      () =>
        f.runtime.begin(
          f.state().tasks.find((t) => t.issueId === i2.id)!.id,
          b2.id,
          "spec",
        ),
      code("WORKTREE_BUSY"),
    );
    finish(f, r);
    assert.ok(
      f.runtime.begin(
        f.state().tasks.find((t) => t.issueId === i2.id)!.id,
        b2.id,
        "spec",
      ),
    );
  } finally {
    f.close();
  }
});
test("Unknown never replays or releases directory until actual outcome is reconciled", async () => {
  const f = fixture();
  try {
    const r = begin(f);
    f.runtime.started(r.id, r.sessionId, "actual-turn");
    f.runtime.unknown(r.id, "Disconnected");
    model(f, (input) => typed(input));
    await settle(f.runtime);
    assert.equal(f.launched.length, 0);
    assert.ok(f.store.db.prepare("SELECT * FROM locks").get());
    assert.throws(
      () =>
        f.domain.action("issue.control", {
          issueId: f.issue.id,
          command: "resume",
        }),
      code("RESULT_UNKNOWN"),
    );
    f.domain.action("run.reconcile", {
      runId: r.id,
      outcome: "failed",
      evidence: "Checked native history: failed; no ongoing process.",
    });
    assert.equal(f.store.db.prepare("SELECT * FROM locks").get(), undefined);
    assert.equal(f.state().issues[0].sessions[0].status, "idle");
    assert.equal(f.state().requests[0].status, "Resolved");
  } finally {
    f.close();
  }
});
test("Stop is a correction, pauses after native terminal and rejects late reports", () => {
  const f = fixture();
  try {
    const r = begin(f);
    f.runtime.started(r.id, r.sessionId, "turn");
    f.domain.action("issue.control", {
      issueId: f.issue.id,
      command: "stop",
      text: "Use a different greeting.",
    });
    assert.equal(f.state().issues[0].control, "stopping");
    assert.equal(f.state().tasks.length, 1);
    assert.throws(
      () =>
        f.domain.report(
          r.id,
          { artifacts: [{ title: "Late", content: "old" }] },
          id(),
        ),
      code("STALE_VERSION"),
    );
    f.runtime.complete(r.id, false, "Partial work kept", "interrupted");
    assert.equal(f.state().issues[0].control, "paused");
    f.domain.action("issue.control", {
      issueId: f.issue.id,
      command: "resume",
    });
    assert.equal(f.state().issues[0].corrections[0].stopResolved, true);
    assert.equal(f.state().issues[0].control, "enabled");
  } finally {
    f.close();
  }
});
test("Context freezes approved pair and permissions; public state excludes prompts and keys", () => {
  const f = fixture();
  try {
    const v = f.approve(),
      r = begin(f, "implement"),
      context = f.runtime.runContext(r);
    assert.match(context, /implementationApproved/);
    assert.match(context, /Provide a greeting/);
    assert.ok(context.includes(v.id));
    f.store.change((s) =>
      saveDraft(s, {
        specId: f.tree.specId,
        document: "product",
        content: "Unapproved newer draft",
        draftRevision: find(s.specs, f.tree.specId).draft.revision,
      }),
    );
    assert.equal(f.runtime.runContext(r), context);
    assert.ok(!context.includes("Unapproved newer draft"));
    f.store.saveKey("private-key");
    const output = JSON.stringify(f.store.publicState());
    assert.ok(!output.includes("private-key"));
    assert.ok(!output.includes("contextSnapshots"));
    assert.ok(!output.includes("contextRef"));
  } finally {
    f.close();
  }
});
test("Reports use report-local material indices, dependencies and valid linked Agent answers", () => {
  const f = fixture();
  try {
    const r = begin(f);
    f.domain.report(
      r.id,
      { artifacts: [{ title: "Earlier", content: "old" }] },
      id(),
    );
    f.domain.report(
      r.id,
      {
        artifacts: [{ title: "Contract", content: "readable contract" }],
        requests: [
          {
            kind: "approval",
            title: "Review contract",
            artifactIndexes: [0],
            action: { type: "review", description: "Check contract" },
          },
        ],
      },
      id(),
    );
    const q = f.state().requests[0];
    assert.equal(find(f.state().artifacts, q.artifactIds[0]).title, "Contract");
    f.runtime.complete(r.id, true, "Waiting for contract review.", "");
    f.decide(q.id);
    const question = f.store.change((s) => {
      const q = makeRequest(s, {
        issueId: f.issue.id,
        kind: "input",
        recipient: "Agent",
        title: "Which greeting?",
      });
      task(s, f.issue.id, q.title, {
        kind: "clarification",
        requestId: q.id,
        sourceId: q.id,
      });
      return q;
    });
    const t = f.state().tasks.at(-1)!,
      answer = f.runtime.begin(t.id, f.binding.id, "clarify")!;
    f.domain.report(
      answer.id,
      { answer: { requestId: question.id, text: "Hello." } },
      id(),
    );
    assert.equal(find(f.state().requests, question.id).status, "Answered");
    assert.equal(find(f.state().tasks, t.id).status, "done");
  } finally {
    f.close();
  }
});
test("Required oversized context blocks dispatch explicitly instead of truncating the goal", () => {
  const f = fixture();
  try {
    f.store.change((s) =>
      artifact(s, {
        issueId: f.issue.id,
        title: "large",
        content: "X".repeat(300000),
      }),
    );
    assert.throws(() => begin(f), code("MATERIAL_UNREADABLE"));
    assert.equal(f.state().runs.length, 0);
  } finally {
    f.close();
  }
});
test("Restart marks active execution unknown and persists sessions and recovery request", () => {
  const f = fixture();
  try {
    const r = begin(f);
    f.runtime.started(r.id, r.sessionId, "native-turn");
    f.domain.recover();
    assert.equal(find(f.state().runs, r.id).status, "unknown");
    assert.equal(f.state().issues[0].sessions[0].status, "unknown");
    assert.equal(f.state().requests[0].inputClass, "recovery");
    assert.ok(f.store.db.prepare("SELECT * FROM locks").get());
  } finally {
    f.close();
  }
});
test("Jev rejects malformed successful payload without network retry", async () => {
  let calls = 0;
  await assert.rejects(
    evaluate(
      "test",
      {},
      { ready: { type: "noul", instructions: "test" } },
      async () => {
        calls++;
        return new Response("not json");
      },
    ),
    code("JEV_INVALID_RESPONSE"),
  );
  assert.equal(calls, 1);
});

test("Goal confidence below acceptance schedules Agent verification instead of premature completion", async () => {
  const f = fixture();
  try {
    f.approve();
    finish(f, begin(f, "implement"), "Initial tests passed.");
    model(f, (input) => typed(input, "final", "none", "human", 0.45));
    await settle(f.runtime);
    assert.equal(
      f.state().requests.filter((q) => q.kind === "final").length,
      0,
    );
    assert.equal(
      f.state().tasks.filter((t) => t.kind === "followup").length,
      1,
    );
    assert.equal(f.state().issues[0].triage.dirty, true);
    model(f, (input) => typed(input, "dispatch", "verify"));
    await settle(f.runtime);
    assert.equal(f.launched.at(-1)!.mode, "verify");
  } finally {
    f.close();
  }
});
test("Spec changes request routes a revision, supersedes old proposal and never authorizes rejected version", async () => {
  const f = fixture();
  try {
    const first = begin(f);
    const proposal = (r: any, revision: number, product: string) =>
      f.domain.report(
        r.id,
        {
          specProposal: {
            specId: f.tree.specId,
            baseVersionId: r.snapshot.specVersionId,
            draftRevision: revision,
            product,
            tech: "Test and implement",
            upgradeTargets: [
              {
                worktreeId: f.tree.id,
                fromVersionId: f.tree.specVersionId,
                worktreeRevision: 0,
              },
            ],
          },
        },
        id(),
      );
    proposal(first, 0, "First");
    finish(f, first);
    const old = f.state().requests[0];
    f.decide(old.id, "changes", "Clarify defaults.");
    model(f, (input) => typed(input, "dispatch", "revise"));
    await settle(f.runtime);
    const revision = f.launched.at(-1)!;
    assert.equal(revision.mode, "spec");
    proposal(revision, f.state().specs[0].draft.revision, "Revised");
    finish(f, revision);
    const newer = f.state().requests.at(-1)!;
    assert.equal(find(f.state().requests, old.id).status, "Superseded");
    assert.equal(find(f.state().requests, old.id).supersededById, newer.id);
    f.decide(newer.id);
    const w = find(f.state().worktrees, f.tree.id);
    assert.equal(
      approvalIds(f.state(), f.issue.id, w, "implement")[0],
      newer.id,
    );
  } finally {
    f.close();
  }
});
test("Pause preserves decisions and active work; notifications and tokens do not cause repeated Jev calls", async () => {
  const f = fixture();
  try {
    let calls = 0;
    model(f, (input) => {
      calls++;
      return typed(input);
    });
    f.start();
    await settle(f.runtime);
    const run = f.launched[0];
    f.domain.action("issue.control", { issueId: f.issue.id, command: "pause" });
    finish(f, run);
    await settle(f.runtime);
    assert.equal(calls, 1);
    f.domain.action("issue.control", {
      issueId: f.issue.id,
      command: "resume",
    });
    await settle(f.runtime);
    assert.equal(calls, 2);
    const second = f.launched[1];
    f.runtime.streams.write(second, "answer", "answer", "append", "token");
    await settle(f.runtime);
    assert.equal(calls, 2);
  } finally {
    f.close();
  }
});
test("Unknown or stale scope cannot be removed; ambiguous Agent aliases keep the request pending", () => {
  const f = fixture();
  try {
    const w = f.secondTree(),
      b = f.domain.action("binding.save", {
        issueId: f.issue.id,
        projectId: f.project.id,
        worktreeId: w.id,
        agentId: "pi",
        description: "Other scope",
      }) as any;
    const q = f.store.change((s) =>
      makeRequest(s, {
        issueId: f.issue.id,
        title: "Route",
        kind: "input",
        routeTask: true,
        options: [
          { value: f.binding.id, label: "Main" },
          { value: b.id, label: "Other" },
        ],
      }),
    );
    assert.throws(() => f.decide(q.id, "answer", "Pi"), code("INVALID_INPUT"));
    assert.equal(find(f.state().requests, q.id).status, "Pending");
    f.decide(q.id, "answer", b.id);
    const x = f.runtime.session(b.id, "pi", w.path);
    f.store.change((s) => (find(sessions(s), x.id).status = "unknown"));
    assert.throws(
      () =>
        f.domain.action("binding.remove", {
          bindingId: b.id,
          reason: "Remove",
        }),
      code("RESULT_UNKNOWN"),
    );
  } finally {
    f.close();
  }
});

test("Final acceptance does not ask a redundant clarification for low action confidence", async () => {
  const f = fixture();
  try {
    f.approve();
    finish(
      f,
      begin(f, "implement"),
      "Observed tests passed; all requirements covered.",
    );
    model(f, (input) => {
      const response = typed(input, "final", "none", "human", 0.65);
      response.answers.next_action.confidence = 0.2;
      return response;
    });
    await settle(f.runtime);
    assert.equal(
      f
        .state()
        .requests.filter((q) => q.kind === "final" && q.status === "Pending")
        .length,
      1,
    );
    assert.equal(
      f.state().requests.filter((q) => q.kind === "input").length,
      0,
    );
    assert.equal(f.state().issues[0].status, "Human input");
    const final = f.state().requests.find((q) => q.kind === "final")!;
    f.decide(final.id);
    assert.equal(f.state().issues[0].status, "Done");
  } finally {
    f.close();
  }
});

test("Rejected Jev distributions remain inspectable without being applied or replayed", async () => {
  const f = fixture();
  try {
    model(f, (input) => {
      const response = typed(input);
      response.answers.dispatch_mode.probabilities.spec = 0.4;
      return response;
    });
    f.start();
    await settle(f.runtime);
    const evaluation = f.state().evaluations[0];
    assert.equal(evaluation.status, "failed");
    assert.equal(evaluation.answer!.dispatch_mode.probabilities.spec, 0.4);
    assert.equal(f.launched.length, 0);
    await settle(f.runtime);
    assert.equal(f.state().evaluations.length, 1);
  } finally {
    f.close();
  }
});
test("Reopened goals do not require renewed authorization for unrelated historical execution", async () => {
  const f = fixture();
  try {
    f.approve();
    finish(f, begin(f, "implement"));
    model(f, (input) => typed(input, "final", "none", "human", 1));
    await settle(f.runtime);
    f.decide(f.state().requests.find((q) => q.kind === "final")!.id);
    f.domain.action("issue.control", {
      issueId: f.issue.id,
      command: "reopen",
      text: "Read existing results and provide a documentation summary only",
    });
    assert.doesNotThrow(() => finalReady(f.state(), f.issue.id));
  } finally {
    f.close();
  }
});
