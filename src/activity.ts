import type { Event, Request, Run, State } from "../server/types.ts";

type ActivityData = Pick<
  State,
  "events" | "runs" | "requests" | "artifacts" | "tasks"
>;
export type ActivityEntry =
  | { kind: "run"; id: string; run: Run; events: Event[] }
  | { kind: "request"; id: string; request: Request; events: Event[] }
  | {
      kind: "terminal";
      id: string;
      sessionId: string;
      turnId: string;
      events: Event[];
    }
  | { kind: "event"; id: string; event: Event };

export function groupActivity(
  data: ActivityData,
  issueId: string,
): ActivityEntry[] {
  const runs = new Map(
    data.runs.filter((r) => r.issueId === issueId).map((r) => [r.id, r]),
  );
  const requests = new Map(
    data.requests.filter((r) => r.issueId === issueId).map((r) => [r.id, r]),
  );
  const artifacts = new Map(
    data.artifacts.filter((a) => a.issueId === issueId).map((a) => [a.id, a]),
  );
  const tasks = new Map(
    data.tasks.filter((t) => t.issueId === issueId).map((t) => [t.id, t]),
  );
  const entries: ActivityEntry[] = [];
  const groups = new Map<string, Exclude<ActivityEntry, { kind: "event" }>>();
  for (const e of data.events) {
    if (e.issueId !== issueId) continue;
    const details = e.data as
      | { artifactId?: string; sessionId?: string; nativeTurnId?: string }
      | undefined;
    const request = requests.get(e.requestId || "");
    const run =
      runs.get(e.runId || "") ||
      runs.get(artifacts.get(details?.artifactId || "")?.runId || "") ||
      (e.type === "task.created"
        ? runs.get(tasks.get(e.taskId || "")?.sourceId || "")
        : undefined);
    let group: Exclude<ActivityEntry, { kind: "event" }> | undefined;
    if (request) {
      group = {
        kind: "request",
        id: "request:" + request.id,
        request,
        events: [],
      };
    } else if (run) {
      group = { kind: "run", id: "run:" + run.id, run, events: [] };
    } else if (
      typeof details?.sessionId === "string" &&
      typeof details?.nativeTurnId === "string"
    ) {
      group = {
        kind: "terminal",
        id:
          "terminal:" +
          JSON.stringify([details.sessionId, details.nativeTurnId]),
        sessionId: details.sessionId,
        turnId: details.nativeTurnId,
        events: [],
      };
    }
    if (!group) {
      entries.push({ kind: "event", id: "event:" + e.id, event: e });
      continue;
    }
    const existing = groups.get(group.id);
    if (existing) existing.events.push(e);
    else {
      group.events.push(e);
      groups.set(group.id, group);
      entries.push(group);
    }
  }
  return entries;
}

// Present public assistant text without losing malformed, failed or truncated tool records.
export function stepContent(e: Event): { answer?: string; output?: string } {
  const data = e.data as { output?: unknown } | undefined;
  if (e.type !== "step" || typeof data?.output !== "string") return {};
  try {
    const item = JSON.parse(data.output);
    if (item.type === "agentMessage" && typeof item.text === "string")
      return { answer: item.text };
    if (
      item.message?.role === "assistant" &&
      Array.isArray(item.message.content)
    ) {
      const answer = item.message.content
        .filter((b: any) => b.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text)
        .join("\n");
      return {
        answer,
        output:
          item.message.errorMessage || item.message.stopReason === "error"
            ? data.output
            : undefined,
      };
    }
  } catch {
    /* Truncated or legacy outputs remain visible verbatim. */
  }
  return { output: data.output };
}
