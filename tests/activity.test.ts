import { test } from "node:test";
import assert from "node:assert/strict";
import { groupActivity, stepContent } from "../src/activity.ts";
import type { Event, Run, Request } from "../server/types.ts";

type Data = Parameters<typeof groupActivity>[0];
const at = "2026-10-03T12:00:00.000Z";
const record = (
  id: string,
  type: string,
  extra: Partial<Event> = {},
): Event => ({
  id,
  issueId: "issue",
  source: "Codex",
  type,
  text: id,
  at,
  receivedAt: at,
  ...extra,
});
const run = (id: string, extra: Partial<Run> = {}): Run => ({
  id,
  issueId: "issue",
  taskId: "task",
  bindingId: "binding",
  snapshot: {
    id: "binding",
    issueId: "issue",
    projectId: "project",
    worktreeId: "tree",
    agentId: "codex",
    description: "Original instructions",
    revision: 0,
    removed: false,
    path: "/original",
    branch: "main",
    projectName: "Original project",
    agentName: "Codex",
    command: "codex",
  },
  context: "",
  status: "running",
  startedAt: at,
  ...extra,
});
const data = (): Data => ({
  runs: [],
  events: [],
  requests: [],
  artifacts: [],
  tasks: [],
});

test("one execution contains its replies, calls, artifacts and generated work; approval remains independently actionable", () => {
  const s = data();
  s.runs.push(run("run-1"));
  s.requests.push({
    id: "request",
    issueId: "issue",
    status: "Approved",
  } as Request);
  s.artifacts.push({
    id: "artifact",
    issueId: "issue",
    runId: "run-1",
  } as Data["artifacts"][number]);
  s.tasks.push({
    id: "next",
    issueId: "issue",
    sourceId: "run-1",
  } as Data["tasks"][number]);
  s.events = [
    record("human", "issue.start", { source: "Human" }),
    record("scheduled", "run.scheduled", { source: "Triage", runId: "run-1" }),
    record("reply-1", "step", { runId: "run-1" }),
    record("tool", "step", { runId: "run-1" }),
    record("created", "request.created", {
      runId: "run-1",
      requestId: "request",
    }),
    record("reply-2", "step", { runId: "run-1" }),
    record("artifact", "artifact.published", {
      data: { artifactId: "artifact" },
    }),
    record("next-work", "task.created", { taskId: "next" }),
    record("completed", "run.completed", { runId: "run-1" }),
    record("approved", "request.approve", {
      source: "Human",
      requestId: "request",
    }),
    record("handoff", "handoff", { runId: "run-1" }),
    record("foreign", "step", { issueId: "another", runId: "run-1" }),
  ];
  const before = structuredClone(s);
  const rows = groupActivity(s, "issue");
  assert.deepEqual(
    rows.map((r) => r.id),
    ["event:human", "run:run-1", "request:request"],
  );
  const execution = rows[1];
  assert.equal(execution.kind, "run");
  if (execution.kind !== "run") return;
  assert.equal(execution.run.snapshot.path, "/original");
  assert.deepEqual(
    execution.events.map((e) => e.id),
    [
      "scheduled",
      "reply-1",
      "tool",
      "reply-2",
      "artifact",
      "next-work",
      "completed",
      "handoff",
    ],
  );
  const request = rows[2];
  assert.equal(request.kind, "request");
  if (request.kind !== "request") return;
  assert.equal(request.request.status, "Approved");
  assert.deepEqual(
    request.events.map((e) => e.id),
    ["created", "approved"],
  );
  assert.deepEqual(s, before); // Grouping never rewrites persisted history or decisions.
});

test("same Codex/task across retries and bindings stays separate, and late/polled output keeps stable group keys and positions", () => {
  const s = data();
  s.runs = [
    run("first", { status: "failed" }),
    run("retry"),
    run("different-binding", { bindingId: "other" }),
  ];
  s.events = [
    record("first-start", "run.started", { runId: "first" }),
    record("retry-start", "run.started", { runId: "retry" }),
    record("other-start", "run.started", { runId: "different-binding" }),
    record("orphan", "step", { runId: "deleted-run" }),
    record("legacy", "step"),
  ];
  const keys = groupActivity(s, "issue").map((r) => r.id);
  s.events.push(
    record("late", "run.late", {
      runId: "first",
      at: "2026-10-03T11:00:00.000Z",
    }),
    record("new-reply", "step", { runId: "retry" }),
  );
  s.runs[1].status = "completed";
  const updated = groupActivity(s, "issue");
  assert.deepEqual(
    updated.map((r) => r.id),
    keys,
  );
  assert.equal(updated.filter((r) => r.kind === "run").length, 3);
  const first = updated[0],
    retry = updated[1];
  assert.ok(first.kind === "run" && retry.kind === "run");
  assert.deepEqual(
    first.events.map((e) => e.id),
    ["first-start", "late"],
  );
  assert.deepEqual(
    retry.events.map((e) => e.id),
    ["retry-start", "new-reply"],
  );
  assert.equal(retry.run.status, "completed");
});

test("native terminal grouping requires both session and turn IDs and preserves old unassociated records", () => {
  const s = data();
  const native = (sessionId: string, nativeTurnId: string) => ({
    sessionId,
    nativeTurnId,
  });
  s.events = [
    record("start", "session.running", { data: native("one", "turn-1") }),
    record("response", "step", { data: native("one", "turn-1") }),
    record("next-turn", "session.running", { data: native("one", "turn-2") }),
    record("other-session", "session.running", {
      data: native("two", "turn-1"),
    }),
    record("complete", "session.completed", { data: native("one", "turn-1") }),
    record("old", "step", {
      bindingId: "binding",
      data: { nativeTurnId: "turn-1" },
    }),
  ];
  const rows = groupActivity(s, "issue");
  assert.equal(rows.filter((r) => r.kind === "terminal").length, 3);
  assert.ok(rows[0].kind === "terminal");
  assert.deepEqual(
    rows[0].events.map((e) => e.id),
    ["start", "response", "complete"],
  );
  assert.equal(rows.at(-1)?.kind, "event");
});

test("public replies render as text while tool failures, malformed/truncated outputs and Pi errors remain inspectable", () => {
  const step = (value: unknown) =>
    record("step", "step", { data: { output: JSON.stringify(value) } });
  assert.deepEqual(
    stepContent(step({ type: "agentMessage", text: "Readable Codex reply" })),
    { answer: "Readable Codex reply" },
  );
  assert.deepEqual(
    stepContent(
      step({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "PRIVATE" },
            { type: "text", text: "Pi reply" },
          ],
        },
      }),
    ),
    { answer: "Pi reply", output: undefined },
  );
  const failed = step({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Provider rejected prompt",
    },
  });
  assert.match(stepContent(failed).output!, /Provider rejected prompt/);
  const tool = step({
    type: "commandExecution",
    command: "npm test",
    exitCode: 1,
    aggregatedOutput: "actual failure",
  });
  assert.match(stepContent(tool).output!, /actual failure/);
  const truncated = record("truncated", "step", {
    data: {
      output: '{"type":"commandExecution"\n[Truncated: event exceeds 64KB]',
    },
  });
  assert.match(stepContent(truncated).output!, /Truncated/);
  assert.deepEqual(stepContent(record("legacy", "output")), {});
});
