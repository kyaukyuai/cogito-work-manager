import type { WebClient } from "@slack/web-api";
import { commitManagerCommandProposals } from "../lib/manager-command-commit.js";
import type { Logger } from "../lib/logger.js";
import { runManagerSystemTurn } from "../lib/pi-session.js";
import { sendSlackReply } from "../lib/slack-replies.js";
import { mergeSystemReply } from "../lib/system-slack-reply.js";
import { buildSlackVisibleLlmFailureNotice } from "../lib/llm-failure.js";
import type { AppConfig } from "../lib/config.js";
import {
  appendThreadLog,
  ensureThreadWorkspace,
  type ThreadPaths,
} from "../lib/thread-workspace.js";
import {
  buildSchedulerPaths,
  type SchedulerJob,
  type SystemPaths,
} from "../lib/system-workspace.js";
import { handlePersonalizationUpdate } from "../orchestrators/personalization/handle-personalization.js";
import { reconcileAwaitingFollowupsWithCurrentLinear } from "../orchestrators/review/review-data.js";
import type { ManagerPolicy } from "../state/manager-state-contract.js";
import type { ManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import {
  buildSlackVisibleFailureReply,
  extractSchedulerRunCommitSummary,
  type JstClock,
} from "./app-runtime-shared.js";
import {
  persistSystemRootSlackThread,
  type SystemThreadContextReport,
} from "../lib/system-thread-context.js";

export interface ExecuteManagerSystemTaskArgs {
  paths: ThreadPaths;
  input: Parameters<typeof runManagerSystemTurn>[2];
  fallback: () => Promise<string>;
}

export interface ExecuteManagerSystemTaskResult {
  reply: string;
  systemThreadContextReport?: SystemThreadContextReport;
}

export interface CustomSchedulerJobResult {
  postedReply: string;
  rawReply: string;
  commitSummary?: string;
}

export interface SystemTaskExecutor {
  executeManagerSystemTask: (task: ExecuteManagerSystemTaskArgs) => Promise<ExecuteManagerSystemTaskResult>;
  executeCustomSchedulerJob: (
    job: SchedulerJob,
    trigger: "scheduled" | "manual",
  ) => Promise<CustomSchedulerJobResult>;
}

export function createSystemTaskExecutor(args: {
  config: AppConfig;
  logger: Logger;
  webClient: WebClient;
  systemPaths: SystemPaths;
  managerRepositories: ManagerRepositories;
  linearEnv: Record<string, string | undefined>;
  getManagerPolicy: () => ManagerPolicy;
  clock: JstClock;
}): SystemTaskExecutor {
  async function executeManagerSystemTask(task: ExecuteManagerSystemTaskArgs): Promise<ExecuteManagerSystemTaskResult> {
    try {
      if (
        task.input.kind === "heartbeat"
        || task.input.kind === "morning-review"
        || task.input.kind === "evening-review"
        || task.input.kind === "weekly-review"
      ) {
        try {
          await reconcileAwaitingFollowupsWithCurrentLinear(args.config, args.managerRepositories, new Date());
        } catch (error) {
          args.logger.warn("Review followup reconcile failed before manager system task", {
            kind: task.input.kind,
            channelId: task.input.channelId,
            threadTs: task.input.rootThreadTs,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const agentResult = await runManagerSystemTurn(args.config, task.paths, task.input);
      const commitResult = await commitManagerCommandProposals({
        config: args.config,
        repositories: args.managerRepositories,
        proposals: agentResult.proposals,
        message: {
          channelId: task.input.channelId,
          rootThreadTs: task.input.rootThreadTs,
          messageTs: task.input.messageTs,
          text: task.input.text,
        },
        now: new Date(),
        policy: args.getManagerPolicy(),
        env: args.linearEnv,
        runSchedulerJobNow: async (job) => {
          try {
            const result = await executeCustomSchedulerJob(job, "manual");
            return {
              status: "ok" as const,
              persistedSummary: result.postedReply,
              commitSummary: result.commitSummary,
            };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
              status: "error" as const,
              persistedSummary: buildSlackVisibleLlmFailureNotice(error) ?? errorMessage,
              commitSummary: buildSlackVisibleLlmFailureNotice(error) ?? errorMessage,
            };
          }
        },
      });
      args.logger.info("Manager system agent result", {
        intent: agentResult.intentReport?.intent,
        queryKind: agentResult.intentReport?.queryKind,
        queryScope: agentResult.intentReport?.queryScope,
        toolCalls: agentResult.toolCalls.map((call) => call.toolName),
        proposalCount: agentResult.proposals.length,
        invalidProposalCount: agentResult.invalidProposalCount,
        committedCommands: commitResult.committed.map((entry) => entry.commandType),
        commitRejections: commitResult.rejected.map((entry) => entry.reason),
        channelId: task.input.channelId,
        threadTs: task.input.rootThreadTs,
      });
      const mergedReply = mergeSystemReply({
        agentReply: agentResult.reply,
        commitSummaries: commitResult.replySummaries,
        commitRejections: commitResult.rejected.map((entry) => entry.reason),
      });
      try {
        await handlePersonalizationUpdate({
          config: args.config,
          systemPaths: args.systemPaths,
          paths: task.paths,
          repositories: args.managerRepositories,
          turnKind: "manager-system",
          latestUserMessage: task.input.text,
          latestAssistantReply: mergedReply,
          committedCommands: commitResult.committed.map((entry) => entry.commandType),
          rejectedReasons: commitResult.rejected.map((entry) => entry.reason),
          currentDate: task.input.currentDate,
          issueContext: {
            issueId: task.input.metadata?.issueId,
            issueIdentifier: task.input.metadata?.issueIdentifier,
          },
          now: new Date(),
        });
      } catch (error) {
        args.logger.warn("Personalization update failed after manager system task", {
          channelId: task.input.channelId,
          threadTs: task.input.rootThreadTs,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return {
        reply: mergedReply,
        systemThreadContextReport: agentResult.systemThreadContextReport,
      };
    } catch (error) {
      args.logger.warn("Manager system agent fell back to safety-only response", {
        channelId: task.input.channelId,
        threadTs: task.input.rootThreadTs,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        reply: buildSlackVisibleFailureReply({
          error,
          fallbackReply: await task.fallback(),
        }),
      };
    }
  }

  async function executeCustomSchedulerJob(
    job: SchedulerJob,
    trigger: "scheduled" | "manual",
  ): Promise<CustomSchedulerJobResult> {
    const paths = buildSchedulerPaths(args.config.workspaceDir, job.id);
    await ensureThreadWorkspace(paths);
    await appendThreadLog(paths, {
      type: "system",
      ts: `${Date.now() / 1000}`,
      threadTs: job.id,
      text: job.prompt,
    });

    const managerTaskResult = await executeManagerSystemTask({
      paths,
      input: {
        kind: "scheduler",
        channelId: job.channelId,
        rootThreadTs: job.id,
        messageTs: job.id,
        currentDate: args.clock.currentDateInJst(),
        runAtJst: args.clock.currentDateTimeInJst(),
        text: job.prompt,
        metadata: {
          jobId: job.id,
          scheduleKind: job.kind,
          trigger,
        },
      },
      fallback: async () => "処理に失敗しました。設定や連携を確認してください。",
    });
    const rawReply = managerTaskResult.reply;

    const postedReply = await sendSlackReply(args.webClient, {
      channel: job.channelId,
      reply: rawReply,
      linearWorkspace: args.config.linearWorkspace,
      onPosted: async (result) => {
        if (!result.ts) return;
        await persistSystemRootSlackThread({
          workspaceDir: args.config.workspaceDir,
          channelId: job.channelId,
          rootPostedTs: result.ts,
          postedText: result.text,
          report: managerTaskResult.systemThreadContextReport,
        });
      },
    });

    await appendThreadLog(paths, {
      type: "assistant",
      ts: `${Date.now() / 1000}`,
      threadTs: job.id,
      text: postedReply,
    });

    return {
      postedReply,
      rawReply,
      commitSummary: extractSchedulerRunCommitSummary(rawReply, postedReply),
    };
  }

  return {
    executeManagerSystemTask,
    executeCustomSchedulerJob,
  };
}
