import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureManagerStateFiles } from "../src/lib/manager-state.js";
import { buildSystemPaths } from "../src/lib/system-workspace.js";
import { createFileBackedManagerRepositories } from "../src/state/repositories/file-backed-manager-repositories.js";

export const baseManagerCommandCommitConfig = {
  slackAppToken: "xapp-test",
  slackBotToken: "xoxb-test",
  slackAllowedChannelIds: new Set(["C0ALAMDRB9V"]),
  anthropicApiKey: undefined,
  linearApiKey: "lin_api_test",
  linearWorkspace: "kyaukyuai",
  linearTeamKey: "AIC",
  notionApiToken: undefined,
  notionAgendaParentPageId: undefined,
  botModel: "claude-sonnet-4-5",
  botThinkingLevel: "minimal",
  botMaxOutputTokens: undefined,
  botRetryMaxRetries: 1,
  workspaceDir: "",
  linearWebhookEnabled: false,
  linearWebhookPublicUrl: undefined,
  linearWebhookSecret: undefined,
  linearWebhookPort: 8787,
  linearWebhookPath: "/hooks/linear",
  heartbeatIntervalMin: 30,
  heartbeatActiveLookbackHours: 24,
  schedulerPollSec: 30,
  workgraphMaintenanceIntervalMin: 15,
  workgraphHealthWarnActiveEvents: 200,
  workgraphAutoCompactMaxActiveEvents: 500,
  logLevel: "info" as const,
};

export interface ManagerCommandCommitTestContext {
  workspaceDir: string;
  repositories: ReturnType<typeof createFileBackedManagerRepositories>;
  config: typeof baseManagerCommandCommitConfig;
}

export async function createManagerCommandCommitTestContext(): Promise<ManagerCommandCommitTestContext> {
  const workspaceDir = await mkdtemp(join(tmpdir(), "manager-command-commit-"));
  await ensureManagerStateFiles(buildSystemPaths(workspaceDir));
  const repositories = createFileBackedManagerRepositories(buildSystemPaths(workspaceDir));
  return {
    workspaceDir,
    repositories,
    config: { ...baseManagerCommandCommitConfig, workspaceDir },
  };
}

export async function cleanupManagerCommandCommitTestContext(workspaceDir: string): Promise<void> {
  await rm(workspaceDir, { recursive: true, force: true });
}

export function buildLinearTestEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LINEAR_API_KEY: "lin_api_test",
    LINEAR_WORKSPACE: "kyaukyuai",
    LINEAR_TEAM_KEY: "AIC",
  };
}
