import { beforeEach, describe, expect, it, vi } from "vitest";

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

function buildConfig() {
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
    workspaceDir: "/tmp/cogito-runtime-test",
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
  beforeEach(() => {
    vi.resetModules();
    slackReplyMocks.sendSlackReply.mockReset();
    threadWorkspaceMocks.appendThreadLog.mockReset();
    threadWorkspaceMocks.ensureThreadWorkspace.mockClear();
  });

  it("routes action jobs through the shared system task executor", async () => {
    const { createSchedulerHeartbeatHandler } = await import("../src/runtime/scheduler-heartbeat-handler.js");
    const executeManagerSystemTask = vi.fn().mockResolvedValue("review summary");
    slackReplyMocks.sendSlackReply.mockResolvedValue("posted review summary");

    const handler = createSchedulerHeartbeatHandler({
      config: buildConfig(),
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
      config: buildConfig(),
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
});
