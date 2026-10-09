import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Jev, routeState } from "../server/jev.js";
import type { Activity, Detail, HumanRequest } from "../server/types.js";
const detail = {
  title: "Goal",
  description: "Implement and review",
  bindings: [
    { id: "codex", name: "Codex", role: "Implement" },
    { id: "pi", name: "Pi", role: "Review" },
  ],
  turns: [
    {
      id: "turn",
      bindingId: "codex",
      status: "completed",
      output: "Implemented",
      startedAt: "2026-10-09T06:00:00.000Z",
      endedAt: "2026-10-09T06:01:00.000Z",
    },
  ],
  requests: [],
  activities: [],
} as unknown as Detail;

const humanRequest = (
  createdAt: string,
  answer: string,
  status: HumanRequest["status"] = "answered",
): HumanRequest => ({
  id: answer,
  issueId: "issue",
  turnId: null,
  kind: "input",
  title: "Next step?",
  detail: "Review",
  options: [],
  status,
  answer: status === "pending" ? null : answer,
  native: null,
  createdAt,
});
const activity = (type: string, createdAt: string): Activity => ({
  id: type,
  issueId: "issue",
  actor: "System",
  type,
  summary: "",
  detail: "",
  createdAt,
});

test("routing history keeps the latest agent and only a subsequent answered human turn", () => {
  assert.deepEqual(routeState({ ...detail, turns: [] }).history, []);
  const oldHuman = humanRequest("2026-10-09T05:59:00.000Z", "Old feedback");
  const human = humanRequest("2026-10-09T06:02:00.000Z", "Ask Pi to review");
  const agentEntry = {
    status: "completed",
    type: "agent",
    agent_id: "codex",
    agent_name: "Codex",
    answer: "Implemented",
  };
  const humanEntry = {
    status: "answered",
    type: "human",
    agent_id: null,
    agent_name: "Human",
    answer: "Ask Pi to review",
  };
  assert.deepEqual(routeState({ ...detail, requests: [oldHuman] }).history, [
    agentEntry,
  ]);
  assert.deepEqual(
    routeState({ ...detail, requests: [oldHuman, human] }).history,
    [agentEntry, humanEntry],
  );
  assert.deepEqual(
    routeState({ ...detail, turns: [], requests: [human] }).history,
    [humanEntry],
  );
  assert.deepEqual(
    routeState({
      ...detail,
      requests: [humanRequest(human.createdAt, "Not answered", "pending")],
    }).history,
    [agentEntry],
  );
  // Once another Agent finishes, previous human answers no longer belong to history.
  assert.deepEqual(
    routeState({
      ...detail,
      requests: [human],
      turns: [
        ...detail.turns,
        {
          ...detail.turns[0],
          id: "review",
          bindingId: "pi",
          output: "Reviewed",
          startedAt: "2026-10-09T06:03:00.000Z",
          endedAt: "2026-10-09T06:04:00.000Z",
        },
      ],
    }).history,
    [
      {
        status: "completed",
        type: "agent",
        agent_id: "pi",
        agent_name: "Pi",
        answer: "Reviewed",
      },
    ],
  );
});

test("routing history uses human answer time and activity order for same-timestamp decisions", () => {
  const endedAt = detail.turns[0].endedAt!;
  const human = {
    ...humanRequest(
      "2026-10-09T06:00:30.000Z",
      "Use another approach",
      "rejected",
    ),
    turnId: "turn",
    kind: "approval" as const,
  };
  // A recovered request can be answered after the Agent ends, despite being created earlier.
  assert.equal(
    routeState({
      ...detail,
      requests: [human],
      activities: [activity("human_decision", "2026-10-09T06:02:00.000Z")],
    }).history.length,
    2,
  );
  const answered = activity("human_decision", endedAt);
  const completed = activity("turn_completed", endedAt);
  assert.equal(
    routeState({
      ...detail,
      requests: [human],
      activities: [answered, completed],
    }).history.length,
    2,
  );
  assert.equal(
    routeState({
      ...detail,
      requests: [human],
      activities: [completed, answered],
    }).history.length,
    1,
  );
});
test("Jev uses documented Choice payload and selects only provided binding IDs", async () => {
  const calls: any[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push(JSON.parse(body));
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          answers: {
            decision: {
              choice: "pi",
              confidence: 0.9,
            },
          },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const address = server.address() as any;
    const j = new Jev("test", `http://127.0.0.1:${address.port}`);
    const decision = await j.route(
      {
        ...detail,
        turns: [
          { ...detail.turns[0], bindingId: "pi", output: "Earlier review" },
          ...detail.turns,
        ],
      },
      new AbortController().signal,
    );
    assert.equal(decision.action, "agent");
    assert.equal((decision as any).bindingId, "pi");
    assert.equal(calls[0].questions.decision.type, "choice");
    assert.deepEqual(calls[0].state, {
      goal: { title: "Goal", description: "Implement and review" },
      history: [
        {
          status: "completed",
          type: "agent",
          agent_id: "codex",
          agent_name: "Codex",
          answer: "Implemented",
        },
      ],
    });
    assert.deepEqual(Object.keys(calls[0].questions.decision.criteria), [
      "codex",
      "pi",
      "human",
      "done",
    ]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].questions.decision.criteria.pi, "Pi: Review");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("missing Jev key fails explicitly", async () => {
  await assert.rejects(
    new Jev("").route(detail, new AbortController().signal),
    /TYPESAFE_API_KEY/,
  );
});

test("Jev logs correlated requests, raw responses and failures without exposing the API key", async (t) => {
  const key = "jev-test-secret";
  const logs: string[] = [];
  const errors: string[] = [];
  t.mock.method(console, "log", (line: string) => logs.push(line));
  t.mock.method(console, "error", (line: string) => errors.push(line));
  let mode: "ok" | "http" | "json" | "network" = "ok";
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    if (mode === "network") {
      req.socket.destroy();
      return;
    }
    res.statusCode = mode === "http" ? 502 : 200;
    res.end(
      mode === "ok"
        ? JSON.stringify({
            answers: { decision: { choice: "pi", confidence: 0.9 } },
          })
        : mode === "http"
          ? `upstream error: ${key}`
          : "not JSON",
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const jev = new Jev(key, endpoint);
    const route = () => jev.route(detail, new AbortController().signal);
    await route();
    mode = "http";
    await assert.rejects(route(), /502/);
    mode = "json";
    await assert.rejects(route(), SyntaxError);
    mode = "network";
    await assert.rejects(route(), /fetch failed/);

    const entries = logs.map((line) => ({
      event: line.slice(0, line.indexOf("{")),
      ...JSON.parse(line.slice(line.indexOf("{"))),
    }));
    const requests = entries.filter((entry) => entry.event.includes("request"));
    const responses = entries.filter((entry) =>
      entry.event.includes("response"),
    );
    assert.equal(requests.length, 4);
    assert.equal(new Set(requests.map((r) => r.requestId)).size, 4);
    assert.equal(requests[0].url, endpoint);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].body.state.goal.title, "Goal");
    assert.equal(requests[0].body.questions.decision.criteria.pi, "Pi: Review");
    assert.equal(responses.length, 3);
    for (let i = 0; i < responses.length; i++) {
      assert.equal(responses[i].requestId, requests[i].requestId);
      assert.ok(responses[i].durationMs >= 0);
      assert.ok(responses[i].timestamp);
    }
    assert.equal(responses[1].status, 502);
    assert.equal(responses[1].body, "upstream error: [REDACTED]");
    assert.equal(responses[2].body, "not JSON");
    assert.equal(errors.length, 3);
    errors.forEach((line, i) => {
      const error = JSON.parse(line.slice(line.indexOf("{")));
      assert.equal(error.requestId, requests[i + 1].requestId);
      assert.ok(error.message);
    });
    const printed = [...logs, ...errors].join("\n");
    assert.ok(!printed.includes(key));
    assert.ok(!printed.includes("Bearer "));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("unified routing handles human, done, low confidence and rejects unknown choices", async () => {
  let choice = "human";
  let confidence = 0.9;
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ answers: { decision: { choice, confidence } } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const j = new Jev(
      "test",
      `http://127.0.0.1:${(server.address() as any).port}`,
    );
    const route = () => j.route(detail, new AbortController().signal);
    assert.equal((await route()).action, "human");
    choice = "done";
    assert.equal((await route()).action, "done");
    choice = "pi";
    confidence = 0;
    assert.equal((await route()).action, "human");
    confidence = 0.9;
    for (const unknown of ["agent", "unbound", "toString"]) {
      choice = unknown;
      await assert.rejects(route(), /unknown option/);
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
