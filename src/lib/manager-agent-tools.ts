import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AppConfig } from "./config.js";
import type { ManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import { createWorkgraphReadTools } from "./workgraph-tools.js";
import { createManagerInternalTools } from "./manager-agent-tools/internal-tools.js";
import {
  createLinearReadTools,
  type ManagerAgentToolHelpers,
} from "./manager-agent-tools/linear-read-tools.js";
import { createNotionReadTools } from "./manager-agent-tools/notion-read-tools.js";
import { createManagerProposalTools } from "./manager-agent-tools/proposal-tools.js";
import { createSchedulerReadTools } from "./manager-agent-tools/scheduler-read-tools.js";
import { createWorkspaceReadTools } from "./manager-agent-tools/workspace-read-tools.js";
import {
  createSlackAttachmentTools,
  createSlackContextTools,
} from "./manager-agent-tools/slack-read-tools.js";
import { createWebReadTools } from "./manager-agent-tools/web-read-tools.js";

export function createManagerAgentTools(
  config: AppConfig,
  repositories: Pick<ManagerRepositories, "policy" | "workgraph" | "ownerMap">,
  helpers?: ManagerAgentToolHelpers,
): ToolDefinition[] {
  return [
    ...createManagerInternalTools(),
    ...createLinearReadTools(config, helpers),
    ...createSchedulerReadTools(config, repositories),
    ...createWorkspaceReadTools(config, repositories),
    ...createNotionReadTools(config),
    ...createSlackContextTools(config),
    ...createSlackAttachmentTools(config),
    ...createWorkgraphReadTools(repositories),
    ...createWebReadTools(),
    ...createManagerProposalTools(),
  ];
}
