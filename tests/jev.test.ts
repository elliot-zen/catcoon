import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Jev } from "../server/jev.js";
import type { Detail } from "../server/types.js";
const detail = {
  title: "Goal",
  description: "Implement and review",
  bindings: [
    { id: "codex", name: "Codex", role: "Implement" },
    { id: "pi", name: "Pi", role: "Review" },
  ],
  turns: [{ bindingId: "codex", status: "completed", output: "Implemented" }],
  requests: [],
} as unknown as Detail;
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
    const decision = await j.route(detail, new AbortController().signal);
    assert.equal(decision.action, "agent");
    assert.equal((decision as any).bindingId, "pi");
    assert.equal(calls[0].questions.decision.type, "choice");
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

test("unified routing handles human, done, low confidence and rejects unknown choices", async () => {
  let choice = "human";
  let confidence = 0.9;
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ answers: { decision: { choice, confidence } } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const j = new Jev("test", `http://127.0.0.1:${(server.address() as any).port}`);
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
