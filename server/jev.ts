import { z } from "zod";
import { randomUUID } from "node:crypto";
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
      state: JSON.stringify(state),
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
      "Choose the next step for this issue. A completed agent turn is not proof that the whole goal is met. Respect human rejections and all binding responsibilities. Choose a bound agent ID directly when its role matches unfinished work; consider previous results and human feedback and do not repeat completed work. Choose done only when results demonstrate the entire goal is satisfied; choose human when a user decision or clarification is necessary.",
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
