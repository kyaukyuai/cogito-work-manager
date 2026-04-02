import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { createFollowupProposalTools } from "./followup-proposal-tools.js";
import { createSchedulerProposalTools } from "./scheduler-proposal-tools.js";
import { createWorkItemProposalTools } from "./work-item-proposal-tools.js";
import { createWorkspaceProposalTools } from "./workspace-proposal-tools.js";

export function createManagerProposalTools(): ToolDefinition[] {
  return [
    ...createWorkItemProposalTools(),
    ...createSchedulerProposalTools(),
    ...createWorkspaceProposalTools(),
    ...createFollowupProposalTools(),
  ];
}
