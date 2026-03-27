import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("../src/lib/slack-replies.js", () => slackReplyMocks);
vi.mock("../src/orchestrators/webhooks/handle-issue-created.js", () => webhookOrchestratorMocks);

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
  });

  afterEach(() => {
    vi.clearAllMocks();
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
      config: buildConfig(),
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
      config: buildConfig(),
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
});
