import { randomUUID } from "node:crypto";
try {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 1024 * 1024)
      throw new Error("Bridge input exceeds 1MB");
  }
  const body = JSON.parse(raw);
  if (
    !["relay_spec_read", "relay_report"].includes(body.tool) ||
    typeof body.callId !== "string"
  )
    throw new Error("Supply tool, args and stable callId");
  if (
    !process.env.RELAY_RUN_ID ||
    !process.env.RELAY_RUN_TOKEN ||
    !process.env.RELAY_API_URL
  )
    throw new Error("Current Run credentials are required");
  const response = await fetch(
    process.env.RELAY_API_URL +
      "/api/runs/" +
      process.env.RELAY_RUN_ID +
      "/tool",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
        Authorization: "Bearer " + process.env.RELAY_RUN_TOKEN,
      },
      body: JSON.stringify(body),
    },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error?.message || "Relay rejected this operation");
  console.log(JSON.stringify(result));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
