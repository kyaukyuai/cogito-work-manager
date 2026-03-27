import type { WebClient } from "@slack/web-api";
import { parseHeartbeatManagerReply, type HeartbeatExecutionResult } from "../lib/heartbeat.js";
import { sendSlackReply } from "../lib/slack-replies.js";
import {
  buildHeartbeatPaths,
  buildSchedulerPaths,
  type SchedulerJob,
} from "../lib/system-workspace.js";
import {
  appendThreadLog,
  ensureThreadWorkspace,
} from "../lib/thread-workspace.js";
import type { AppConfig } from "../lib/config.js";
import type { SchedulerExecutionResult } from "../lib/scheduler.js";
import type { JstClock } from "./app-runtime-shared.js";
import type { SystemTaskExecutor } from "./system-task-executor.js";

export function createSchedulerHeartbeatHandler(args: {
  config: AppConfig;
  webClient: WebClient;
  clock: JstClock;
  systemTaskExecutor: SystemTaskExecutor;
}): {
  executeHeartbeat: (args: { channelId: string; prompt: string }) => Promise<HeartbeatExecutionResult>;
  executeScheduledJob: (args: { job: SchedulerJob }) => Promise<SchedulerExecutionResult>;
} {
  async function executeHeartbeat(argsForHeartbeat: {
    channelId: string;
    prompt: string;
  }): Promise<HeartbeatExecutionResult> {
    const paths = buildHeartbeatPaths(args.config.workspaceDir, argsForHeartbeat.channelId);
    await ensureThreadWorkspace(paths);
    await appendThreadLog(paths, {
      type: "system",
      ts: `${Date.now() / 1000}`,
      threadTs: "heartbeat",
      text: argsForHeartbeat.prompt,
    });

    const reply = await args.systemTaskExecutor.executeManagerSystemTask({
      paths,
      input: {
        kind: "heartbeat",
        channelId: argsForHeartbeat.channelId,
        rootThreadTs: "heartbeat",
        messageTs: "heartbeat",
        currentDate: args.clock.currentDateInJst(),
        runAtJst: args.clock.currentDateTimeInJst(),
        text: argsForHeartbeat.prompt,
      },
      fallback: async () => "heartbeat noop: agent-fallback",
    });
    const parsedHeartbeatReply = parseHeartbeatManagerReply(reply);
    if (parsedHeartbeatReply.status === "noop") {
      await appendThreadLog(paths, {
        type: "system",
        ts: `${Date.now() / 1000}`,
        threadTs: "heartbeat",
        text: parsedHeartbeatReply.reply,
      });
      return {
        reply: parsedHeartbeatReply.reply,
        status: "noop",
        reason: parsedHeartbeatReply.reason,
      };
    }

    const postedReply = await sendSlackReply(args.webClient, {
      channel: argsForHeartbeat.channelId,
      reply: parsedHeartbeatReply.reply,
      linearWorkspace: args.config.linearWorkspace,
    });

    await appendThreadLog(paths, {
      type: "assistant",
      ts: `${Date.now() / 1000}`,
      threadTs: "heartbeat",
      text: postedReply,
    });

    return { reply: postedReply, status: "posted" };
  }

  async function executeScheduledJob(
    argsForJob: { job: SchedulerJob },
  ): Promise<SchedulerExecutionResult> {
    const { job } = argsForJob;
    if (!args.config.slackAllowedChannelIds.has(job.channelId)) {
      throw new Error(`Job channel ${job.channelId} is not in SLACK_ALLOWED_CHANNEL_IDS`);
    }

    if (job.action) {
      const mappedKind = job.action;
      const paths = buildSchedulerPaths(args.config.workspaceDir, job.id);
      await ensureThreadWorkspace(paths);
      const reply = await args.systemTaskExecutor.executeManagerSystemTask({
        paths,
        input: {
          kind: mappedKind,
          channelId: job.channelId,
          rootThreadTs: job.id,
          messageTs: job.id,
          currentDate: args.clock.currentDateInJst(),
          runAtJst: args.clock.currentDateTimeInJst(),
          text: job.prompt,
          metadata: {
            jobId: job.id,
            scheduleKind: job.kind,
            reviewKind: mappedKind,
          },
        },
        fallback: async () => {
          return "Manager review is temporarily unavailable. Please retry this review from the control room if needed.";
        },
      });
      if (reply === "Manager review is temporarily unavailable. Please retry this review from the control room if needed.") {
        return {
          delivered: false,
          summary: reply,
        };
      }

      const postedReply = await sendSlackReply(args.webClient, {
        channel: job.channelId,
        reply,
        linearWorkspace: args.config.linearWorkspace,
      });

      return {
        delivered: true,
        summary: postedReply,
      };
    }

    const result = await args.systemTaskExecutor.executeCustomSchedulerJob(job, "scheduled");
    return {
      delivered: true,
      summary: result.postedReply,
    };
  }

  return {
    executeHeartbeat,
    executeScheduledJob,
  };
}
