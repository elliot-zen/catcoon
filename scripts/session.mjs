import { spawn } from "node:child_process";
const bindingId = process.argv[2];
const url =
  process.env.RELAY_URL || `http://127.0.0.1:${process.env.API_PORT || 4310}`;
try {
  const response = await fetch(url + "/api/state");
  if (!response.ok) throw new Error("Relay API unavailable");
  const state = await response.json();
  if (!bindingId) {
    console.log(
      state.sessions
        .map(
          (s) =>
            `${s.bindingId}\t${s.agentId}\t${s.threadId || s.sessionFile || "not started"}`,
        )
        .join("\n"),
    );
    process.exit(0);
  }
  const binding = state.bindings.find((b) => b.id === bindingId && !b.removed);
  const worktree = state.worktrees.find((w) => w.id === binding?.worktreeId);
  const session = state.sessions.find(
    (s) =>
      s.bindingId === bindingId &&
      s.agentId === binding?.agentId &&
      s.path === worktree?.path,
  );
  if (!session)
    throw new Error(
      "No native session for this binding; start its first run in Relay.",
    );
  let args;
  if (session.agentId === "codex") {
    if (!session.threadId || !session.endpoint)
      throw new Error("Codex thread not started");
    args = ["resume", "--remote", session.endpoint, session.threadId];
  } else {
    if (
      session.busyTurnId ||
      session.status === "running" ||
      session.status === "unknown"
    )
      throw new Error(
        "Pi RPC is active or unknown; stop and verify it before opening its session file",
      );
    args = ["--session", session.sessionFile];
  }
  const child = spawn(session.agentId, args, {
    stdio: "inherit",
    cwd: session.path,
  });
  child.once("error", (e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
