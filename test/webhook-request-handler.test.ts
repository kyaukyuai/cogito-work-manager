import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildThreadPaths } from "../src/lib/thread-workspace.js";
import { loadSystemThreadContext } from "../src/lib/system-thread-context.js";

const linearWebhookMocks = vi.hoisted(() => ({
  isDuplicateWebhookDelivery: vi.fn(),
  isLoopedWebhookIssue: vi.fn(),
  parseLinearWebhookEvent: vi.fn(),
  updateWebhookDeliveryStatus: vi.fn(),
  upsertWebhookDelivery: vi.fn(),
  verifyLinearWebhookRequest: vi.fn(),
}));

const linearMocks = vi.hoisted(() => ({
  getLinearIssue: vi.fn(),
}));

const slackReplyMocks = vi.hoisted(() => ({
  sendSlackReply: vi.fn(),
}));

const webhookOrchestratorMocks = vi.hoisted(() => ({
  handleIssueCreatedWebhook: vi.fn(),
}));

vi.mock("../src/lib/linear-webhook.js", () => linearWebhookMocks);
vi.mock("../src/lib/linear.js", () => linearMocks);
vi.mock("../src/gateways/linear/issues.js", () => ({
  getLinearIssue: linearMocks.getLinearIssue,
}));
vi.mock("../src/lib/slack-replies.js", () => slackReplyMocks);
vi.mock("../src/orchestrators/webhooks/handle-issue-created.js", () => webhookOrchestratorMocks);

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
    linearWebhookEnabled: true,
    linearWebhookPublicUrl: "https://example.com",
    linearWebhookSecret: "secret",
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

function createRequest(body = "{}"): Readable & {
  url?: string;
  method?: string;
  headers: Record<string, string>;
} {
  const request = Readable.from([body]) as Readable & {
    url?: string;
    method?: string;
    headers: Record<string, string>;
  };
  request.url = "/hooks/linear";
  request.method = "POST";
  request.headers = {};
  return request;
}

function createResponse() {
  return {
    statusCode: 0,
    body: "",
    end: vi.fn(function end(this: { body: string }, body?: string) {
      this.body = body ?? "";
    }),
  };
}

describe("webhook request handler", () => {
  let workspaceDir: string;

  beforeEach(() => {
    vi.resetModules();
    linearWebhookMocks.isDuplicateWebhookDelivery.mockReset();
    linearWebhookMocks.isLoopedWebhookIssue.mockReset();
    linearWebhookMocks.parseLinearWebhookEvent.mockReset();
    linearWebhookMocks.updateWebhookDeliveryStatus.mockReset();
    linearWebhookMocks.upsertWebhookDelivery.mockReset();
    linearWebhookMocks.verifyLinearWebhookRequest.mockReset();
    linearMocks.getLinearIssue.mockReset();
    slackReplyMocks.sendSlackReply.mockReset();
    webhookOrchestratorMocks.handleIssueCreatedWebhook.mockReset();
    workspaceDir = "/tmp/cogito-runtime-test";
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (workspaceDir !== "/tmp/cogito-runtime-test") {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("marks in-flight duplicate deliveries and skips queueing", async () => {
    const { createWebhookRequestHandler } = await import("../src/runtime/webhook-request-handler.js");
    const save = vi.fn();
    const load = vi.fn().mockResolvedValue([
      { deliveryId: "delivery-1", status: "received" },
    ]);

    linearWebhookMocks.verifyLinearWebhookRequest.mockReturnValue({ ok: true });
    linearWebhookMocks.parseLinearWebhookEvent.mockReturnValue({
      kind: "issue-created",
      event: {
        deliveryId: "delivery-1",
        webhookId: "webhook-1",
        issueId: "issue-1",
        issueIdentifier: "AIC-123",
        receivedAt: "2026-03-27T07:00:00.000Z",
      },
    });
    linearWebhookMocks.isDuplicateWebhookDelivery.mockReturnValue(true);
    linearWebhookMocks.updateWebhookDeliveryStatus.mockReturnValue([
      { deliveryId: "delivery-1", status: "ignored-duplicate" },
    ]);
    const enqueue = vi.fn();

    const handler = createWebhookRequestHandler({
      config: buildConfig(workspaceDir),
      logger: createLogger() as never,
      webClient: {} as never,
      managerRepositories: {
        webhookDeliveries: { load, save },
      } as never,
      linearEnv: {},
      webhookQueue: { enqueue },
      clock: {
        currentDateInJst: () => "2026-03-27",
        currentDateTimeInJst: () => "2026-03-27 16:00 JST",
      },
      systemTaskExecutor: {
        executeCustomSchedulerJob: vi.fn(),
        executeManagerSystemTask: vi.fn(),
      },
    });

    const request = createRequest();
    const response = createResponse();
    await handler.handleWebhookRequest(request as never, response as never);

    expect(response.statusCode).toBe(200);
    expect(response.end).toHaveBeenCalledWith("ok");
    expect(save).toHaveBeenCalledWith([{ deliveryId: "delivery-1", status: "ignored-duplicate" }]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("notifies the control room when queued webhook processing fails", async () => {
    const { createWebhookRequestHandler } = await import("../src/runtime/webhook-request-handler.js");
    const deliveries = [{ deliveryId: "delivery-1", status: "received", createdIssueIds: [] }];
    const save = vi.fn();
    const load = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(deliveries);
    let queuedJob: Promise<void> | undefined;

    linearWebhookMocks.verifyLinearWebhookRequest.mockReturnValue({ ok: true });
    linearWebhookMocks.parseLinearWebhookEvent.mockReturnValue({
      kind: "issue-created",
      event: {
        deliveryId: "delivery-1",
        webhookId: "webhook-1",
        issueId: "issue-1",
        issueIdentifier: "AIC-123",
        receivedAt: "2026-03-27T07:00:00.000Z",
      },
    });
    linearWebhookMocks.isDuplicateWebhookDelivery.mockReturnValue(false);
    linearWebhookMocks.upsertWebhookDelivery.mockImplementation((_deliveries, entry) => [entry]);
    linearWebhookMocks.updateWebhookDeliveryStatus.mockReturnValue([
      { deliveryId: "delivery-1", status: "failed", reason: "boom" },
    ]);
    linearMocks.getLinearIssue.mockRejectedValue(new Error("boom"));
    slackReplyMocks.sendSlackReply.mockResolvedValue("posted");

    const handler = createWebhookRequestHandler({
      config: buildConfig(workspaceDir),
      logger: createLogger() as never,
      webClient: {} as never,
      managerRepositories: {
        policy: { load: vi.fn().mockResolvedValue({ controlRoomChannelId: "CROOM" }) },
        webhookDeliveries: { load, save },
      } as never,
      linearEnv: {},
      webhookQueue: {
        enqueue: (_key, job) => {
          queuedJob = job();
        },
      },
      clock: {
        currentDateInJst: () => "2026-03-27",
        currentDateTimeInJst: () => "2026-03-27 16:00 JST",
      },
      systemTaskExecutor: {
        executeCustomSchedulerJob: vi.fn(),
        executeManagerSystemTask: vi.fn(),
      },
    });

    const request = createRequest();
    const response = createResponse();
    await handler.handleWebhookRequest(request as never, response as never);
    await queuedJob;

    expect(response.statusCode).toBe(200);
    expect(response.end).toHaveBeenCalledWith("ok");
    expect(save).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({
        deliveryId: "delivery-1",
        status: "received",
      }),
    ]));
    expect(save).toHaveBeenCalledWith([{ deliveryId: "delivery-1", status: "failed", reason: "boom" }]);
    expect(slackReplyMocks.sendSlackReply).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        channel: "CROOM",
        reply: expect.stringContaining("AIC-123 の webhook 自動処理に失敗しました。"),
      }),
    );
  });

  it("persists actual Slack thread context for top-level webhook notifications", async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "cogito-webhook-thread-context-"));
    const { createWebhookRequestHandler } = await import("../src/runtime/webhook-request-handler.js");
    const logger = createLogger();
    const save = vi.fn();
    const load = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    let queuedJob: Promise<void> | undefined;

    linearWebhookMocks.verifyLinearWebhookRequest.mockReturnValue({ ok: true });
    linearWebhookMocks.parseLinearWebhookEvent.mockReturnValue({
      kind: "issue-created",
      event: {
        deliveryId: "delivery-1",
        webhookId: "webhook-1",
        issueId: "issue-1",
        issueIdentifier: "AIC-123",
        receivedAt: "2026-03-27T07:00:00.000Z",
      },
    });
    linearWebhookMocks.isDuplicateWebhookDelivery.mockReturnValue(false);
    linearWebhookMocks.upsertWebhookDelivery.mockImplementation((_deliveries, entry) => [entry]);
    linearWebhookMocks.updateWebhookDeliveryStatus.mockReturnValue([
      { deliveryId: "delivery-1", status: "committed", createdIssueIds: [] },
    ]);
    webhookOrchestratorMocks.handleIssueCreatedWebhook.mockResolvedValue({
      status: "committed",
      reply: "AIC-123 に初期コメントを追加しました。",
      createdIssueIds: [],
      agentResult: {
        reply: "AIC-123 に初期コメントを追加しました。",
        toolCalls: [],
        proposals: [],
        invalidProposalCount: 0,
        systemThreadContextReport: {
          sourceKind: "webhook",
          issueRefs: [{ issueId: "AIC-123", titleHint: "契約締結対応", role: "primary" }],
          summary: "webhook issue created notification",
        },
      },
    });
    linearMocks.getLinearIssue.mockResolvedValue({
      id: "issue-1",
      identifier: "AIC-123",
      title: "契約締結対応",
      url: "https://linear.app/kyaukyuai/issue/AIC-123",
      relations: [],
      inverseRelations: [],
    });
    slackReplyMocks.sendSlackReply.mockResolvedValue("posted webhook summary");

    const handler = createWebhookRequestHandler({
      config: buildConfig(workspaceDir),
      logger: logger as never,
      webClient: {} as never,
      managerRepositories: {
        policy: { load: vi.fn().mockResolvedValue({ controlRoomChannelId: "CROOM" }) },
        webhookDeliveries: { load, save },
      } as never,
      linearEnv: {},
      webhookQueue: {
        enqueue: (_key, job) => {
          queuedJob = job();
        },
      },
      clock: {
        currentDateInJst: () => "2026-03-27",
        currentDateTimeInJst: () => "2026-03-27 16:00 JST",
      },
      systemTaskExecutor: {
        executeCustomSchedulerJob: vi.fn(),
        executeManagerSystemTask: vi.fn(),
      },
    });

    const request = createRequest();
    const response = createResponse();
    await handler.handleWebhookRequest(request as never, response as never);
    await queuedJob;

    expect(slackReplyMocks.sendSlackReply).toHaveBeenCalledTimes(1);
    const postedArgs = slackReplyMocks.sendSlackReply.mock.calls[0]?.[1];
    expect(logger.error).not.toHaveBeenCalled();
    expect(postedArgs?.onPosted).toBeTypeOf("function");
    await postedArgs?.onPosted?.({
      ts: "1774949999.111111",
      text: "posted webhook summary",
    });

    const actualThreadPaths = buildThreadPaths(workspaceDir, "CROOM", "1774949999.111111");
    await expect(loadSystemThreadContext(actualThreadPaths)).resolves.toMatchObject({
      sourceKind: "webhook",
      issueRefs: [expect.objectContaining({ issueId: "AIC-123" })],
    });
  });
});
