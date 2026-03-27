import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebClient } from "@slack/web-api";
import type { Logger } from "../lib/logger.js";
import { getLinearIssue } from "../lib/linear.js";
import { buildSlackVisibleLlmFailureNotice } from "../lib/llm-failure.js";
import {
  isDuplicateWebhookDelivery,
  isLoopedWebhookIssue,
  parseLinearWebhookEvent,
  updateWebhookDeliveryStatus,
  upsertWebhookDelivery,
  verifyLinearWebhookRequest,
} from "../lib/linear-webhook.js";
import { sendSlackReply } from "../lib/slack-replies.js";
import type { AppConfig } from "../lib/config.js";
import {
  appendThreadLog,
  ensureThreadWorkspace,
} from "../lib/thread-workspace.js";
import type { ManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import { buildWebhookPaths } from "../lib/system-workspace.js";
import { handleIssueCreatedWebhook } from "../orchestrators/webhooks/handle-issue-created.js";
import {
  buildSlackVisibleFailureReply,
  readRawBody,
  type JstClock,
  type QueueLike,
} from "./app-runtime-shared.js";
import type { SystemTaskExecutor } from "./system-task-executor.js";

export function createWebhookRequestHandler(args: {
  config: AppConfig;
  logger: Logger;
  webClient: WebClient;
  managerRepositories: ManagerRepositories;
  linearEnv: Record<string, string | undefined>;
  webhookQueue: QueueLike;
  clock: JstClock;
  systemTaskExecutor: SystemTaskExecutor;
}): {
  handleWebhookRequest: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
} {
  async function processIssueCreatedWebhookDelivery(event: {
    deliveryId: string;
    webhookId?: string;
    issueId: string;
    issueIdentifier: string;
    receivedAt: string;
  }): Promise<void> {
    const currentPolicy = await args.managerRepositories.policy.load();
    const deliveries = await args.managerRepositories.webhookDeliveries.load();
    if (isLoopedWebhookIssue(deliveries, event.issueId, event.issueIdentifier)) {
      const nextDeliveries = updateWebhookDeliveryStatus(deliveries, event.deliveryId, {
        status: "ignored-loop",
        reason: `${event.issueIdentifier} was created by prior webhook automation`,
      });
      await args.managerRepositories.webhookDeliveries.save(nextDeliveries);
      args.logger.info("Ignored webhook issue create due to loop prevention", {
        deliveryId: event.deliveryId,
        issueId: event.issueId,
        issueIdentifier: event.issueIdentifier,
      });
      return;
    }

    const issue = await getLinearIssue(event.issueIdentifier, args.linearEnv).catch(async () => {
      return getLinearIssue(event.issueId, args.linearEnv);
    });
    if (!issue.identifier.startsWith(`${args.config.linearTeamKey}-`)) {
      const nextDeliveries = updateWebhookDeliveryStatus(deliveries, event.deliveryId, {
        status: "ignored-unsupported",
        reason: `${issue.identifier} is outside team ${args.config.linearTeamKey}`,
      });
      await args.managerRepositories.webhookDeliveries.save(nextDeliveries);
      args.logger.info("Ignored webhook issue create outside configured team", {
        deliveryId: event.deliveryId,
        issueIdentifier: issue.identifier,
      });
      return;
    }

    const paths = buildWebhookPaths(args.config.workspaceDir, issue.identifier);
    await ensureThreadWorkspace(paths);
    await appendThreadLog(paths, {
      type: "system",
      ts: `${Date.now() / 1000}`,
      threadTs: `webhook:${issue.identifier}`,
      text: `linear webhook issue created: ${issue.identifier}`,
    });

    const result = await handleIssueCreatedWebhook({
      config: args.config,
      paths,
      repositories: args.managerRepositories,
      policy: currentPolicy,
      issue,
      deliveryId: event.deliveryId,
      webhookId: event.webhookId,
      now: new Date(),
      env: args.linearEnv,
      currentDate: args.clock.currentDateInJst(),
      runAtJst: args.clock.currentDateTimeInJst(),
      runSchedulerJobNow: async (job) => {
        try {
          const runResult = await args.systemTaskExecutor.executeCustomSchedulerJob(job, "manual");
          return {
            status: "ok" as const,
            persistedSummary: runResult.postedReply,
            commitSummary: runResult.commitSummary,
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const visibleMessage = buildSlackVisibleLlmFailureNotice(error) ?? errorMessage;
          return {
            status: "error" as const,
            persistedSummary: visibleMessage,
            commitSummary: visibleMessage,
          };
        }
      },
    });

    const nextDeliveries = updateWebhookDeliveryStatus(
      await args.managerRepositories.webhookDeliveries.load(),
      event.deliveryId,
      {
        status: result.status,
        reason: result.reason,
        createdIssueIds: result.createdIssueIds,
      },
    );
    await args.managerRepositories.webhookDeliveries.save(nextDeliveries);

    if (result.agentResult) {
      args.logger.info("Manager webhook agent result", {
        intent: result.agentResult.intentReport?.intent,
        queryKind: result.agentResult.intentReport?.queryKind,
        queryScope: result.agentResult.intentReport?.queryScope,
        taskExecutionDecision: result.agentResult.taskExecutionDecision?.decision,
        taskExecutionSummary: result.agentResult.taskExecutionDecision?.summary,
        toolCalls: result.agentResult.toolCalls.map((call) => call.toolName),
        proposalCount: result.agentResult.proposals.length,
        invalidProposalCount: result.agentResult.invalidProposalCount,
        committedCommands: result.commitResult?.committed.map((entry) => entry.commandType) ?? [],
        commitRejections: result.commitResult?.rejected.map((entry) => entry.reason) ?? [],
        deliveryId: event.deliveryId,
        issueIdentifier: issue.identifier,
      });
    }

    if (result.status === "noop") {
      args.logger.info("Webhook issue create resulted in no-op", {
        deliveryId: event.deliveryId,
        issueIdentifier: issue.identifier,
        reason: result.reason,
      });
      return;
    }

    const notificationReply = result.status === "committed"
      ? [`${issue.identifier} に対して自動処理を実施しました。`, result.reply].filter(Boolean).join("\n\n")
      : [`${issue.identifier} の webhook 自動処理に失敗しました。`, result.reply ?? result.reason].filter(Boolean).join("\n\n");

    const postedReply = await sendSlackReply(args.webClient, {
      channel: currentPolicy.controlRoomChannelId,
      reply: notificationReply,
      linearWorkspace: args.config.linearWorkspace,
    });
    await appendThreadLog(paths, {
      type: "assistant",
      ts: `${Date.now() / 1000}`,
      threadTs: `webhook:${issue.identifier}`,
      text: postedReply,
    });
  }

  async function handleWebhookRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if ((request.url ?? "") !== args.config.linearWebhookPath) {
      response.statusCode = 404;
      response.end("Not found");
      return;
    }
    if (request.method !== "POST") {
      response.statusCode = 405;
      response.end("Method not allowed");
      return;
    }

    const rawBody = await readRawBody(request);
    const verification = verifyLinearWebhookRequest({
      headers: request.headers,
      rawBody,
      secret: args.config.linearWebhookSecret ?? "",
    });
    if (!verification.ok) {
      response.statusCode = verification.statusCode;
      response.end(verification.error ?? "Invalid webhook");
      return;
    }

    const receivedAt = new Date().toISOString();
    let parsedEvent;
    try {
      parsedEvent = parseLinearWebhookEvent({
        headers: request.headers,
        rawBody,
        receivedAt,
      });
    } catch (error) {
      response.statusCode = 400;
      response.end(error instanceof Error ? error.message : String(error));
      return;
    }

    if (parsedEvent.kind === "unsupported") {
      const deliveries = await args.managerRepositories.webhookDeliveries.load();
      const nextDeliveries = upsertWebhookDelivery(deliveries, parsedEvent.record);
      await args.managerRepositories.webhookDeliveries.save(nextDeliveries);
      response.statusCode = 200;
      response.end("ok");
      return;
    }

    const deliveries = await args.managerRepositories.webhookDeliveries.load();
    if (isDuplicateWebhookDelivery(deliveries, parsedEvent.event.deliveryId)) {
      const existing = deliveries.find((entry) => entry.deliveryId === parsedEvent.event.deliveryId);
      if (existing?.status === "received") {
        const nextDeliveries = updateWebhookDeliveryStatus(deliveries, parsedEvent.event.deliveryId, {
          status: "ignored-duplicate",
          reason: "duplicate Linear-Delivery ignored while original processing is already in flight",
        });
        await args.managerRepositories.webhookDeliveries.save(nextDeliveries);
      }
      response.statusCode = 200;
      response.end("ok");
      return;
    }

    const receivedEntry = {
      deliveryId: parsedEvent.event.deliveryId,
      webhookId: parsedEvent.event.webhookId,
      issueId: parsedEvent.event.issueId,
      issueIdentifier: parsedEvent.event.issueIdentifier,
      receivedAt: parsedEvent.event.receivedAt,
      status: "received" as const,
      createdIssueIds: [],
    };
    await args.managerRepositories.webhookDeliveries.save(
      upsertWebhookDelivery(deliveries, receivedEntry),
    );

    args.webhookQueue.enqueue("linear-webhook", async () => {
      try {
        await processIssueCreatedWebhookDelivery(parsedEvent.event);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        args.logger.error("Webhook issue create processing failed", {
          deliveryId: parsedEvent.event.deliveryId,
          issueId: parsedEvent.event.issueId,
          issueIdentifier: parsedEvent.event.issueIdentifier,
          error: errorMessage,
        });
        const nextDeliveries = updateWebhookDeliveryStatus(
          await args.managerRepositories.webhookDeliveries.load(),
          parsedEvent.event.deliveryId,
          {
            status: "failed",
            reason: errorMessage,
          },
        );
        await args.managerRepositories.webhookDeliveries.save(nextDeliveries);

        const currentPolicy = await args.managerRepositories.policy.load();
        await sendSlackReply(args.webClient, {
          channel: currentPolicy.controlRoomChannelId,
          reply: `${parsedEvent.event.issueIdentifier} の webhook 自動処理に失敗しました。\n\n${
            buildSlackVisibleFailureReply({
              error,
              fallbackReply: "処理に失敗しました。設定や Linear 連携を確認してください。",
              includeTechnicalMessage: true,
            })
          }`,
          linearWorkspace: args.config.linearWorkspace,
        }).catch((notifyError) => {
          args.logger.error("Failed to notify control room about webhook failure", {
            deliveryId: parsedEvent.event.deliveryId,
            error: notifyError instanceof Error ? notifyError.message : String(notifyError),
          });
        });
      }
    });

    response.statusCode = 200;
    response.end("ok");
  }

  return {
    handleWebhookRequest,
  };
}
