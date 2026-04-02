import { Type } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { listLinearTeamMembers, type LinearCommandEnv } from "../linear.js";
import { formatJsonDetails } from "./linear-read-tool-shared.js";

export function createLinearTeamReadTools(env: LinearCommandEnv): ToolDefinition[] {
  return [
    {
      name: "linear_list_team_members",
      label: "Linear List Team Members",
      description: "List active team members to reason about assignees.",
      promptSnippet: "Use this when proposing assignment or checking who owns a task.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, signal) {
        const members = await listLinearTeamMembers(env, signal);
        return {
          content: [{ type: "text", text: members.length > 0 ? formatJsonDetails(members) : "No active team members found." }],
          details: members,
        };
      },
    },
  ];
}
