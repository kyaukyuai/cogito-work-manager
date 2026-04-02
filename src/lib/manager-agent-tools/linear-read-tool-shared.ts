import type { AppConfig } from "../config.js";
import type { LinearCommandEnv } from "../linear.js";
import type { DuplicateRecallPlannerExecutor } from "../linear-duplicate-resolution.js";

export interface ManagerAgentToolHelpers {
  runDuplicateRecallTurn?: DuplicateRecallPlannerExecutor;
}

export function buildLinearEnv(config: AppConfig): LinearCommandEnv {
  return {
    ...process.env,
    LINEAR_API_KEY: config.linearApiKey,
    LINEAR_WORKSPACE: config.linearWorkspace,
    LINEAR_TEAM_KEY: config.linearTeamKey,
  };
}

export function formatJsonDetails(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
