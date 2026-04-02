import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AppConfig } from "../config.js";
import { createLinearDuplicateReadTools } from "./linear-duplicate-read-tools.js";
import { createLinearIssueReadTools } from "./linear-issue-read-tools.js";
import { createLinearProjectReadTools } from "./linear-project-read-tools.js";
import { buildLinearEnv, type ManagerAgentToolHelpers } from "./linear-read-tool-shared.js";
import { createLinearTeamReadTools } from "./linear-team-read-tools.js";

export type { ManagerAgentToolHelpers } from "./linear-read-tool-shared.js";

export function createLinearReadTools(
  config: AppConfig,
  helpers?: ManagerAgentToolHelpers,
): ToolDefinition[] {
  const env = buildLinearEnv(config);

  return [
    ...createLinearIssueReadTools(env),
    ...createLinearProjectReadTools(env),
    ...createLinearDuplicateReadTools(env, helpers),
    ...createLinearTeamReadTools(env),
  ];
}
