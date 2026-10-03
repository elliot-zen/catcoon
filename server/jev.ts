import { AppError, fail } from "./store.ts";
export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, unknown>;
}
export interface NoulQuestion {
  type: "noul";
  instructions: string;
}
export type Questions = Record<string, ChoiceQuestion | NoulQuestion>;
export function questionsFor(state: any): Questions {
  const route: Record<string, unknown> = {
    human: "Human decision or no matching scope",
  };
  for (const b of state.bindings)
    route[b.id] = {
      description: b.description,
      project: b.projectName,
      worktree: b.path,
      specVersionId: b.specVersionId,
      availability: b.availability,
    };
  const questions: Questions = {
    next_action: {
      type: "choice",
      instructions:
        "Choose one mutually exclusive next action. If an available binding can legally make progress on the clear goal, dispatch it. An empty or unapproved Spec is not a waiting condition: dispatch spec work. Use wait only for an actual external blocker listed in state, human only for unresolved business ambiguity or required Human decisions, and final only when constraints.canFinalize and verified goal coverage are both true. Empty queue or a successful run does not prove completion.",
      criteria: {
        dispatch:
          "There is clear legal Agent work and at least one dispatchable binding",
        wait: "A concrete external dependency or environment blocker prevents all legal Agent work",
        human:
          "No legal autonomous progress is possible without a specific Human clarification or decision",
        final:
          "All work is covered by actual verification; hard final prerequisites pass",
      },
    },
    dispatch_mode: {
      type: "choice",
      instructions:
        "Assuming Agent work is to be dispatched, classify its remaining deliverable independently of the other questions. Use nextWorkItem and actual completed stages, not already fulfilled instructions in the original goal. A published, adopted and Human-approved readable Spec satisfies the planning stage: use it to implement missing code instead of planning it again. Select spec only if the relevant pair is empty or must change. Each mode includes its own planning and repository reading. Implementation without approval is prohibited. Use none only if no Agent deliverable remains.",
      criteria: {
        spec: "A relevant full PRODUCT/TECH pair is still missing or requires specific changes",
        implement: "Build missing code against the approved fixed Spec",
        verify:
          "Validate already implemented code against the approved fixed Spec",
        clarify: "Answer the exact linked Agent request",
        revise:
          "Fix code in response to specific changes requested under valid approval",
        inspect:
          "Investigate an unclear existing result or recover uncertain facts; no known deliverable can yet be selected",
        none: "No Agent deliverable remains",
      },
    },
    route: {
      type: "choice",
      instructions:
        "Choose the exact binding by scope and instructions, not tool name. Select human when evidence is insufficient or ambiguous.",
      criteria: route,
    },
    goal_complete: {
      type: "noul",
      instructions:
        "Does the delivered behavior, system Spec and actually observed verification cover every requirement of the effective goal? Evaluate evidence, not workflow bookkeeping: a goal work item's pending status is normal until final acceptance, and irrelevant bindings or unassigned Spec versions need not execute. Observed successful test commands plus exact requirement coverage support completion; self-claims without observed verification, truncated material and obsolete approval are insufficient.",
    },
  };
  if (state.currentWorkItem)
    questions.work_item_complete = {
      type: "noul",
      instructions:
        "Is the exact state.currentWorkItem completed with inspectable evidence? Clarification requires a valid linked answer.",
    };
  return questions;
}
export function validateAnswers(questions: Questions, answers: any) {
  for (const [key, q] of Object.entries(questions)) {
    const a = answers?.[key];
    if (a?.type !== q.type)
      fail(503, "JEV_INVALID_RESPONSE", "Missing or mismatched answer: " + key);
    const finite = (v: any) =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
    if (q.type === "noul") {
      if (!finite(a.noul))
        fail(503, "JEV_INVALID_RESPONSE", "Invalid Noul: " + key);
      continue;
    }
    const keys = Object.keys(q.criteria),
      p = a.probabilities;
    if (
      !keys.includes(a.choice) ||
      !finite(a.confidence) ||
      !p ||
      Object.keys(p).length !== keys.length ||
      keys.some((k) => !finite(p[k])) ||
      Math.abs(keys.reduce((n, k) => n + p[k], 0) - 1) > 1e-6
    )
      fail(503, "JEV_INVALID_RESPONSE", "Invalid Choice: " + key);
  }
  return answers;
}
export async function evaluate(
  apiKey: string,
  state: any,
  questions: Questions,
  fetcher: typeof fetch = fetch,
) {
  if (!apiKey) fail(503, "JEV_UNAVAILABLE", "Save a Jev API key in Settings");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetcher("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "jev-latest", state, questions }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        if (
          (response.status === 429 || response.status >= 500) &&
          attempt < 2
        ) {
          const retry = Number(response.headers.get("Retry-After"));
          await new Promise((r) =>
            setTimeout(
              r,
              Math.min(15000, retry > 0 ? retry * 1000 : 500 * 2 ** attempt),
            ),
          );
          continue;
        }
        const detail = (await response.text()).slice(0, 1500);
        if (
          response.status === 400 &&
          /too.long|context|token|length/i.test(detail)
        )
          fail(400, "MATERIAL_UNREADABLE", "Jev input limit: " + detail);
        fail(
          503,
          "JEV_UNAVAILABLE",
          "Jev returned HTTP " + response.status + ": " + detail,
        );
      }
      let body: any;
      try {
        body = await response.json();
      } catch {
        fail(503, "JEV_INVALID_RESPONSE", "Jev returned invalid JSON");
      }
      try {
        return {
          answers: validateAnswers(questions, body.answers),
          model: body.model,
          usage: body.usage,
        };
      } catch (e) {
        if (e instanceof AppError)
          e.details = {
            rawAnswer: body.answers,
            model: body.model,
            usage: body.usage,
          };
        throw e;
      }
    } catch (e) {
      if (e instanceof AppError) throw e;
      if (attempt === 2)
        fail(503, "JEV_UNAVAILABLE", "Jev network request failed or timed out");
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw new Error("Unreachable");
}
