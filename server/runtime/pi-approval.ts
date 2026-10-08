// Loaded explicitly by Pi. RPC's confirm dialog pauses the tool before execution.
export default function (pi: any) {
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (!["bash", "write", "edit"].includes(event.toolName)) return;
    const approved = await ctx.ui.confirm(
      `Approve ${event.toolName}`,
      JSON.stringify(event.input, null, 2),
    );
    if (!approved)
      return {
        block: true,
        reason:
          "Human did not approve this operation. Do not execute it; revise the plan or ask for clarification.",
      };
  });
}
