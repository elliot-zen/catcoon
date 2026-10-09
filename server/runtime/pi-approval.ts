// Loaded explicitly by Pi. RPC's confirm dialog pauses the tool before execution.
import { approvalLevels } from "../approval.js";
import type { ApprovalLevel } from "../types.js";
import { piNeedsApproval } from "./pi-policy.js";

export default function (pi: any) {
  const configured = process.env.CATCOON_APPROVAL_LEVEL;
  const level: ApprovalLevel = approvalLevels.includes(
    configured as ApprovalLevel,
  )
    ? (configured as ApprovalLevel)
    : "strict";
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (!piNeedsApproval(level, event, ctx.cwd)) return;
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
