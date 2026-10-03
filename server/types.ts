export type Status = "Todo" | "In progress" | "Human input" | "Done";
export interface Issue {
  id: string;
  number: string;
  title: string;
  description: string;
  status: Status;
  createdAt: string;
  updatedAt: string;
  started: boolean;
  paused: boolean;
  revision: number;
  runBudgetStart?: number;
  priority?: number;
  labels?: string[];
}
export interface Project {
  id: string;
  name: string;
  path: string;
  commonDir: string;
  health: string;
  healthReason: string;
  checkedAt: string;
}
export interface Worktree {
  id: string;
  projectId: string;
  name: string;
  branch: string;
  path: string;
  specName: string;
  specDir: string;
}
export interface Agent {
  id: string;
  name: string;
  command: string;
  version: string;
  status: string;
  heartbeat: string;
  reason: string;
}
export interface Binding {
  id: string;
  issueId: string;
  projectId: string;
  worktreeId: string;
  agentId: string;
  description: string;
  revision: number;
  removed: boolean;
}
export interface Task {
  id: string;
  issueId: string;
  text: string;
  status: "pending" | "running" | "waiting" | "done" | "cancelled" | "unknown";
  bindingId?: string;
  dependencyIds: string[];
  sourceId?: string;
  requestId?: string;
  attempts: number;
  createdAt: string;
  reason?: string;
  retryAt?: number;
}
export interface Snapshot extends Binding {
  path: string;
  branch: string;
  projectName: string;
  agentName: string;
  command: string;
}
export interface Run {
  id: string;
  issueId: string;
  taskId: string;
  bindingId: string;
  snapshot: Snapshot;
  context: string;
  status: string;
  pid?: number;
  sessionId?: string;
  nativeTurnId?: string;
  stopRequested?: boolean;
  startedAt: string;
  finishedAt?: string;
  result?: string;
  reason?: string;
}
export interface Event {
  id: string;
  issueId: string;
  source: string;
  type: string;
  text: string;
  at: string;
  receivedAt: string;
  runId?: string;
  taskId?: string;
  bindingId?: string;
  requestId?: string;
  data?: unknown;
}
export interface Artifact {
  id: string;
  issueId: string;
  runId?: string;
  bindingId?: string;
  worktreeId?: string;
  kind: string;
  title: string;
  content: string;
  version: string;
  createdAt: string;
  supersedesId?: string;
}
export interface Request {
  id: string;
  issueId: string;
  taskId?: string;
  kind: "input" | "approval" | "final";
  title: string;
  body: string;
  options?: { value: string; label: string }[];
  artifactIds: string[];
  scope: "issue" | string[];
  action: string;
  status: string;
  answer?: string;
  decision?: string;
  decidedBy?: string;
  decidedAt?: string;
  revision: number;
  source: string;
  recipient?: "Human" | "Agent";
  routeTask?: boolean;
  supersedesId?: string;
  supersededById?: string;
  native?: {
    sessionId: string;
    rpcId: string | number;
    method: string;
    params: any;
    delivery?: string;
  };
}
export interface Notification {
  id: string;
  requestId: string;
  issueId: string;
  category: string;
  read: boolean;
  archived: boolean;
  createdAt: string;
}
export interface Comment {
  id: string;
  issueId: string;
  text: string;
  createdAt: string;
}
export interface Attachment {
  id: string;
  issueId: string;
  name: string;
  mime: string;
  content: string;
  createdAt: string;
}
export interface Session {
  id: string;
  bindingId: string;
  agentId: string;
  path: string;
  threadId?: string;
  sessionFile?: string;
  endpoint?: string;
  version: string;
  busyTurnId?: string;
  status: string;
  createdAt: string;
}
export interface State {
  schemaVersion: number;
  sessions: Session[];
  labelCatalog: { name: string; color: string }[];
  revision: number;
  nextIssue: number;
  issues: Issue[];
  projects: Project[];
  worktrees: Worktree[];
  agents: Agent[];
  bindings: Binding[];
  tasks: Task[];
  runs: Run[];
  events: Event[];
  requests: Request[];
  notifications: Notification[];
  artifacts: Artifact[];
  comments: Comment[];
  attachments: Attachment[];
  settings: { configured: boolean; testedAt: string; connection: string };
}
export const activeRun = (r: Run) =>
  ["starting", "running", "stopping", "unknown"].includes(r.status);
