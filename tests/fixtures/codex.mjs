#!/usr/bin/env node
let buffer = "",
  policy = "";
const emit = (m) => process.stdout.write(JSON.stringify(m) + "\n");
process.stdin.on("data", (c) => {
  buffer += c;
  let n;
  while ((n = buffer.indexOf("\n")) >= 0) {
    const m = JSON.parse(buffer.slice(0, n));
    buffer = buffer.slice(n + 1);
    if (m.method === "initialize") emit({ id: m.id, result: {} });
    else if (m.method === "thread/start" || m.method === "thread/resume") {
      if (
        m.params.approvalsReviewer !== "user" ||
        !["workspace-write", "read-only"].includes(m.params.sandbox)
      )
        process.exit(2);
      policy = m.params.approvalPolicy;
      emit({
        method: "item/completed",
        params: {
          item: {
            type: "commandExecution",
            configuration: m.params,
            processCwd: process.cwd(),
          },
        },
      });
      emit({ id: m.id, result: { thread: { id: "test-thread" } } });
    } else if (m.method === "turn/start") {
      emit({ id: m.id, result: { turn: { id: "test-turn" } } });
      emit({
        method: "item/agentMessage/delta",
        params: { delta: "Plan ready\u2028Unicode preserved." },
      });
      if (policy === "never") {
        emit({
          method: "turn/completed",
          params: { turn: { status: "completed" } },
        });
      } else
        emit({
          id: "approve",
          method: "item/commandExecution/requestApproval",
          params: {
            turnId: "test-turn",
            threadId: "test-thread",
            reason: "Run verification",
            command: "npm test",
          },
        });
    } else if (m.id === "approve" && m.result) {
      emit({
        method: "item/completed",
        params: {
          item: {
            type: "commandExecution",
            command: "npm test",
            status: m.result.decision === "accept" ? "completed" : "declined",
          },
        },
      });
      emit({
        method: "turn/completed",
        params: { turn: { status: "completed" } },
      });
    } else if (m.method === "turn/interrupt") {
      emit({ id: m.id, result: {} });
      emit({
        method: "turn/completed",
        params: { turn: { status: "interrupted" } },
      });
    }
  }
});
