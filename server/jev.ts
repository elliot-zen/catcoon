import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Decision, Detail, HumanRequest, Turn } from "./types.js";
const answerSchema = z.object({
  choice: z.string(),
  confidence: z.number().min(0).max(1),
});
interface HistoryEntry {
  status: Turn["status"] | HumanRequest["status"];
  type: "human" | "agent";
  agent_id: string | null;
  agent_name: string;
  answer: string;
}
export function routeState(d: Detail) {
  const history: HistoryEntry[] = [];
  const turn = d.turns.at(-1);
  if (turn) {
    const agent = d.bindings.find((b) => b.id === turn.bindingId);
    history.push({
      status: turn.status,
      type: "agent",
      agent_id: turn.bindingId,
      agent_name: agent?.name ?? turn.bindingId,
      answer: turn.output,
    });
  }
  const human = d.requests.findLast((r) => r.status !== "pending");
  if (human) {
    // Requests are timestamped when asked; the activity records when answered.
    const activities = d.activities ?? [];
    const answeredAt =
      activities.find((a) => a.type === "human_decision")?.createdAt ??
      human.createdAt;
    const agentAt = turn?.endedAt ?? turn?.startedAt ?? "";
    // Activities are newest first; use their order when timestamps are equal.
    const latestActor = activities.find(
      (a) => a.type === "human_decision" || a.type === "turn_completed",
    )?.type;
    if (
      !turn ||
      answeredAt > agentAt ||
      (answeredAt === agentAt &&
        (latestActor
          ? latestActor === "human_decision"
          : human.turnId !== turn.id))
    ) {
      history.push({
        status: human.status,
        type: "human",
        agent_id: null,
        agent_name: "Human",
        answer: human.answer ?? "",
      });
    }
  }
  return { goal: { title: d.title, description: d.description }, history };
}
export class Jev {
  constructor(
    private key = process.env.TYPESAFE_API_KEY,
    private endpoint = process.env.JEV_URL ||
      "https://api.typesafe.ai/v1/systemone",
  ) {}
  async choose(
    state: ReturnType<typeof routeState>,
    instructions: string,
    criteria: Record<string, string>,
    signal: AbortSignal,
  ) {
    if (!this.key)
      throw new Error("Set TYPESAFE_API_KEY in .env to enable Jev routing.");
    const requestId = randomUUID();
    const started = performance.now();
    const log = (
      event: string,
      data: Record<string, unknown>,
      failed = false,
    ) => {
      const entry = JSON.stringify({
        timestamp: new Date().toISOString(),
        requestId,
        ...data,
      });
      // Do not log Authorization; also redact a key echoed in a response/error.
      const redacted = entry.replaceAll(
        JSON.stringify(this.key).slice(1, -1),
        "[REDACTED]",
      );
      (failed ? console.error : console.log)(`[Jev ${event}] ${redacted}`);
    };
    const payload = {
      model: process.env.JEV_MODEL || "jev-latest",
      state,
      questions: { decision: { type: "choice", instructions, criteria } },
    };
    log("request", { method: "POST", url: this.endpoint, body: payload });
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
      });
      const rawBody = await response.text();
      log("response", {
        status: response.status,
        statusText: response.statusText,
        durationMs: Math.round(performance.now() - started),
        body: rawBody,
      });
      if (!response.ok)
        throw new Error(
          `Jev request failed (${response.status}). Check configuration and service availability.`,
        );
      const body = JSON.parse(rawBody);
      const answer = answerSchema.parse(body.answers?.decision);
      if (!Object.hasOwn(criteria, answer.choice))
        throw new Error("Jev selected an unknown option.");
      return answer;
    } catch (error) {
      log(
        "error",
        {
          durationMs: Math.round(performance.now() - started),
          message: error instanceof Error ? error.message : String(error),
          cause:
            error instanceof Error && error.cause instanceof Error
              ? error.cause.message
              : undefined,
        },
        true,
      );
      throw error;
    }
  }
  async route(d: Detail, signal: AbortSignal): Promise<Decision> {
    const state = routeState(d);
    const lastHumanInput = d.requests
      .filter((r) => r.kind === "input" && r.status === "answered")
      .at(-1);
    const recentTurns = lastHumanInput
      ? d.turns.filter((t) => t.startedAt > lastHumanInput.createdAt)
      : d.turns;
    if (recentTurns.length >= Number(process.env.MAX_TURNS || 20))
      return {
        action: "human",
        detail:
          "The automatic turn limit was reached. Review the results and clarify the remaining work.",
      };
    const outputs = recentTurns
      .filter((t) => t.status === "completed")
      .slice(-3)
      .map((t) => t.output.trim());
    if (outputs.length === 3 && outputs.every((o) => o === outputs[0]))
      return {
        action: "human",
        detail:
          "The last three turns returned the same result. Clarify the remaining work before continuing.",
      };
    const next = await this.choose(
      state,
      "Choose the next step using goal and history. History contains only the latest agent turn, followed by the latest human answer if the human acted afterward. The bound agents and their responsibilities are listed in criteria. Respect human rejections and follow the latest human answer. Choose a bound agent ID when its role matches unfinished work; do not repeat completed work. A completed agent turn alone does not prove the whole goal is met. Choose done only when the available evidence demonstrates the entire goal is satisfied, including required review; choose human when a user decision or clarification is necessary.",
      {
        ...Object.fromEntries(
          d.bindings.map((b) => [b.id, `${b.name}: ${b.role}`]),
        ),
        human: "Human judgment, approval, or missing information is required.",
        done: "All goals have been demonstrably completed, including any required review.",
      },
      signal,
    );
    if (next.confidence < Number(process.env.JEV_MIN_CONFIDENCE || 0.65))
      return {
        action: "human",
        detail:
          "Jev could not confidently determine the next step. Review the latest result and clarify how to proceed.",
      };
    if (next.choice === "human")
      return {
        action: "human",
        detail:
          d.turns.at(-1)?.output ||
          "Clarify the goal or which agent should proceed.",
      };
    if (next.choice === "done")
      return { action: "done", detail: d.turns.at(-1)?.output || "" };
    return {
      action: "agent",
      bindingId: next.choice,
      detail:
        "Continue the unfinished work within your binding responsibilities using the issue goal, prior results, and human decisions below.",
    };
  }
}
