import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const managerMocks = vi.hoisted(() => ({
  handleManagerMessage: vi.fn(),
}));

const threadWorkspaceMocks = vi.hoisted(() => ({
  appendThreadLog: vi.fn(),
  buildThreadPaths: vi.fn((workspaceDir: string, channelId: string, threadTs: string) => ({
    rootDir: `${workspaceDir}/${channelId}/${threadTs}`,
    attachmentsDir: `${workspaceDir}/attachments`,
    scratchDir: `${workspaceDir}/scratch`,
  })),
  ensureThreadWorkspace: vi.fn(async () => undefined),
}));

vi.mock("../src/lib/manager.js", () => ({
  handleManagerMessage: managerMocks.handleManagerMessage,
}));

vi.mock("../src/lib/thread-workspace.js", () => ({
  appendThreadLog: threadWorkspaceMocks.appendThreadLog,
  buildThreadPaths: threadWorkspaceMocks.buildThreadPaths,
  ensureThreadWorkspace: threadWorkspaceMocks.ensureThreadWorkspace,
}));

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

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createWebClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: "placeholder.123" }),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      startStream: vi.fn().mockResolvedValue({ ts: "stream.123" }),
      appendStream: vi.fn().mockResolvedValue({}),
      stopStream: vi.fn().mockResolvedValue({}),
    },
  } as never;
}

describe("slack message handler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    managerMocks.handleManagerMessage.mockReset();
    threadWorkspaceMocks.appendThreadLog.mockReset();
    threadWorkspaceMocks.buildThreadPaths.mockClear();
    threadWorkspaceMocks.ensureThreadWorkspace.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes heartbeat configuration after update_builtin_schedule commits", async () => {
    const { createSlackMessageHandler } = await import("../src/runtime/slack-message-handler.js");
    const webClient = createWebClient();
    const logger = createLogger();
    const reconfigure = vi.fn().mockResolvedValue(undefined);
    const setManagerPolicy = vi.fn();
    const policyLoad = vi.fn().mockResolvedValue({
      controlRoomChannelId: "CROOM",
      heartbeatEnabled: true,
      heartbeatIntervalMin: 45,
      heartbeatActiveLookbackHours: 12,
    });

    let pendingJob: Promise<void> | undefined;
    managerMocks.handleManagerMessage.mockResolvedValue({
      handled: true,
      reply: "設定を更新しました。",
      diagnostics: {
        agent: {
          source: "agent",
          intent: "update_scheduler",
          toolCalls: [],
          proposalCount: 1,
          invalidProposalCount: 0,
          committedCommands: ["update_builtin_schedule"],
          commitRejections: [],
          missingQuerySnapshot: false,
        },
      },
    });

    const handler = createSlackMessageHandler({
      config: buildConfig(),
      logger: logger as never,
      webClient,
      systemPaths: {} as never,
      managerRepositories: {
        policy: { load: policyLoad },
      } as never,
      slackTeamId: "T123",
      setManagerPolicy,
      messageQueue: {
        enqueue: (_key, job) => {
          pendingJob = job();
        },
      },
      systemTaskExecutor: {
        executeCustomSchedulerJob: vi.fn(),
        executeManagerSystemTask: vi.fn(),
      },
    });

    await handler.handleSlackMessageEvent({
      channel: "C123",
      user: "U123",
      ts: "111.666",
      text: "heartbeat を変えて",
    }, "UBOT", {
      reconfigure,
    } as never);

    await vi.runAllTimersAsync();
    await pendingJob;

    expect(policyLoad).toHaveBeenCalledTimes(1);
    expect(setManagerPolicy).toHaveBeenCalledWith(expect.objectContaining({
      heartbeatIntervalMin: 45,
      heartbeatActiveLookbackHours: 12,
    }));
    expect(reconfigure).toHaveBeenCalledWith({
      intervalMin: 45,
      activeLookbackHours: 12,
    });
    expect(webClient.chat.update).toHaveBeenCalledWith({
      channel: "C123",
      ts: "placeholder.123",
      text: "設定を更新しました。",
      blocks: expect.any(Array),
    });
  });
});
