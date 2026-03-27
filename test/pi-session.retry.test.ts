import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureManagerStateFiles } from "../src/lib/manager-state.js";
import { buildSystemPaths } from "../src/lib/system-workspace.js";
import { buildThreadPaths, ensureThreadWorkspace } from "../src/lib/thread-workspace.js";

const DEFAULT_FAILURE_MESSAGE = "429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"This request would exceed your account's rate limit. Please try again later.\"},\"request_id\":\"req_retry_test\"}";

const codingAgentMocks = vi.hoisted(() => ({
  scenarios: [] as Array<{
    requiredRetries?: number;
    successReply?: string;
    failureMessage?: string;
    textDeltas?: string[];
    toolExecutions?: Array<{
      toolName: string;
      details?: unknown;
      isError?: boolean;
    }>;
  }>,
  settingsSnapshots: [] as Array<{
    retrySettings: {
      enabled: boolean;
      maxRetries: number;
      baseDelayMs: number;
      maxDelayMs: number;
    };
    sessionKind: "thread" | "isolated";
  }>,
}));

vi.mock("@mariozechner/pi-coding-agent", () => {
  const fakeModel = {
    provider: "anthropic",
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  };

  class FakeSettingsManager {
    private readonly settings: {
      defaultThinkingLevel?: string;
      retry?: {
        enabled?: boolean;
        maxRetries?: number;
        baseDelayMs?: number;
        maxDelayMs?: number;
      };
    };

    constructor(settings: {
      defaultThinkingLevel?: string;
      retry?: {
        enabled?: boolean;
        maxRetries?: number;
        baseDelayMs?: number;
        maxDelayMs?: number;
      };
    }) {
      this.settings = settings;
    }

    static inMemory(settings: {
      defaultThinkingLevel?: string;
      retry?: {
        enabled?: boolean;
        maxRetries?: number;
        baseDelayMs?: number;
        maxDelayMs?: number;
      };
    }): FakeSettingsManager {
      return new FakeSettingsManager(settings);
    }

    getRetrySettings() {
      return {
        enabled: this.settings.retry?.enabled ?? true,
        maxRetries: this.settings.retry?.maxRetries ?? 3,
        baseDelayMs: this.settings.retry?.baseDelayMs ?? 2000,
        maxDelayMs: this.settings.retry?.maxDelayMs ?? 60_000,
      };
    }

    getDefaultThinkingLevel(): string | undefined {
      return this.settings.defaultThinkingLevel;
    }
  }

  class FakeDefaultResourceLoader {
    constructor(_args: unknown) {}

    async reload(): Promise<void> {}
  }

  class FakeAuthStorage {
    static create(_path: string): FakeAuthStorage {
      return new FakeAuthStorage();
    }

    setRuntimeApiKey(_provider: string, _apiKey: string): void {}

    has(_provider: string): boolean {
      return false;
    }
  }

  class FakeModelRegistry {
    constructor(_authStorage: FakeAuthStorage) {}

    find(provider: string, modelId: string) {
      return provider === "anthropic" && modelId === fakeModel.id ? fakeModel : undefined;
    }

    async getAvailable() {
      return [fakeModel];
    }

    async getApiKey(_model: typeof fakeModel): Promise<string> {
      return "anthropic-test";
    }

    isUsingOAuth(_model: typeof fakeModel): boolean {
      return false;
    }
  }

  class FakeSessionManager {
    static open(path: string, _sessionDir?: string) {
      return { path };
    }
  }

  async function createAgentSession(args: {
    settingsManager: FakeSettingsManager;
    customTools?: unknown[];
  }) {
    const scenario = codingAgentMocks.scenarios.shift();
    if (!scenario) {
      throw new Error("Missing test scenario for createAgentSession");
    }

    const listeners: Array<(event: unknown) => void> = [];
    const session = {
      messages: [] as Array<Record<string, unknown>>,
      agent: {
        waitForIdle: vi.fn(async () => undefined),
        streamFn: undefined as unknown,
      },
      subscribe(listener: (event: unknown) => void) {
        listeners.push(listener);
        return () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        };
      },
      prompt: vi.fn(async (_prompt: string) => {
        const retrySettings = args.settingsManager.getRetrySettings();
        codingAgentMocks.settingsSnapshots.push({
          retrySettings,
          sessionKind: (args.customTools?.length ?? 0) > 0 ? "thread" : "isolated",
        });

        const requiredRetries = scenario.requiredRetries ?? retrySettings.maxRetries + 1;
        if (scenario.successReply && retrySettings.maxRetries >= requiredRetries) {
          for (const toolExecution of scenario.toolExecutions ?? []) {
            for (const listener of listeners) {
              listener({
                type: "tool_execution_end",
                toolName: toolExecution.toolName,
                isError: toolExecution.isError ?? false,
                result: {
                  details: toolExecution.details,
                },
              });
            }
          }
          for (const delta of scenario.textDeltas ?? [scenario.successReply]) {
            for (const listener of listeners) {
              listener({
                type: "message_update",
                assistantMessageEvent: {
                  type: "text_delta",
                  delta,
                },
              });
            }
          }
          session.messages.push({
            role: "assistant",
            stopReason: "end_turn",
            content: [{ type: "text", text: scenario.successReply }],
          });
          return;
        }

        session.messages.push({
          role: "assistant",
          stopReason: "error",
          provider: "anthropic",
          errorMessage: scenario.failureMessage ?? DEFAULT_FAILURE_MESSAGE,
          content: [],
        });
      }),
      dispose: vi.fn(),
    };

    return { session };
  }

  return {
    AuthStorage: FakeAuthStorage,
    createAgentSession,
    DefaultResourceLoader: FakeDefaultResourceLoader,
    ModelRegistry: FakeModelRegistry,
    SessionManager: FakeSessionManager,
    SettingsManager: FakeSettingsManager,
  };
});

function buildConfig(workspaceDir: string) {
  return {
    slackAppToken: "xapp-test",
    slackBotToken: "xoxb-test",
    slackAllowedChannelIds: new Set(["C0ALAMDRB9V"]),
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

describe("pi-session fixed retry policy", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.resetModules();
    codingAgentMocks.scenarios.splice(0);
    codingAgentMocks.settingsSnapshots.splice(0);
  });

  afterEach(async () => {
    const piSession = await import("../src/lib/pi-session.js");
    await piSession.disposeAllThreadRuntimes();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("recovers a manager agent turn after two retryable attempts", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "pi-session-thread-retry-"));
    tempDirs.push(workspaceDir);
    await ensureManagerStateFiles(buildSystemPaths(workspaceDir));

    const threadPaths = buildThreadPaths(workspaceDir, "C0ALAMDRB9V", "thread-retry");
    await ensureThreadWorkspace(threadPaths);

    codingAgentMocks.scenarios.push({
      requiredRetries: 2,
      successReply: "retry recovered reply",
    });

    const piSession = await import("../src/lib/pi-session.js");
    const result = await piSession.runManagerAgentTurn(buildConfig(workspaceDir), threadPaths, {
      kind: "message",
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-retry",
      messageTs: "thread-retry",
      userId: "U123",
      text: "タスク一覧を教えて",
      currentDate: "2026-03-27",
      currentDateTimeJst: "2026-03-27 10:34 JST",
    });

    expect(result.reply).toBe("retry recovered reply");
    expect(codingAgentMocks.settingsSnapshots).toContainEqual({
      retrySettings: {
        enabled: true,
        maxRetries: 2,
        baseDelayMs: 2000,
        maxDelayMs: 60000,
      },
      sessionKind: "thread",
    });
  });

  it("recovers an isolated planner turn after two retryable attempts", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "pi-session-isolated-retry-"));
    tempDirs.push(workspaceDir);
    await ensureManagerStateFiles(buildSystemPaths(workspaceDir));

    const threadPaths = buildThreadPaths(workspaceDir, "C0ALAMDRB9V", "isolated-retry");
    await ensureThreadWorkspace(threadPaths);

    codingAgentMocks.scenarios.push({
      requiredRetries: 2,
      successReply: JSON.stringify({
        action: "conversation",
        conversationKind: "greeting",
        confidence: 0.9,
        reasoningSummary: "挨拶です。",
      }),
    });

    const piSession = await import("../src/lib/pi-session.js");
    const result = await piSession.runMessageRouterTurn(buildConfig(workspaceDir), threadPaths, {
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "isolated-retry",
      userId: "U123",
      messageText: "おはよう",
      currentDate: "2026-03-27",
      recentThreadEntries: [],
    });

    expect(result).toMatchObject({
      action: "conversation",
      conversationKind: "greeting",
      confidence: 0.9,
    });
    expect(codingAgentMocks.settingsSnapshots).toContainEqual({
      retrySettings: {
        enabled: true,
        maxRetries: 2,
        baseDelayMs: 2000,
        maxDelayMs: 60000,
      },
      sessionKind: "isolated",
    });
  });

  it("surfaces a provider failure when the fixed retry budget is exhausted", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "pi-session-retry-fail-"));
    tempDirs.push(workspaceDir);
    await ensureManagerStateFiles(buildSystemPaths(workspaceDir));

    const threadPaths = buildThreadPaths(workspaceDir, "C0ALAMDRB9V", "thread-retry-fail");
    await ensureThreadWorkspace(threadPaths);

    codingAgentMocks.scenarios.push({
      requiredRetries: 3,
      successReply: "should never succeed",
      failureMessage: DEFAULT_FAILURE_MESSAGE,
    });

    const piSession = await import("../src/lib/pi-session.js");
    await expect(piSession.runManagerAgentTurn(buildConfig(workspaceDir), threadPaths, {
      kind: "message",
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-retry-fail",
      messageTs: "thread-retry-fail",
      userId: "U123",
      text: "タスク一覧を教えて",
      currentDate: "2026-03-27",
      currentDateTimeJst: "2026-03-27 10:34 JST",
    })).rejects.toMatchObject({
      name: "LlmProviderFailureError",
      failure: {
        provider: "anthropic",
        statusCode: 429,
        providerErrorType: "rate_limit_error",
      },
    });

    expect(codingAgentMocks.settingsSnapshots).toContainEqual({
      retrySettings: {
        enabled: true,
        maxRetries: 2,
        baseDelayMs: 2000,
        maxDelayMs: 60000,
      },
      sessionKind: "thread",
    });
  });

  it("notifies manager agent observers about intent reports and text deltas", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "pi-session-observer-"));
    tempDirs.push(workspaceDir);
    await ensureManagerStateFiles(buildSystemPaths(workspaceDir));

    const threadPaths = buildThreadPaths(workspaceDir, "C0ALAMDRB9V", "thread-observer");
    await ensureThreadWorkspace(threadPaths);

    codingAgentMocks.scenarios.push({
      requiredRetries: 0,
      successReply: "ストリーミング返信です。",
      textDeltas: ["ストリーミング", "返信です。"],
      toolExecutions: [{
        toolName: "report_manager_intent",
        details: {
          intentReport: {
            intent: "conversation",
            conversationKind: "smalltalk",
            confidence: 0.88,
            summary: "雑談です。",
          },
        },
      }],
    });

    const piSession = await import("../src/lib/pi-session.js");
    const observedReports: Array<Record<string, unknown>> = [];
    const observedDeltas: string[] = [];
    const result = await piSession.runManagerAgentTurn(
      buildConfig(workspaceDir),
      threadPaths,
      {
        kind: "message",
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-observer",
        messageTs: "thread-observer",
        userId: "U123",
        text: "こんにちは",
        currentDate: "2026-03-27",
        currentDateTimeJst: "2026-03-27 11:30 JST",
      },
      {
        onIntentReport: (report) => {
          observedReports.push(report);
        },
        onTextDelta: (delta) => {
          observedDeltas.push(delta);
        },
      },
    );

    expect(result.reply).toBe("ストリーミング返信です。");
    expect(observedReports).toEqual([{
      intent: "conversation",
      conversationKind: "smalltalk",
      confidence: 0.88,
      summary: "雑談です。",
    }]);
    expect(observedDeltas).toEqual(["ストリーミング", "返信です。"]);
  });
});
