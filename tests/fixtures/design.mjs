const stamp = (hm) =>
  `${new Date().toISOString().slice(0, 10)}T${hm}:00${new Date().getTimezoneOffset() === 0 ? "Z" : "+08:00"}`;
const binding = (id, name, role) => ({
  id,
  issueId: "AGT-128",
  name,
  runtime: name === "Pi" ? "pi" : "codex",
  approvalLevel: name === "Pi" ? "strict" : "on-request",
  role,
  cwd: "/tmp",
  model: "",
  sessionId: name === "Codex" ? "codex-agt128-01" : null,
});
export const bindings = [
  binding("codex", "Codex", "Write Spec and backend logic."),
  binding("pi", "Pi", "Import API design into Apifox."),
  binding("kimi", "Kimi", "Write frontend code."),
];
const descriptions = [
  ["AGT-128", "Build the Issue workspace", "running", "Codex"],
  ["AGT-127", "Add project and worktree binding", "running", "Kimi"],
  ["AGT-126", "Review agent routing rules", "waiting_human", null],
  ["AGT-125", "Connect the agent runtime", "running", "Codex"],
  ["AGT-124", "Add activity timeline filters", "ready", null],
  ["AGT-123", "Handle approvals inside Issue", "ready", null],
  ["AGT-122", "Set up workspace navigation", "done", null],
  ["AGT-121", "Restore Issue sessions", "done", null],
];
export const rows = descriptions.map(
  ([id, title, status, runningAgent], i) => ({
    id,
    title,
    status,
    runningAgent,
    bindings,
    generation: 1,
    description: "",
    currentTurnId: i === 0 ? "turn-4" : null,
    stopReason: null,
    createdAt: stamp("14:32"),
    updatedAt: new Date(
      Date.now() - [0, 2, 12, 18, 60, 120, 1500, 1500][i] * 60000,
    ).toISOString(),
    completedAt: null,
  }),
);
const output = {
  decision: "dispatch",
  checklistItemId: "backend",
  bindingId: "codex-backend",
  sessionId: "codex-agt128-01",
  resumeSession: true,
  instruction: "Spec v1.1 is approved. Codex handles the backend work.",
  reason: "Approved Spec is available and the Codex binding matches the task.",
  checklistUpdates: [{ id: "backend", status: "in_progress" }],
  waitingFor: null,
};
const input = {
  issueId: "AGT-128",
  trigger: { type: "human.approved", eventId: "event-2" },
  checklist: [
    { id: "spec", status: "done" },
    { id: "backend", status: "pending" },
    { id: "api", status: "pending" },
    { id: "frontend", status: "pending" },
  ],
};
const events = [
  [
    "Codex",
    "Started backend implementation",
    "Write backend logic · Turn 04 · Existing session resumed.",
    "14:54",
  ],
  [
    "Jev",
    "Assigned backend implementation to Codex",
    JSON.stringify({
      input,
      output,
      detail: "Spec v1.1 is approved. Codex handles the backend work.",
    }),
    "14:52",
  ],
  [
    "Elliot",
    "Approved Spec v1.1",
    "Approval approval-spec-v1.1 · Backend implementation is now allowed.",
    "14:51",
  ],
  [
    "Jev",
    "Waiting for human approval",
    JSON.stringify({
      input,
      output: {
        action: "human",
        detail: "Spec review blocks implementation. No Agent was dispatched.",
      },
    }),
    "14:49",
  ],
  [
    "Codex",
    "Requested approval for Spec v1.1",
    "Review PRODUCT.md and TECH.md before implementation.",
    "14:49",
  ],
  [
    "Codex",
    "Published Spec and completed checklist item",
    "Write spec → Done · PRODUCT.md@v1.1 · TECH.md@v1.1",
    "14:48",
  ],
  [
    "Codex",
    "Finished the Spec turn",
    "Answer: Spec is ready; backend and frontend have not started.",
    "14:47",
  ],
  [
    "Jev",
    "Assigned write spec to Codex",
    JSON.stringify({
      input,
      output: {
        detail: "First ready checklist item matched the Codex binding.",
      },
    }),
    "14:35",
  ],
  [
    "Elliot",
    "Bound Codex, Kimi and Pi",
    "Binding responsibilities saved.",
    "14:34",
  ],
  ["Elliot", "Created Issue and checklist", "Issue created.", "14:32"],
];
export const detail = {
  ...rows[0],
  createdBy: "Elliot",
  description:
    "Create a shared workspace for coordinating agents around Issues. Start with an Issue list and a detail view that keeps the task, active agent, and activity in one place.",
  bindings,
  turns: [
    ...["pi", "kimi"].map((bindingId, i) => ({
      id: `turn-${i + 1}`,
      bindingId,
      issueId: "AGT-128",
      generation: 1,
      status: "completed",
      input: "",
      output: "",
      startedAt: stamp("14:35"),
      endedAt: stamp("14:36"),
    })),
    {
      id: "turn-3",
      bindingId: "codex",
      issueId: "AGT-128",
      generation: 1,
      status: "completed",
      input: "Task: Write Spec\n\nPrevious turns:",
      output: "Spec is ready.",
      startedAt: stamp("14:48"),
      endedAt: new Date(Date.parse(stamp("14:48")) + 7000).toISOString(),
    },
    {
      id: "turn-4",
      bindingId: "codex",
      issueId: "AGT-128",
      generation: 1,
      status: "running",
      task: "Write backend logic",
      input:
        "Task: Implement backend logic using approved Spec v1.1. Continue in this session and report results against the checklist.\n\nPrevious turns:",
      output: "",
      startedAt: new Date(Date.now() - 7000).toISOString(),
      endedAt: null,
    },
  ],
  requests: [],
  activities: events.map(([actor, summary, content, hm], i) => ({
    id: i === 1 ? "jv-002" : `event-${i}`,
    issueId: "AGT-128",
    actor,
    summary,
    detail: content,
    type: actor === "Jev" ? "human.approved" : "activity",
    createdAt: stamp(hm),
  })),
  messages: [
    {
      id: 1,
      turnId: "turn-4",
      kind: "assistant_delta",
      text: "I’ve reviewed the approved Spec and existing routes. I’m implementing the backend routes, validation and error responses.",
      createdAt: stamp("14:54"),
    },
    ...[
      "Read Spec · PRODUCT.md + TECH.md",
      "Inspect backend · 8 files",
      "Edit routes and validation · 3 files",
    ].map((command, i) => ({
      id: i + 2,
      turnId: "turn-4",
      kind: "tool",
      text: JSON.stringify({
        command,
        status: i === 2 ? "Running" : "Completed",
      }),
      createdAt: stamp("14:54"),
    })),
  ],
};
