import { z } from "zod";
import type { Decision, Detail } from "./types.js";
const answerSchema = z.object({
  choice: z.string(),
  confidence: z.number().min(0).max(1),
});
export function routeState(d: Detail) {
  return {
    goal: { title: d.title, description: d.description },
    agents: d.bindings.map((b) => ({ id: b.id, name: b.name, role: b.role })),
    results: d.turns.map((t) => ({
      agent: t.bindingId,
      status: t.status,
      result: t.output,
    })),
    humanDecisions: d.requests.map((r) => ({
      kind: r.kind,
      question: r.title,
      detail: r.detail,
      status: r.status,
      answer: r.answer,
    })),
  };
}
export class Jev {
  constructor(
    private key = process.env.TYPESAFE_API_KEY,
    private endpoint = process.env.JEV_URL ||
      "https://api.typesafe.ai/v1/systemone",
  ) {}
  async choose(
    state: unknown,
    instructions: string,
    criteria: Record<string, string>,
    signal: AbortSignal,
  ) {
    if (!this.key)
      throw new Error("Set TYPESAFE_API_KEY in .env to enable Jev routing.");
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.JEV_MODEL || "jev-latest",
        state: JSON.stringify(state),
        questions: { decision: { type: "choice", instructions, criteria } },
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
    });
    if (!response.ok)
      throw new Error(
        `Jev request failed (${response.status}). Check configuration and service availability.`,
      );
    const body = (await response.json()) as any;
    const answer = answerSchema.parse(body.answers?.decision);
    if (!(answer.choice in criteria))
      throw new Error("Jev selected an unknown option.");
    return answer;
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
      "Choose the next step for this issue. A completed agent turn is not proof that the whole goal is met. Respect human rejections and all binding responsibilities. Choose done only when results demonstrate the entire goal is satisfied; choose human when a user decision or clarification is necessary.",
      {
        agent: "More work can be performed by a bound agent.",
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
    const selected = await this.choose(
      state,
      "Select the bound agent whose role best matches the next unfinished work. Consider previous results and human feedback; do not repeat already completed work.",
      Object.fromEntries(d.bindings.map((b) => [b.id, `${b.name}: ${b.role}`])),
      signal,
    );
    if (selected.confidence < Number(process.env.JEV_MIN_CONFIDENCE || 0.65))
      return {
        action: "human",
        detail:
          "No agent could be selected confidently. Clarify the next task or update the bindings after stopping.",
      };
    return {
      action: "agent",
      bindingId: selected.choice,
      detail:
        "Continue the unfinished work within your binding responsibilities using the issue goal, prior results, and human decisions below.",
    };
  }
}
