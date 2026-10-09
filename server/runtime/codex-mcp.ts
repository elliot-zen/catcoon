import { z } from "zod";

type Elicitation = Record<string, any>;
const isForm = (params: Elicitation) =>
  ["form", "openai/form", "openaiForm"].includes(params.mode);

// Only simple consent forms are approvals. Other forms need actual user input.
function consentContent(
  params: Elicitation,
): Record<string, boolean> | undefined {
  if (!isForm(params)) return;
  const schema = params.requestedSchema;
  if (!schema || schema.type !== "object") return;
  const fields = Object.entries(schema.properties || {});
  let content: Record<string, boolean>;
  if (!fields.length) content = {};
  else if (
    fields.length === 1 &&
    ["confirmed", "approved", "approve", "allow"].includes(fields[0][0]) &&
    (fields[0][1] as any)?.type === "boolean"
  )
    content = { [fields[0][0]]: true };
  else return;
  try {
    if (z.fromJSONSchema(schema).safeParse(content).success) return content;
  } catch {
    /* Unsupported schemas must be answered by the user. */
  }
}

export function mcpElicitationKind(params: Elicitation) {
  if (params.mode === "url") return "approval" as const;
  if (isForm(params))
    return consentContent(params) ? ("approval" as const) : ("input" as const);
  return null;
}

export function codexMcpResponse(
  params: Elicitation,
  answer: string,
  approved: boolean,
) {
  const kind = mcpElicitationKind(params);
  if (!kind)
    throw new Error(`Unsupported MCP elicitation mode: ${params.mode}`);
  if (kind === "approval") {
    if (!approved) return { action: "decline", content: null };
    return {
      action: "accept",
      content: params.mode === "url" ? null : consentContent(params)!,
    };
  }
  let content: unknown;
  try {
    content = JSON.parse(answer);
  } catch {
    throw new Error("Enter the MCP form answer as a JSON object.");
  }
  let schema;
  try {
    schema = z.fromJSONSchema(params.requestedSchema);
  } catch {
    throw new Error(
      "This MCP form schema is not supported. Stop the issue and complete the request in the tool's own interface.",
    );
  }
  const result = schema.safeParse(content);
  if (!result.success)
    throw new Error(
      `Invalid MCP form answer: ${result.error.issues.map((i) => `${i.path.join(".") || "answer"}: ${i.message}`).join("; ")}`,
    );
  return { action: "accept", content };
}
