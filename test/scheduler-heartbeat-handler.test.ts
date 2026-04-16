import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildThreadPaths } from "../src/lib/thread-workspace.js";
import { loadSystemThreadContext } from "../src/lib/system-thread-context.js";

const slackReplyMocks = vi.hoisted(() => ({
  sendSlackReply: vi.fn(),
}));

const threadWorkspaceMocks = vi.hoisted(() => ({
  appendThreadLog: vi.fn(),
  ensureThreadWorkspace: vi.fn(async () => undefined),
}));

vi.mock("../src/lib/slack-replies.js", () => ({
  sendSlackReply: slackReplyMocks.sendSlackReply,
}));

vi.mock("../src/lib/thread-workspace.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/thread-workspace.js")>("../src/lib/thread-workspace.js");
  return {
    ...actual,
    appendThreadLog: threadWorkspaceMocks.appendThreadLog,
    ensureThreadWorkspace: threadWorkspaceMocks.ensureThreadWorkspace,
  };
});

function buildConfig(workspaceDir = "/tmp/cogito-runtime-test") {
  return {
    slackAppToken: "xapp-test",
    slackBotToken: "xoxb-test",
    slackAllowedChannelIds: new Set(["C123"]),
    anthropicApiKey: "anthropic-test",
    linearApiKey: "lin_api_test",
    linearWorkspace: "kyaukyuai",
    linearTeamKey: "AIC",
    notionApiToken: undefined,
    notionAgendaParentPageId: undefined,
    botModel: "claude-sonnet-4-6",
    botThinkingLevel: "minimal" as const,
    botMaxOutputTokens: undefined,
    botRetryMaxRetries: 0,
    workspaceDir,
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
}

describe("scheduler heartbeat handler", () => {
  let workspaceDir: string;

  beforeEach(() => {
    vi.resetModules();
    slackReplyMocks.sendSlackReply.mockReset();
    threadWorkspaceMocks.appendThreadLog.mockReset();
    threadWorkspaceMocks.ensureThreadWorkspace.mockClear();
    workspaceDir = "/tmp/cogito-runtime-test";
  });

  afterEach(async () => {
    if (workspaceDir !== "/tmp/cogito-runtime-test") {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("routes action jobs through the shared system task executor", async () => {
    const { createSchedulerHeartbeatHandler } = await import("../src/runtime/scheduler-heartbeat-handler.js");
    const executeManagerSystemTask = vi.fn().mockResolvedValue({
      reply: "review summary",
    });
    slackReplyMocks.sendSlackReply.mockResolvedValue("posted review summary");

    const handler = createSchedulerHeartbeatHandler({
      config: buildConfig(workspaceDir),
      webClient: {} as never,
      clock: {
        currentDateInJst: () => "2026-03-27",
        currentDateTimeInJst: () => "2026-03-27 16:00 JST",
      },
      systemTaskExecutor: {
        executeManagerSystemTask,
        executeCustomSchedulerJob: vi.fn(),
      },
    });

    const result = await handler.executeScheduledJob({
      job: {
        id: "job-1",
        channelId: "C123",
        kind: "builtin",
        action: "morning-review",
        prompt: "朝レビュー",
      },
    });

    expect(executeManagerSystemTask).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        kind: "morning-review",
        channelId: "C123",
      }),
    }));
    expect(result).toEqual({
      delivered: true,
      summary: "posted review summary",
    });
  });

  it("routes non-action jobs through the shared custom scheduler executor", async () => {
    const { createSchedulerHeartbeatHandler } = await import("../src/runtime/scheduler-heartbeat-handler.js");
    const executeCustomSchedulerJob = vi.fn().mockResolvedValue({
      postedReply: "posted custom job",
      rawReply: "raw custom job",
      commitSummary: "commit summary",
    });

    const handler = createSchedulerHeartbeatHandler({
      config: buildConfig(workspaceDir),
      webClient: {} as never,
      clock: {
        currentDateInJst: () => "2026-03-27",
        currentDateTimeInJst: () => "2026-03-27 16:00 JST",
      },
      systemTaskExecutor: {
        executeManagerSystemTask: vi.fn(),
        executeCustomSchedulerJob,
      },
    });

    const result = await handler.executeScheduledJob({
      job: {
        id: "job-2",
        channelId: "C123",
        kind: "custom",
        prompt: "カスタムジョブ",
      },
    });

    expect(executeCustomSchedulerJob).toHaveBeenCalledWith({
      id: "job-2",
      channelId: "C123",
      kind: "custom",
      prompt: "カスタムジョブ",
    }, "scheduled");
    expect(result).toEqual({
      delivered: true,
      summary: "posted custom job",
    });
  });

  it("returns an undelivered result when a built-in review falls back", async () => {
    const { createSchedulerHeartbeatHandler } = await import("../src/runtime/scheduler-heartbeat-handler.js");
    const executeManagerSystemTask = vi.fn().mockResolvedValue({
      reply: "Manager review is temporarily unavailable. Please retry this review from the control room if needed.",
    });

    const handler = createSchedulerHeartbeatHandler({
      config: buildConfig(workspaceDir),
      webClient: {} as never,
      clock: {
        currentDateInJst: () => "2026-04-16",
        currentDateTimeInJst: () => "2026-04-16 17:02 JST",
      },
      systemTaskExecutor: {
        executeManagerSystemTask,
        executeCustomSchedulerJob: vi.fn(),
      },
    });

    const result = await handler.executeScheduledJob({
      job: {
        id: "manager-review-evening",
        channelId: "C123",
        kind: "builtin",
        action: "evening-review",
        prompt: "夕方レビュー",
      },
    });

    expect(result).toEqual({
      delivered: false,
      summary: "Manager review is temporarily unavailable. Please retry this review from the control room if needed.",
    });
    expect(slackReplyMocks.sendSlackReply).not.toHaveBeenCalled();
  });

  it("persists actual Slack thread context for top-level review posts", async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "cogito-scheduler-heartbeat-"));
    const { createSchedulerHeartbeatHandler } = await import("../src/runtime/scheduler-heartbeat-handler.js");
    const executeManagerSystemTask = vi.fn().mockResolvedValue({
      reply: "AIC-86/87 を確認します。",
      systemThreadContextReport: {
        sourceKind: "review",
        issueRefs: [
          { issueId: "AIC-86", titleHint: "役員チャンネル招待", role: "related" },
          { issueId: "AIC-87", titleHint: "収集すべきMTG定例名", role: "primary" },
        ],
        summary: "evening review follow-up",
      },
    });
    slackReplyMocks.sendSlackReply.mockImplementation(async (_webClient, args) => {
      await args.onPosted?.({
        ts: "1774944062.253979",
        text: "posted review summary",
      });
      return "posted review summary";
    });

    const handler = createSchedulerHeartbeatHandler({
      config: buildConfig(workspaceDir),
      webClient: {} as never,
      clock: {
        currentDateInJst: () => "2026-03-31",
        currentDateTimeInJst: () => "2026-03-31 17:01 JST",
      },
      systemTaskExecutor: {
        executeManagerSystemTask,
        executeCustomSchedulerJob: vi.fn(),
      },
    });

    await handler.executeScheduledJob({
      job: {
        id: "manager-review-evening",
        channelId: "C123",
        kind: "builtin",
        action: "evening-review",
        prompt: "夕方レビュー",
      },
    });

    expect(threadWorkspaceMocks.appendThreadLog).toHaveBeenCalledWith(
      expect.objectContaining({
        rootDir: expect.stringContaining("1774944062_253979"),
      }),
      expect.objectContaining({
        type: "assistant",
        threadTs: "1774944062.253979",
        text: "posted review summary",
      }),
    );

    const actualThreadPaths = buildThreadPaths(workspaceDir, "C123", "1774944062.253979");
    await expect(loadSystemThreadContext(actualThreadPaths)).resolves.toMatchObject({
      sourceKind: "review",
      rootPostedTs: "1774944062.253979",
      issueRefs: [
        expect.objectContaining({ issueId: "AIC-86" }),
        expect.objectContaining({ issueId: "AIC-87" }),
      ],
    });
  });
});
