import type { ApprovalLevel, Runtime } from "./types.js";

export const approvalLevels = ["strict", "on-request", "automatic"] as const;
export const approvalLabels: Record<ApprovalLevel, string> = {
  strict: "Strict approval",
  "on-request": "On-request approval",
  automatic: "Fully automatic",
};
export const defaultApprovalLevel = (runtime: Runtime): ApprovalLevel =>
  runtime === "pi" ? "strict" : "on-request";

export const approvalDescriptions: Record<
  Runtime,
  Record<ApprovalLevel, string>
> = {
  codex: {
    strict:
      "Use a read-only sandbox. Ask before operations that require additional permissions, including file changes.",
    "on-request":
      "Allow workspace changes and routine commands. Ask when Codex needs additional permissions.",
    automatic:
      "Run enabled tools without manual approval or automatic review, with full filesystem and network access. Host and organization restrictions still apply.",
  },
  pi: {
    strict:
      "Ask before every shell command, file change, and other non-read-only tool. Read-only tools run immediately.",
    "on-request":
      "Allow workspace file changes and simple read commands (pwd, ls, cat, head, tail, wc). Ask before other operations.",
    automatic:
      "Run tools without manual approval or automatic review, using the permissions of the Pi process. Host restrictions still apply.",
  },
};

export function codexApprovalSettings(level: ApprovalLevel) {
  return {
    approvalPolicy: level === "automatic" ? "never" : "on-request",
    approvalsReviewer: "user",
    sandbox:
      level === "automatic"
        ? "danger-full-access"
        : level === "strict"
          ? "read-only"
          : "workspace-write",
  };
}
