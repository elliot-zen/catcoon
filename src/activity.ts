import type { Event, Request, Run, State } from "../server/types.ts";

type ActivityData = Pick<
  State,
  "events" | "runs" | "requests" | "artifacts" | "tasks"
>;
export type ActivityEntry =
  | { kind: "run"; id: string; run: Run; events: Event[] }
  | { kind: "request"; id: string; request: Request; events: Event[] }
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
    const details = e.data as { artifactId?: string } | undefined;
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
