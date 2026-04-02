import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
  managerCommandProposalSchema,
  type ManagerCommandProposal,
} from "../manager-command-commit.js";

export function createProposalTool(args: {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  parameters: ToolDefinition["parameters"];
  commandType: ManagerCommandProposal["commandType"];
}): ToolDefinition {
  return {
    name: args.name,
    label: args.label,
    description: args.description,
    promptSnippet: args.promptSnippet,
    parameters: args.parameters,
    async execute(_toolCallId, params) {
      const proposal = managerCommandProposalSchema.parse({
        commandType: args.commandType,
        ...(params as Record<string, unknown>),
      });
      return {
        content: [{ type: "text", text: "Command proposal recorded." }],
        details: { proposal },
      };
    },
  };
}
