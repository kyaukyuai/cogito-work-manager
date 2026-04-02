import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AppConfig } from "./config.js";
import type { ManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import { buildSystemPaths } from "./system-workspace.js";
import { createFileBackedManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import { createLinearContextCustomTools } from "./linear-tools/context-custom-tools.js";
import { createLinearIssueCustomTools } from "./linear-tools/issue-custom-tools.js";
import { buildLinearEnv } from "./linear-tools/shared.js";

export function createLinearCustomTools(
  config: AppConfig,
  managerRepositories = createFileBackedManagerRepositories(buildSystemPaths(config.workspaceDir)),
): ToolDefinition[] {
  const env = buildLinearEnv(config);

  return [
    ...createLinearIssueCustomTools(env, managerRepositories),
    ...createLinearContextCustomTools(config),
  ];
}
