export type Status =
  | "waiting_binding"
  | "ready"
  | "routing"
  | "running"
  | "waiting_human"
  | "stopping"
  | "stopped"
  | "done";
export type Runtime = "codex" | "pi";
export type ApprovalLevel = "strict" | "on-request" | "automatic";
export interface Issue {
  id: string;
  title: string;
  description: string;
  status: Status;
  generation: number;
  currentTurnId: string | null;
  stopReason: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}
export interface Binding {
  id: string;
  issueId: string;
  name: string;
  runtime: Runtime;
  approvalLevel: ApprovalLevel;
  role: string;
  cwd: string;
  model: string;
  sessionId: string | null;
}
export interface Turn {
  id: string;
  issueId: string;
  bindingId: string;
  generation: number;
  status:
    "running" | "waiting_approval" | "completed" | "interrupted" | "failed";
  input: string;
  output: string;
  startedAt: string;
  endedAt: string | null;
}
export interface HumanRequest {
  id: string;
  issueId: string;
  turnId: string | null;
  kind: "approval" | "input";
  title: string;
  detail: string;
  options: string[];
  status: "pending" | "approved" | "rejected" | "answered";
  answer: string | null;
  native: Record<string, any> | null;
  createdAt: string;
}
export interface Activity {
  id: string;
  issueId: string;
  actor: string;
  type: string;
  summary: string;
  detail: string;
  createdAt: string;
}
export interface Message {
  id: number;
  turnId: string;
  kind: string;
  text: string;
  createdAt: string;
}
export interface Detail extends Issue {
  bindings: Binding[];
  turns: Turn[];
  requests: HumanRequest[];
  activities: Activity[];
  messages: Message[];
}
export type Decision =
  | { action: "agent"; bindingId: string; detail: string }
  | { action: "human"; detail: string }
  | { action: "done"; detail: string };
export interface RuntimeCallbacks {
  spawned: (pid: number) => void;
  message: (kind: string, text: string) => void;
  session: (id: string) => void;
  request: (
    request: Pick<
      HumanRequest,
      "kind" | "title" | "detail" | "options" | "native"
    >,
  ) => void;
  complete: (output: string) => void;
  error: (error: Error) => void;
  closed: () => void;
}
export interface RuntimeHandle {
  send: (message: string) => Promise<void>;
  stop: () => Promise<void>;
  respond: (request: HumanRequest, answer: string, approved: boolean) => void;
  dispose: () => void;
}
