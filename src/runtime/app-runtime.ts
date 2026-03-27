import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebClient } from "@slack/web-api";
import { HeartbeatService, type HeartbeatExecutionResult } from "../lib/heartbeat.js";
import type { Logger } from "../lib/logger.js";
import type { AppConfig } from "../lib/config.js";
import type { SchedulerExecutionResult } from "../lib/scheduler.js";
import {
  type SchedulerJob,
  type SystemPaths,
} from "../lib/system-workspace.js";
import type { ManagerPolicy } from "../state/manager-state-contract.js";
import type { ManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import { createJstClock, ThreadQueue } from "./app-runtime-shared.js";
import { createSchedulerHeartbeatHandler } from "./scheduler-heartbeat-handler.js";
import { createSlackMessageHandler } from "./slack-message-handler.js";
import { createSystemTaskExecutor } from "./system-task-executor.js";
import { createWebhookRequestHandler } from "./webhook-request-handler.js";

export interface AppRuntimeHandlers {
  handleSlackMessageEvent: (event: unknown, botUserId: string, heartbeatService?: HeartbeatService) => Promise<void>;
  handleWebhookRequest: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  executeHeartbeat: (args: { channelId: string; prompt: string }) => Promise<HeartbeatExecutionResult>;
  executeScheduledJob: (args: { job: SchedulerJob }) => Promise<SchedulerExecutionResult>;
}

export function createAppRuntimeHandlers(args: {
  config: AppConfig;
  logger: Logger;
  webClient: WebClient;
  systemPaths: SystemPaths;
  managerRepositories: ManagerRepositories;
  linearEnv: Record<string, string | undefined>;
  slackTeamId?: string;
  getManagerPolicy: () => ManagerPolicy;
  setManagerPolicy: (policy: ManagerPolicy) => void;
}): AppRuntimeHandlers {
  const clock = createJstClock();
  const messageQueue = new ThreadQueue();
  const webhookQueue = new ThreadQueue();

  const systemTaskExecutor = createSystemTaskExecutor({
    config: args.config,
    logger: args.logger,
    webClient: args.webClient,
    systemPaths: args.systemPaths,
    managerRepositories: args.managerRepositories,
    linearEnv: args.linearEnv,
    getManagerPolicy: args.getManagerPolicy,
    clock,
  });

  const slackMessageHandler = createSlackMessageHandler({
    config: args.config,
    logger: args.logger,
    webClient: args.webClient,
    systemPaths: args.systemPaths,
    managerRepositories: args.managerRepositories,
    slackTeamId: args.slackTeamId,
    setManagerPolicy: args.setManagerPolicy,
    messageQueue,
    systemTaskExecutor,
  });

  const webhookRequestHandler = createWebhookRequestHandler({
    config: args.config,
    logger: args.logger,
    webClient: args.webClient,
    managerRepositories: args.managerRepositories,
    linearEnv: args.linearEnv,
    webhookQueue,
    clock,
    systemTaskExecutor,
  });

  const schedulerHeartbeatHandler = createSchedulerHeartbeatHandler({
    config: args.config,
    webClient: args.webClient,
    clock,
    systemTaskExecutor,
  });

  return {
    handleSlackMessageEvent: slackMessageHandler.handleSlackMessageEvent,
    handleWebhookRequest: webhookRequestHandler.handleWebhookRequest,
    executeHeartbeat: schedulerHeartbeatHandler.executeHeartbeat,
    executeScheduledJob: schedulerHeartbeatHandler.executeScheduledJob,
  };
}
