import { AppError, fail } from "./store.ts";
export async function evaluate(
  apiKey: string,
  state: unknown,
  criteria: Record<string, unknown>,
  onAttempt: (attempt: number, status: string) => void = () => {},
  fetcher: typeof fetch = fetch,
) {
  if (!apiKey) fail(503, "JEV_UNAVAILABLE", "Save a Jev API key in Settings");
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      onAttempt(attempt, "started");
      const response = await fetcher("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "jev-latest",
          state,
          questions: {
            route: {
              type: "choice",
              instructions:
                "Which single binding description is appropriate for this task? Select human if requirements conflict, material is insufficient, no description matches, or an explicit Human decision is necessary. Descriptions do not grant permission. Select based on scope, not tool name.",
              criteria,
            },
          },
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        onAttempt(attempt, `HTTP ${response.status}`);
        if (
          (response.status === 429 ||
            response.status === 529 ||
            response.status >= 500) &&
          attempt < 3
        ) {
          await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
          continue;
        }
        fail(503, "JEV_UNAVAILABLE", `Jev returned HTTP ${response.status}`);
      }
      const body = await response.json();
      const a = body?.answers?.route;
      if (
        a?.type !== "choice" ||
        typeof a.choice !== "string" ||
        !(a.choice in criteria) ||
        typeof a.confidence !== "number" ||
        !Number.isFinite(a.confidence) ||
        a.confidence < 0 ||
        a.confidence > 1 ||
        !a.probabilities
      )
        fail(503, "JEV_UNAVAILABLE", "Jev returned an invalid typed answer");
      onAttempt(attempt, "completed");
      return {
        choice: a.choice,
        confidence: a.confidence,
        probabilities: a.probabilities,
        model: body.model,
      };
    } catch (e) {
      if (e instanceof AppError) throw e;
      onAttempt(attempt, "network / timeout");
      if (attempt === 3)
        fail(503, "JEV_UNAVAILABLE", "Jev connection failed or timed out");
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    }
  }
  return fail(503, "JEV_UNAVAILABLE", "Jev unavailable");
}
