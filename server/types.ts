export type Status = "Todo" | "In progress" | "Human input" | "Done";
export type Mode =
  | "spec"
  | "implement"
  | "verify"
  | "clarify"
  | "revise"
  | "inspect";
export interface Issue {
  id: string;
  number: string;
  title: string;
  description: string;
  status: Status;
  createdAt: string;
  updatedAt: string;
  started: boolean;
  control: "enabled" | "paused" | "stopping";
  revision: number;
  targetRevision: number;
  runBudgetStart: number;
  priority: number;
  labels: string[];
  corrections: {
    id: string;
    text: string;
    at: string;
    source: string;
    targetRevision: number;
    stopResolved: boolean;
  }[];
  sessions: Session[];
  triage: {
    dirty: boolean;
    evaluationRevision: number;
    phase: "idle" | "evaluating" | "running" | "waiting";
    triggerIds: string[];
    waitingKey?: string;
  };
  finalApprovalId?: string;
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
export interface Spec {
  id: string;
  projectId: string;
  name: string;
  draft: {
    product: string;
    tech: string;
    revision: number;
    baseVersionId: string;
  };
  latestVersionId: string;
  createdAt: string;
  updatedAt: string;
}
export interface SpecVersion {
  id: string;
  specId: string;
  number: number;
  product: string;
  tech: string;
  contentHash: string;
  createdAt: string;
  sourceIssueId?: string;
  sourceRunId?: string;
  previousVersionId?: string;
}
export interface Worktree {
  id: string;
  projectId: string;
  name: string;
  branch: string;
  path: string;
  specId: string;
  specVersionId: string;
  revision: number;
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
  activeSessionId?: string;
}
export interface WaitReason {
  code: string;
  requestIds: string[];
  runIds: string[];
  conditionKey?: string;
  message: string;
  recoverable: boolean;
}
export interface Task {
  id: string;
  issueId: string;
  kind: "goal" | "clarification" | "revision" | "followup";
  text: string;
  status: "pending" | "running" | "waiting" | "done" | "cancelled" | "unknown";
  bindingId?: string;
  dependencyIds: string[];
  sourceId?: string;
  requestId?: string;
  attempts: number;
  createdAt: string;
  waitReason?: WaitReason;
}
export interface Snapshot extends Binding {
  path: string;
  branch: string;
  projectName: string;
  agentName: string;
  command: string;
  targetRevision: number;
  worktreeRevision: number;
  specId: string;
  specVersionId: string;
  contentHash: string;
  approvalIds: string[];
}
export interface Run {
  id: string;
  issueId: string;
  origin: "platform" | "terminal";
  taskId?: string;
  bindingId: string;
  snapshot: Snapshot;
  contextRef?: string;
  mode?: Mode;
  status:
    | "starting"
    | "running"
    | "stopping"
    | "completed"
    | "failed"
    | "stopped"
    | "unknown";
  pid?: number;
  sessionId: string;
  nativeTurnId?: string;
  stopRequested: boolean;
  startedAt: string;
  finishedAt?: string;
  result?: string;
  reason?: string;
  ingestedAt?: string;
  resultArtifactId?: string;
  progressHash?: string;
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
  specVersionId?: string;
  provenance: string;
}
export type Scope =
  | "issue"
  | { taskIds: string[]; bindingIds: string[]; worktreeIds: string[] };
export type UpgradeTarget = {
  worktreeId: string;
  fromVersionId: string;
  worktreeRevision: number;
};
export type ApprovalAction =
  | {
      type: "approve_spec";
      specVersionId: string;
      worktreeIds: string[];
      allowedModes: Mode[];
    }
  | {
      type: "approve_spec_and_upgrade";
      specVersionId: string;
      targets: UpgradeTarget[];
      allowedModes: Mode[];
    }
  | {
      type: "final";
      targetRevision: number;
      artifactHashes: Record<string, string>;
      pins: Record<string, string>;
    }
  | { type: "native"; method: string }
  | { type: "review"; description: string };
export interface Request {
  id: string;
  issueId: string;
  taskId?: string;
  runId?: string;
  kind: "input" | "approval" | "final";
  inputClass?: "business" | "configuration" | "recovery" | "native";
  conditionKey?: string;
  title: string;
  body: string;
  options?: { value: string; label: string }[];
  artifactIds: string[];
  scope: Scope;
  action?: ApprovalAction;
  targetRevision: number;
  status:
    | "Pending"
    | "Answered"
    | "Approved"
    | "Changes requested"
    | "Resolved"
    | "Resolved externally"
    | "Superseded"
    | "Cancelled";
  answer?: string;
  decision?: string;
  decidedBy?: string;
  decidedAt?: string;
  revision: number;
  source: string;
  recipient: "Human" | "Agent";
  routeTask?: boolean;
  supersedesId?: string;
  supersededById?: string;
  resolutionEvidence?: string;
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
  projectId: string;
  worktreeId: string;
  path: string;
  generation: number;
  parentSessionId?: string;
  threadId?: string;
  nativeSessionId?: string;
  sessionFile?: string;
  endpoint?: string;
  toolVersion: string;
  busyTurnId?: string;
  status: "uninitialized" | "idle" | "busy" | "unknown" | "archived";
  createdAt: string;
}
export interface Evaluation {
  id: string;
  issueId: string;
  triggerIds: string[];
  evaluationRevision: number;
  snapshotHash: string;
  input: any;
  answer?: any;
  model?: string;
  usage?: unknown;
  status: "evaluating" | "applied" | "discarded" | "failed";
  createdAt: string;
  reason?: string;
}
export interface StreamItem {
  runId: string;
  itemKey: string;
  kind: "answer" | "thinking" | "tool";
  status: string;
  content: string;
  metadata: Record<string, any>;
  firstSeq: number;
  lastSeq: number;
}
export interface State {
  schemaVersion: number;
  revision: number;
  nextIssue: number;
  labelCatalog: { name: string; color: string }[];
  issues: Issue[];
  projects: Project[];
  worktrees: Worktree[];
  specs: Spec[];
  specVersions: SpecVersion[];
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
  evaluations: Evaluation[];
  contextSnapshots: {
    id: string;
    runId: string;
    payload: string;
    contentHash: string;
    createdAt: string;
  }[];
  settings: { configured: boolean; testedAt: string; connection: string };
}
export const activeRun = (r: Run) =>
  ["starting", "running", "stopping", "unknown"].includes(r.status);
export const sessions = (s: State) => s.issues.flatMap((i) => i.sessions);
