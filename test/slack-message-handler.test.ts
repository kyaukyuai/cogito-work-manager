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
    conversations: {
      replies: vi.fn().mockResolvedValue({ messages: [] }),
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
    vi.unstubAllGlobals();
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

  it("suppresses plain non-bot mentions without invoking manager handling", async () => {
    const { createSlackMessageHandler } = await import("../src/runtime/slack-message-handler.js");
    const webClient = createWebClient();
    const logger = createLogger();
    let pendingJob: Promise<void> | undefined;

    const handler = createSlackMessageHandler({
      config: buildConfig(),
      logger: logger as never,
      webClient,
      systemPaths: {} as never,
      managerRepositories: {
        policy: { load: vi.fn() },
      } as never,
      slackTeamId: "T123",
      setManagerPolicy: vi.fn(),
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
      text: "<@U456> 契約書ですがこちらご確認頂けますと！",
    }, "UBOT");

    await vi.runAllTimersAsync();

    expect(pendingJob).toBeUndefined();
    expect(managerMocks.handleManagerMessage).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "Ignored Slack message with non-bot mention and no Cogito mention",
      expect.objectContaining({
        channelId: "C123",
        mentionedUserIds: ["U456"],
      }),
    );
  });

  it("hydrates file_share attachments from Slack thread history before invoking manager", async () => {
    const { createSlackMessageHandler } = await import("../src/runtime/slack-message-handler.js");
    const webClient = createWebClient();
    const logger = createLogger();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Buffer.from("契約書の本文"),
    });
    vi.stubGlobal("fetch", fetchMock);
    let pendingJob: Promise<void> | undefined;

    managerMocks.handleManagerMessage.mockResolvedValue({
      handled: true,
      reply: "契約書を確認しました。",
      diagnostics: {
        agent: {
          source: "agent",
          intent: "query",
          toolCalls: [],
          proposalCount: 0,
          invalidProposalCount: 0,
          committedCommands: [],
          commitRejections: [],
          missingQuerySnapshot: false,
        },
      },
    });
    webClient.conversations.replies.mockResolvedValue({
      messages: [
        {
          ts: "111.666",
          files: [
            {
              id: "F123",
              name: "contract.txt",
              mimetype: "text/plain",
              url_private_download: "https://files.example/contract.txt",
            },
          ],
        },
      ],
    });

    const handler = createSlackMessageHandler({
      config: buildConfig(),
      logger: logger as never,
      webClient,
      systemPaths: {} as never,
      managerRepositories: {
        policy: { load: vi.fn().mockResolvedValue({ heartbeatEnabled: false, heartbeatIntervalMin: 30, heartbeatActiveLookbackHours: 24 }) },
      } as never,
      slackTeamId: "T123",
      setManagerPolicy: vi.fn(),
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
      thread_ts: "111.000",
      subtype: "file_share",
      text: "契約書ですがこちらご確認頂けますと！",
    }, "UBOT");

    await vi.runAllTimersAsync();
    await pendingJob;

    expect(webClient.conversations.replies).toHaveBeenCalledWith({
      channel: "C123",
      ts: "111.000",
      inclusive: true,
      limit: 200,
    });
    expect(fetchMock).toHaveBeenCalledWith("https://files.example/contract.txt", expect.any(Object));
    expect(managerMocks.handleManagerMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        attachments: [
          expect.objectContaining({
            name: "contract.txt",
            kind: "document",
            extractionStatus: "completed",
          }),
        ],
      }),
      expect.anything(),
      undefined,
      expect.anything(),
    );
    expect(threadWorkspaceMocks.appendThreadLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "user",
        attachments: [
          expect.objectContaining({
            name: "contract.txt",
            kind: "document",
            catalogId: expect.any(String),
          }),
        ],
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "Hydrated Slack attachment metadata from thread history",
      expect.objectContaining({
        channelId: "C123",
        threadTs: "111.000",
      }),
    );
  });

  it("hydrates attachments from thread history when event file metadata is incomplete", async () => {
    const { createSlackMessageHandler } = await import("../src/runtime/slack-message-handler.js");
    const webClient = createWebClient();
    const logger = createLogger();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Buffer.from("# Soul\n不足分を追記する"),
    });
    vi.stubGlobal("fetch", fetchMock);
    let pendingJob: Promise<void> | undefined;

    managerMocks.handleManagerMessage.mockResolvedValue({
      handled: true,
      reply: "添付を確認しました。",
      diagnostics: {
        agent: {
          source: "agent",
          intent: "query",
          toolCalls: [],
          proposalCount: 0,
          invalidProposalCount: 0,
          committedCommands: [],
          commitRejections: [],
          missingQuerySnapshot: false,
        },
      },
    });
    webClient.conversations.replies.mockResolvedValue({
      messages: [
        {
          ts: "1774852504.304879",
          files: [
            {
              id: "F999",
              name: "kanazawa_clone_soul (1).md",
              mimetype: "text/plain",
              url_private_download: "https://files.example/kanazawa_clone_soul.md",
            },
          ],
        },
      ],
    });

    const handler = createSlackMessageHandler({
      config: buildConfig(),
      logger: logger as never,
      webClient,
      systemPaths: {} as never,
      managerRepositories: {
        policy: { load: vi.fn().mockResolvedValue({ heartbeatEnabled: false, heartbeatIntervalMin: 30, heartbeatActiveLookbackHours: 24 }) },
      } as never,
      slackTeamId: "T123",
      setManagerPolicy: vi.fn(),
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
      ts: "1774852504.304879",
      thread_ts: "1774851744.248639",
      text: "こちらが修正版です",
      files: [
        {
          id: "F999",
          name: "kanazawa_clone_soul (1).md",
          mimetype: "text/plain",
        },
      ],
    }, "UBOT");

    await vi.runAllTimersAsync();
    await pendingJob;

    expect(webClient.conversations.replies).toHaveBeenCalledWith({
      channel: "C123",
      ts: "1774851744.248639",
      inclusive: true,
      limit: 200,
    });
    expect(fetchMock).toHaveBeenCalledWith("https://files.example/kanazawa_clone_soul.md", expect.any(Object));
    expect(managerMocks.handleManagerMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        attachments: [
          expect.objectContaining({
            name: "kanazawa_clone_soul (1).md",
            kind: "document",
            extractionStatus: "completed",
          }),
        ],
      }),
      expect.anything(),
      undefined,
      expect.anything(),
    );
    expect(threadWorkspaceMocks.appendThreadLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "user",
        attachments: [
          expect.objectContaining({
            name: "kanazawa_clone_soul (1).md",
            kind: "document",
            catalogId: expect.any(String),
          }),
        ],
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "Hydrated Slack attachment metadata from thread history",
      expect.objectContaining({
        channelId: "C123",
        threadTs: "1774851744.248639",
        messageTs: "1774852504.304879",
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "Attachment metadata incomplete on Slack event",
      expect.objectContaining({
        channelId: "C123",
        threadTs: "1774851744.248639",
        messageTs: "1774852504.304879",
      }),
    );
  });
});
