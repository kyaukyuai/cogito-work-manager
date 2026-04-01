import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnerMap } from "../src/state/manager-state-contract.js";

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

const coordinationHintMocks = vi.hoisted(() => ({
  resolveExternalCoordinationHint: vi.fn(),
  saveExternalCoordinationHint: vi.fn(),
}));

const plannerMocks = vi.hoisted(() => ({
  runOtherDirectedMessageTurn: vi.fn(),
}));

vi.mock("../src/lib/manager.js", () => ({
  handleManagerMessage: managerMocks.handleManagerMessage,
}));

vi.mock("../src/lib/pi-session.js", () => ({
  runOtherDirectedMessageTurn: plannerMocks.runOtherDirectedMessageTurn,
}));

vi.mock("../src/lib/thread-workspace.js", () => ({
  appendThreadLog: threadWorkspaceMocks.appendThreadLog,
  buildThreadPaths: threadWorkspaceMocks.buildThreadPaths,
  ensureThreadWorkspace: threadWorkspaceMocks.ensureThreadWorkspace,
}));

vi.mock("../src/lib/external-coordination-hint.js", () => ({
  resolveExternalCoordinationHint: coordinationHintMocks.resolveExternalCoordinationHint,
  saveExternalCoordinationHint: coordinationHintMocks.saveExternalCoordinationHint,
}));

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

function buildOwnerMap(): OwnerMap {
  return {
    defaultOwner: "kyaukyuai",
    entries: [
      {
        id: "m.tahira",
        domains: [],
        keywords: ["田平", "田平誠人"],
        linearAssignee: "m.tahira@opt.ne.jp",
        slackUserId: "U456",
        primary: false,
      },
      {
        id: "kyaukyuai",
        domains: [],
        keywords: ["金澤"],
        linearAssignee: "kyaukyuai",
        slackUserId: "U789",
        primary: true,
      },
    ],
  };
}

describe("slack message handler", () => {
  let temporaryWorkspaceDir: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    managerMocks.handleManagerMessage.mockReset();
    threadWorkspaceMocks.appendThreadLog.mockReset();
    threadWorkspaceMocks.buildThreadPaths.mockClear();
    threadWorkspaceMocks.ensureThreadWorkspace.mockClear();
    coordinationHintMocks.resolveExternalCoordinationHint.mockReset().mockResolvedValue({
      diagnostics: [],
    });
    coordinationHintMocks.saveExternalCoordinationHint.mockReset();
    plannerMocks.runOtherDirectedMessageTurn.mockReset();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterEach(async () => {
    if (temporaryWorkspaceDir) {
      await rm(temporaryWorkspaceDir, { recursive: true, force: true });
      temporaryWorkspaceDir = undefined;
    }
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

    expect(policyLoad).toHaveBeenCalledTimes(2);
    expect(setManagerPolicy).toHaveBeenCalledWith(expect.objectContaining({
      heartbeatIntervalMin: 45,
      heartbeatActiveLookbackHours: 12,
    }));
    expect(reconfigure).toHaveBeenCalledWith({
      intervalMin: 45,
      activeLookbackHours: 12,
    });
    expect(webClient.chat.postMessage).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "111.666",
      text: "設定を更新しました。",
      blocks: expect.any(Array),
    });
    expect(webClient.chat.update).not.toHaveBeenCalled();
  });

  it("suppresses plain non-bot mentions publicly while persisting an external coordination hint", async () => {
    const { createSlackMessageHandler } = await import("../src/runtime/slack-message-handler.js");
    const webClient = createWebClient();
    const logger = createLogger();
    let pendingJob: Promise<void> | undefined;
    coordinationHintMocks.resolveExternalCoordinationHint.mockResolvedValueOnce({
      hint: {
        issueId: "AIC-55",
        issueTitle: "契約締結対応",
        targetSlackUserId: "U456",
        sourceMessageTs: "111.666",
        sourceUserId: "U123",
        requestText: "契約書ですがこちらご確認頂けますと！",
        attachmentNames: ["contract.docx"],
        resolutionSummary: "既存の契約締結対応 issue に一致しました。",
        recordedAt: "2026-03-31T01:36:00.000Z",
      },
      diagnostics: [],
    });

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
    await pendingJob;

    expect(managerMocks.handleManagerMessage).not.toHaveBeenCalled();
    expect(plannerMocks.runOtherDirectedMessageTurn).not.toHaveBeenCalled();
    expect(threadWorkspaceMocks.ensureThreadWorkspace).toHaveBeenCalled();
    expect(threadWorkspaceMocks.appendThreadLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "user",
        text: "<@U456> 契約書ですがこちらご確認頂けますと！",
      }),
    );
    expect(coordinationHintMocks.resolveExternalCoordinationHint).toHaveBeenCalledWith(
      expect.objectContaining({
        requestText: "<@U456> 契約書ですがこちらご確認頂けますと！",
        resolvedTarget: {
          slackUserId: "U456",
          resolutionSummary: "Resolved target from explicit Slack user mention",
        },
      }),
    );
    expect(coordinationHintMocks.saveExternalCoordinationHint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        issueId: "AIC-55",
        targetSlackUserId: "U456",
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "Ignored Slack message with non-bot mention and no Cogito mention",
      expect.objectContaining({
        channelId: "C123",
        mentionedUserIds: ["U456"],
      }),
    );
    expect(webClient.chat.postMessage).not.toHaveBeenCalled();
  });

  it("suppresses plain-text direct-address messages when the classifier returns to_other_person", async () => {
    const { createSlackMessageHandler } = await import("../src/runtime/slack-message-handler.js");
    const webClient = createWebClient();
    const logger = createLogger();
    let pendingJob: Promise<void> | undefined;
    plannerMocks.runOtherDirectedMessageTurn.mockResolvedValueOnce({
      classification: "to_other_person",
      confidence: 0.82,
      selectedOwnerEntryId: "m.tahira",
      reasoningSummary: "The message is directed to Tahira-san for contract review.",
    });
    coordinationHintMocks.resolveExternalCoordinationHint.mockResolvedValueOnce({
      hint: {
        issueId: "AIC-55",
        issueTitle: "契約締結対応",
        targetSlackUserId: "U456",
        sourceMessageTs: "111.778",
        sourceUserId: "U123",
        requestText: "(test) 田平さん、契約書ですがこちらご確認ください。",
        attachmentNames: [],
        resolutionSummary: "Resolved target from plain-text owner-map match",
        recordedAt: "2026-03-31T01:36:00.000Z",
      },
      diagnostics: [],
    });

    const handler = createSlackMessageHandler({
      config: buildConfig(),
      logger: logger as never,
      webClient,
      systemPaths: {} as never,
      managerRepositories: {
        policy: { load: vi.fn() },
        ownerMap: { load: vi.fn().mockResolvedValue(buildOwnerMap()) },
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
      ts: "111.778",
      text: "(test) 田平さん、契約書ですがこちらご確認ください。",
    }, "UBOT");

    await vi.runAllTimersAsync();
    await pendingJob;

    expect(managerMocks.handleManagerMessage).not.toHaveBeenCalled();
    expect(plannerMocks.runOtherDirectedMessageTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        messageText: "(test) 田平さん、契約書ですがこちらご確認ください。",
        assistantName: "コギト",
        recentThreadEntries: [],
        ownerEntries: expect.arrayContaining([
          expect.objectContaining({ entryId: "m.tahira", linearAssignee: "m.tahira@opt.ne.jp" }),
        ]),
      }),
    );
    expect(coordinationHintMocks.resolveExternalCoordinationHint).toHaveBeenCalledWith(
      expect.objectContaining({
        requestText: "(test) 田平さん、契約書ですがこちらご確認ください。",
        resolvedTarget: {
          slackUserId: "U456",
          resolutionSummary: "Resolved target from LLM-first plain-text classification (entryId=m.tahira; confidence=0.82)",
        },
      }),
    );
    expect(coordinationHintMocks.saveExternalCoordinationHint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        issueId: "AIC-55",
        targetSlackUserId: "U456",
      }),
    );
    expect(webClient.chat.postMessage).not.toHaveBeenCalled();
    expect(webClient.chat.update).not.toHaveBeenCalled();
    expect(webClient.chat.delete).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "Ignored Slack message clearly directed at another person with no Cogito mention",
      expect.objectContaining({
        channelId: "C123",
        selectedOwnerEntryId: "m.tahira",
        confidence: 0.82,
        classification: "to_other_person",
      }),
    );
  });

  it("lazy-recovers legacy system thread context from the actual root Slack post before manager handling", async () => {
    temporaryWorkspaceDir = await mkdtemp(join(tmpdir(), "cogito-slack-handler-"));
    const { createSlackMessageHandler } = await import("../src/runtime/slack-message-handler.js");
    const webClient = createWebClient();
    const logger = createLogger();
    let pendingJob: Promise<void> | undefined;
    plannerMocks.runOtherDirectedMessageTurn.mockResolvedValueOnce({
      classification: "to_cogito",
      confidence: 0.88,
      reasoningSummary: "This is a follow-up for Cogito to process, not a direct outbound message.",
    });
    managerMocks.handleManagerMessage.mockResolvedValueOnce({
      handled: true,
      reply: "AIC-87 の優先度を Low に下げました。議事録連携に対応する issue は見当たらないため、必要なら別 issue として起票してください。",
      diagnostics: {
        agent: {
          source: "agent",
          intent: "update_progress",
          toolCalls: [],
          proposalCount: 1,
          invalidProposalCount: 0,
          committedCommands: ["update_issue_priority"],
          commitRejections: [],
          missingQuerySnapshot: false,
        },
      },
    });
    webClient.conversations.replies = vi.fn().mockResolvedValue({
      messages: [
        {
          ts: "1774944062.253979",
          user: "UBOT",
          text: [
            ":city_sunset: 夕方レビュー (2026-03-31)",
            "AIC-86/87（役員チャンネル招待・MTG定例名確認）: m.tahira アサイン済みだが stale 1日。今週中の着手確認を推奨",
          ].join("\n"),
        },
      ],
    });

    const handler = createSlackMessageHandler({
      config: buildConfig(temporaryWorkspaceDir),
      logger: logger as never,
      webClient,
      systemPaths: {} as never,
      managerRepositories: {
        policy: { load: vi.fn() },
        ownerMap: { load: vi.fn().mockResolvedValue(buildOwnerMap()) },
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
      ts: "1775010000.000001",
      thread_ts: "1774944062.253979",
      text: "取得すべきmtg定例の名前と議事録連携は、後回しになりました",
    }, "UBOT");

    await vi.runAllTimersAsync();
    await pendingJob;

    expect(webClient.conversations.replies).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        ts: "1774944062.253979",
      }),
    );
    expect(managerMocks.handleManagerMessage).toHaveBeenCalledTimes(1);
    expect(managerMocks.handleManagerMessage.mock.calls[0]?.[2]).toMatchObject({
      rootThreadTs: "1774944062.253979",
      text: "取得すべきmtg定例の名前と議事録連携は、後回しになりました",
    });
  });

  it("suppresses plain-text direct-address messages without saving a hint when the selected owner has no slackUserId", async () => {
    const { createSlackMessageHandler } = await import("../src/runtime/slack-message-handler.js");
    const webClient = createWebClient();
    const logger = createLogger();
    let pendingJob: Promise<void> | undefined;
    plannerMocks.runOtherDirectedMessageTurn.mockResolvedValueOnce({
      classification: "to_other_person",
      confidence: 0.77,
      selectedOwnerEntryId: "m.tahira",
      reasoningSummary: "The latest message is clearly directed to Tahira-san.",
    });
    coordinationHintMocks.resolveExternalCoordinationHint.mockResolvedValueOnce({
      diagnostics: [
        {
          level: "info",
          message: "Skipped external coordination hint because the resolved target has no slackUserId (Resolved target from LLM-first plain-text classification (entryId=m.tahira; confidence=0.77))",
        },
      ],
    });

    const ownerMap = buildOwnerMap();
    ownerMap.entries[0]!.slackUserId = undefined;

    const handler = createSlackMessageHandler({
      config: buildConfig(),
      logger: logger as never,
      webClient,
      systemPaths: {} as never,
      managerRepositories: {
        policy: { load: vi.fn() },
        ownerMap: { load: vi.fn().mockResolvedValue(ownerMap) },
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
      ts: "111.779",
      text: "田平さん、こちらご確認ください。",
    }, "UBOT");

    await vi.runAllTimersAsync();
    await pendingJob;

    expect(managerMocks.handleManagerMessage).not.toHaveBeenCalled();
    expect(coordinationHintMocks.saveExternalCoordinationHint).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Skipped external coordination hint because the resolved target has no slackUserId"),
      expect.objectContaining({
        channelId: "C123",
        threadTs: "111.779",
        messageTs: "111.779",
      }),
    );
  });

  it("suppresses publicly without creating a hint when the classifier selects no owner entry", async () => {
    const { createSlackMessageHandler } = await import("../src/runtime/slack-message-handler.js");
    const webClient = createWebClient();
    const logger = createLogger();
    let pendingJob: Promise<void> | undefined;
    plannerMocks.runOtherDirectedMessageTurn.mockResolvedValueOnce({
      classification: "to_other_person",
      confidence: 0.74,
      reasoningSummary: "This looks directed to another person, but no owner-map candidate is reliable.",
    });
    coordinationHintMocks.resolveExternalCoordinationHint.mockResolvedValueOnce({
      diagnostics: [
        {
          level: "info",
          message: "Skipped external coordination hint because no resolved target was available",
        },
      ],
    });

    const handler = createSlackMessageHandler({
      config: buildConfig(),
      logger: logger as never,
      webClient,
      systemPaths: {} as never,
      managerRepositories: {
        policy: { load: vi.fn() },
        ownerMap: { load: vi.fn().mockResolvedValue(buildOwnerMap()) },
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
      ts: "111.781",
      text: "山田さん、こちらご確認ください。",
    }, "UBOT");

    await vi.runAllTimersAsync();
    await pendingJob;

    expect(managerMocks.handleManagerMessage).not.toHaveBeenCalled();
    expect(coordinationHintMocks.saveExternalCoordinationHint).not.toHaveBeenCalled();
    expect(coordinationHintMocks.resolveExternalCoordinationHint).toHaveBeenCalledWith(
      expect.objectContaining({
        resolvedTarget: undefined,
      }),
    );
  });

  it("falls back to normal manager handling when the classifier says unclear", async () => {
    const { createSlackMessageHandler } = await import("../src/runtime/slack-message-handler.js");
    const webClient = createWebClient();
    const logger = createLogger();
    let pendingJob: Promise<void> | undefined;
    plannerMocks.runOtherDirectedMessageTurn.mockResolvedValueOnce({
      classification: "unclear",
      confidence: 0.58,
      reasoningSummary: "The message could be directed to Cogito or another person.",
    });

    managerMocks.handleManagerMessage.mockResolvedValue({
      handled: true,
      reply: "対応します。",
      diagnostics: {
        agent: {
          source: "agent",
          intent: "conversation",
          toolCalls: [],
          proposalCount: 0,
          invalidProposalCount: 0,
          committedCommands: [],
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
        policy: { load: vi.fn().mockResolvedValue({ heartbeatEnabled: false, heartbeatIntervalMin: 30, heartbeatActiveLookbackHours: 24 }) },
        ownerMap: { load: vi.fn().mockResolvedValue(buildOwnerMap()) },
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
      ts: "111.782",
      text: "田平さん、これはどうすればいいですか？",
    }, "UBOT");

    await vi.runAllTimersAsync();
    await pendingJob;

    expect(managerMocks.handleManagerMessage).toHaveBeenCalledTimes(1);
    expect(coordinationHintMocks.resolveExternalCoordinationHint).not.toHaveBeenCalled();
  });

  it("falls back to normal manager handling when plain-text classification fails", async () => {
    const { createSlackMessageHandler } = await import("../src/runtime/slack-message-handler.js");
    const webClient = createWebClient();
    const logger = createLogger();
    let pendingJob: Promise<void> | undefined;
    plannerMocks.runOtherDirectedMessageTurn.mockRejectedValueOnce(new Error("planner parse failed"));

    managerMocks.handleManagerMessage.mockResolvedValue({
      handled: true,
      reply: "確認します。",
      diagnostics: {
        agent: {
          source: "agent",
          intent: "conversation",
          toolCalls: [],
          proposalCount: 0,
          invalidProposalCount: 0,
          committedCommands: [],
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
        policy: { load: vi.fn().mockResolvedValue({ heartbeatEnabled: false, heartbeatIntervalMin: 30, heartbeatActiveLookbackHours: 24 }) },
        ownerMap: { load: vi.fn().mockResolvedValue(buildOwnerMap()) },
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
      ts: "111.783",
      text: "田平さん、契約書ですがこちらご確認ください。",
    }, "UBOT");

    await vi.runAllTimersAsync();
    await pendingJob;

    expect(logger.warn).toHaveBeenCalledWith(
      "Plain-text other-directed message classification failed",
      expect.objectContaining({
        channelId: "C123",
        messageTs: "111.783",
      }),
    );
    expect(managerMocks.handleManagerMessage).toHaveBeenCalledTimes(1);
  });

  it("routes explicit outbound-post requests through the classifier and then through manager handling", async () => {
    const { createSlackMessageHandler } = await import("../src/runtime/slack-message-handler.js");
    const webClient = createWebClient();
    const logger = createLogger();
    let pendingJob: Promise<void> | undefined;
    plannerMocks.runOtherDirectedMessageTurn.mockResolvedValueOnce({
      classification: "to_cogito",
      confidence: 0.91,
      reasoningSummary: "This is an explicit request for Cogito to send a message on the user's behalf.",
    });

    managerMocks.handleManagerMessage.mockResolvedValue({
      handled: true,
      reply: "送信します。",
      diagnostics: {
        agent: {
          source: "agent",
          intent: "post_slack_message",
          toolCalls: [],
          proposalCount: 1,
          invalidProposalCount: 0,
          committedCommands: [],
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
        policy: { load: vi.fn().mockResolvedValue({ heartbeatEnabled: false, heartbeatIntervalMin: 30, heartbeatActiveLookbackHours: 24 }) },
        ownerMap: { load: vi.fn().mockResolvedValue(buildOwnerMap()) },
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
      ts: "111.780",
      text: "田平さんにメンションして契約書確認をお願いしてと送って",
    }, "UBOT");

    await vi.runAllTimersAsync();
    await pendingJob;

    expect(managerMocks.handleManagerMessage).toHaveBeenCalledTimes(1);
    expect(plannerMocks.runOtherDirectedMessageTurn).toHaveBeenCalledTimes(1);
    expect(coordinationHintMocks.resolveExternalCoordinationHint).not.toHaveBeenCalled();
  });

  it("keeps ignored coordination posts silent when no exact issue hint is available", async () => {
    const { createSlackMessageHandler } = await import("../src/runtime/slack-message-handler.js");
    const webClient = createWebClient();
    const logger = createLogger();
    let pendingJob: Promise<void> | undefined;
    coordinationHintMocks.resolveExternalCoordinationHint.mockResolvedValueOnce({
      diagnostics: [
        { level: "info", message: "External coordination hint not saved (fuzzy/clarify)" },
      ],
    });

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
      ts: "111.777",
      text: "<@U456> こちら確認お願いします",
    }, "UBOT");

    await vi.runAllTimersAsync();
    await pendingJob;

    expect(managerMocks.handleManagerMessage).not.toHaveBeenCalled();
    expect(coordinationHintMocks.saveExternalCoordinationHint).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "External coordination hint not saved (fuzzy/clarify)",
      expect.objectContaining({
        channelId: "C123",
        threadTs: "111.777",
        messageTs: "111.777",
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
