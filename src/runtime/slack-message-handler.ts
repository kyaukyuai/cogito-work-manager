import type { WebClient } from "@slack/web-api";
import { HeartbeatService } from "../lib/heartbeat.js";
import type { Logger } from "../lib/logger.js";
import { handleManagerMessage } from "../lib/manager.js";
import type { ManagerIntentReport } from "../lib/manager-command-commit.js";
import { buildSlackVisibleLlmFailureNotice } from "../lib/llm-failure.js";
import { postSlackMentionMessage } from "../lib/slack-replies.js";
import {
  analyzeSlackMessageProcessability,
  normalizeSlackMessage,
  type RawSlackMessageEvent,
} from "../lib/slack.js";
import {
  appendThreadLog,
  buildThreadPaths,
  ensureThreadWorkspace,
  type AttachmentRecord,
} from "../lib/thread-workspace.js";
import {
  resolveExternalCoordinationHint,
  saveExternalCoordinationHint,
} from "../lib/external-coordination-hint.js";
import type { AppConfig } from "../lib/config.js";
import type { SystemPaths } from "../lib/system-workspace.js";
import type { ManagerPolicy } from "../state/manager-state-contract.js";
import type { ManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import type { ManagerMessageAttachmentSummary } from "./manager-prompts.js";
import {
  buildSlackVisibleFailureReply,
  isReadOnlyStreamingIntent,
  type QueueLike,
} from "./app-runtime-shared.js";
import { createSlackReplyStreamController } from "../lib/slack-replies.js";
import type { SystemTaskExecutor } from "./system-task-executor.js";
import { ingestThreadAttachments } from "../gateways/slack-attachments/index.js";

export function createSlackMessageHandler(args: {
  config: AppConfig;
  logger: Logger;
  webClient: WebClient;
  systemPaths: SystemPaths;
  managerRepositories: ManagerRepositories;
  slackTeamId?: string;
  setManagerPolicy: (policy: ManagerPolicy) => void;
  messageQueue: QueueLike;
  systemTaskExecutor: SystemTaskExecutor;
}): {
  handleSlackMessageEvent: (
    event: unknown,
    botUserId: string,
    heartbeatService?: HeartbeatService,
  ) => Promise<void>;
} {
  async function executeSlackMentionPost(argsForPost: {
    channel: string;
    mentionSlackUserId: string;
    messageText: string;
    threadTs?: string;
  }): Promise<{ text: string; ts?: string }> {
    return postSlackMentionMessage(args.webClient, {
      channel: argsForPost.channel,
      mentionSlackUserId: argsForPost.mentionSlackUserId,
      messageText: argsForPost.messageText,
      threadTs: argsForPost.threadTs,
      linearWorkspace: args.config.linearWorkspace,
    });
  }

  async function handleSlackMessageEvent(
    event: unknown,
    botUserId: string,
    heartbeatService?: HeartbeatService,
  ): Promise<void> {
    const rawEvent = event as RawSlackMessageEvent;
    const processability = analyzeSlackMessageProcessability(rawEvent, botUserId, args.config.slackAllowedChannelIds);
    const suppressedExternalCoordinationMessage = !processability.shouldProcess
      && processability.reason === "ignored_other_user_mention_without_bot";
    if (!processability.shouldProcess) {
      if (suppressedExternalCoordinationMessage) {
        args.logger.info("Ignored Slack message with non-bot mention and no Cogito mention", {
          channelId: rawEvent.channel,
          threadTs: rawEvent.thread_ts ?? rawEvent.ts,
          userId: rawEvent.user,
          mentionedUserIds: processability.mentionedUserIds,
        });
      } else {
        return;
      }
    }

    const message = normalizeSlackMessage(rawEvent);
    const threadKey = `${message.channelId}:${message.rootThreadTs}`;
    let observedIntent: ManagerIntentReport["intent"] | undefined;
    let streamActivationPromise: Promise<boolean> | undefined;
    const streamController = suppressedExternalCoordinationMessage
      ? {
          enableStreaming: async () => false,
          disableStreaming: () => undefined,
          pushTextDelta: (_delta: string) => undefined,
          finalizeReply: async (reply: string) => reply,
        }
      : createSlackReplyStreamController(args.webClient, {
          channel: message.channelId,
          threadTs: message.rootThreadTs,
          recipientUserId: message.userId,
          recipientTeamId: args.slackTeamId,
          linearWorkspace: args.config.linearWorkspace,
          onEvent: (streamEvent) => {
            const logPayload = {
              channelId: message.channelId,
              threadTs: message.rootThreadTs,
              intent: observedIntent,
              reason: streamEvent.reason,
              error: streamEvent.error,
              streamTs: streamEvent.ts,
            };
            if (streamEvent.type === "stream_failed") {
              args.logger.warn("Slack reply stream failed", logPayload);
              return;
            }
            if (streamEvent.type === "stream_fallback") {
              args.logger.info("Slack reply stream fell back to non-streaming reply", logPayload);
              return;
            }
            if (streamEvent.type === "stream_started") {
              args.logger.info("Slack reply stream started", logPayload);
              return;
            }
            args.logger.info("Slack reply stream stopped", logPayload);
          },
        });

    args.messageQueue.enqueue(threadKey, async () => {
      const paths = buildThreadPaths(args.config.workspaceDir, message.channelId, message.rootThreadTs);
      await ensureThreadWorkspace(paths);

      let attachments: AttachmentRecord[] = [];
      let attachmentSummaries: ManagerMessageAttachmentSummary[] = [];
      try {
        const attachmentResult = await ingestThreadAttachments({
          paths,
          slackBotToken: args.config.slackBotToken,
          webClient: args.webClient,
          channelId: message.channelId,
          rootThreadTs: message.rootThreadTs,
          messageTs: message.ts,
          subtype: rawEvent.subtype,
          files: message.files,
        });
        attachments = attachmentResult.attachments;
        attachmentSummaries = attachmentResult.summaries;
        if (attachmentResult.usedHydratedSlackFiles) {
          args.logger.info("Hydrated Slack attachment metadata from thread history", {
            channelId: message.channelId,
            threadTs: message.rootThreadTs,
            messageTs: message.ts,
          });
        }
        for (const diagnostic of attachmentResult.diagnostics ?? []) {
          const logPayload = {
            channelId: message.channelId,
            threadTs: message.rootThreadTs,
            messageTs: message.ts,
          };
          if (diagnostic.level === "warn") {
            args.logger.warn(diagnostic.message, logPayload);
          } else {
            args.logger.info(diagnostic.message, logPayload);
          }
        }
      } catch (error) {
        args.logger.warn("Attachment ingest failed", {
          channelId: message.channelId,
          threadTs: message.rootThreadTs,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      await appendThreadLog(paths, {
        type: "user",
        ts: message.ts,
        threadTs: message.rootThreadTs,
        userId: message.userId,
        text: message.text,
        attachments,
      });

      if (suppressedExternalCoordinationMessage) {
        const targetSlackUserIds = processability.mentionedUserIds.filter((userId) => userId !== botUserId);
        try {
          const hintResolution = await resolveExternalCoordinationHint({
            config: args.config,
            paths,
            channelId: message.channelId,
            rootThreadTs: message.rootThreadTs,
            sourceMessageTs: message.ts,
            sourceUserId: message.userId,
            targetSlackUserIds,
            requestText: message.text,
            attachments: attachmentSummaries,
          });
          for (const diagnostic of hintResolution.diagnostics) {
            const logPayload = {
              channelId: message.channelId,
              threadTs: message.rootThreadTs,
              messageTs: message.ts,
            };
            if (diagnostic.level === "warn") {
              args.logger.warn(diagnostic.message, logPayload);
            } else {
              args.logger.info(diagnostic.message, logPayload);
            }
          }
          if (hintResolution.hint) {
            await saveExternalCoordinationHint(paths, hintResolution.hint);
            args.logger.info("Saved external coordination hint for ignored Slack message", {
              channelId: message.channelId,
              threadTs: message.rootThreadTs,
              messageTs: message.ts,
              issueId: hintResolution.hint.issueId,
              targetSlackUserId: hintResolution.hint.targetSlackUserId,
            });
          }
        } catch (error) {
          args.logger.warn("External coordination hint resolution failed", {
            channelId: message.channelId,
            threadTs: message.rootThreadTs,
            messageTs: message.ts,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      try {
        const managerResult = await handleManagerMessage(
          args.config,
          args.systemPaths,
          {
            channelId: message.channelId,
            rootThreadTs: message.rootThreadTs,
            messageTs: message.ts,
            userId: message.userId,
            text: message.text,
            attachments: attachmentSummaries,
          },
          args.managerRepositories,
          undefined,
          {
            runSchedulerJobNow: async (job) => {
              try {
                const result = await args.systemTaskExecutor.executeCustomSchedulerJob(job, "manual");
                return {
                  status: "ok" as const,
                  persistedSummary: result.postedReply,
                  commitSummary: result.commitSummary,
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
            postSlackMessage: executeSlackMentionPost,
            logger: args.logger,
            managerAgentObserver: {
              onIntentReport: (report) => {
                observedIntent = report.intent;
                if (!isReadOnlyStreamingIntent(report.intent)) {
                  streamController.disableStreaming();
                  streamActivationPromise = undefined;
                  return;
                }
                streamActivationPromise = streamController.enableStreaming().catch((error) => {
                  args.logger.warn("Failed to enable Slack reply streaming", {
                    channelId: message.channelId,
                    threadTs: message.rootThreadTs,
                    intent: report.intent,
                    error: error instanceof Error ? error.message : String(error),
                  });
                  return false;
                });
              },
              onTextDelta: (delta) => {
                streamController.pushTextDelta(delta);
              },
            },
          },
        );
        if (managerResult.diagnostics?.agent) {
          const agent = managerResult.diagnostics.agent;
          const logPayload = {
            intent: agent.intent,
            queryKind: agent.queryKind,
            queryScope: agent.queryScope,
            confidence: agent.confidence,
            reasoningSummary: agent.reasoningSummary,
            toolCalls: agent.toolCalls,
            proposalCount: agent.proposalCount,
            invalidProposalCount: agent.invalidProposalCount,
            committedCommands: agent.committedCommands,
            commitRejections: agent.commitRejections,
            pendingClarificationDecision: agent.pendingClarificationDecision,
            pendingClarificationPersistence: agent.pendingClarificationPersistence,
            pendingClarificationDecisionSummary: agent.pendingClarificationDecisionSummary,
            missingQuerySnapshot: agent.missingQuerySnapshot,
            technicalFailure: agent.technicalFailure,
            channelId: message.channelId,
            threadTs: message.rootThreadTs,
          };
          if (agent.source === "fallback") {
            args.logger.warn("Manager agent fell back to safety-only response", logPayload);
          } else {
            args.logger.info("Manager agent decision", logPayload);
          }
        }
        if (managerResult.diagnostics?.router) {
          const router = managerResult.diagnostics.router;
          const logPayload = {
            action: router.action,
            queryKind: router.queryKind,
            queryScope: router.queryScope,
            confidence: router.confidence,
            reasoningSummary: router.reasoningSummary,
            technicalFailure: router.technicalFailure,
            channelId: message.channelId,
            threadTs: message.rootThreadTs,
          };
          if (router.source === "fallback") {
            args.logger.warn("Manager fallback routing decided a safety-only response", logPayload);
          } else {
            args.logger.info("Manager router decision", logPayload);
          }
        }

        if (heartbeatService && managerResult.diagnostics?.agent?.committedCommands.includes("update_builtin_schedule")) {
          const managerPolicy = await args.managerRepositories.policy.load();
          args.setManagerPolicy(managerPolicy);
          await heartbeatService.reconfigure({
            intervalMin: managerPolicy.heartbeatEnabled ? managerPolicy.heartbeatIntervalMin : 0,
            activeLookbackHours: managerPolicy.heartbeatActiveLookbackHours,
          });
        }

        const reply = managerResult.reply ?? "必要なことを少し具体的に教えてください。";
        if (streamActivationPromise) {
          await streamActivationPromise;
        }
        const formattedReply = await streamController.finalizeReply(reply);

        await appendThreadLog(paths, {
          type: "assistant",
          ts: `${Date.now() / 1000}`,
          threadTs: message.rootThreadTs,
          text: formattedReply,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        args.logger.error("Failed to process Slack message", {
          channelId: message.channelId,
          threadTs: message.rootThreadTs,
          error: errorMessage,
        });
        if (streamActivationPromise) {
          await streamActivationPromise;
        }
        const reply = await streamController.finalizeReply(buildSlackVisibleFailureReply({
          error,
          fallbackReply: "処理に失敗しました。設定や Linear 連携を確認してください。",
          includeTechnicalMessage: true,
        }));

        await appendThreadLog(paths, {
          type: "system",
          ts: `${Date.now() / 1000}`,
          threadTs: message.rootThreadTs,
          text: reply,
        });
      }
    });
  }

  return {
    handleSlackMessageEvent,
  };
}
