import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { handleManagerMessage } from "../../src/lib/manager.js";
import { ensureManagerStateFiles } from "../../src/lib/manager-state.js";
import { buildSystemPaths } from "../../src/lib/system-workspace.js";
import { loadTranscriptFixture, runTranscriptFixture, type TranscriptTurnFixture } from "../helpers/transcript-harness.js";

const linearMocks = vi.hoisted(() => ({
  searchLinearIssues: vi.fn(),
  createManagedLinearIssue: vi.fn(),
  createManagedLinearIssueBatch: vi.fn(),
  updateManagedLinearIssue: vi.fn(),
  assignLinearIssue: vi.fn(),
  addLinearComment: vi.fn(),
  addLinearProgressComment: vi.fn(),
  addLinearRelation: vi.fn(),
  getLinearIssue: vi.fn(),
  markLinearIssueBlocked: vi.fn(),
  updateLinearIssueState: vi.fn(),
  listRiskyLinearIssues: vi.fn(),
}));

const slackContextMocks = vi.hoisted(() => ({
  getSlackThreadContext: vi.fn(),
  getRecentChannelContext: vi.fn(),
}));

const webResearchMocks = vi.hoisted(() => ({
  webSearchFetch: vi.fn(),
  webFetchUrl: vi.fn(),
}));

const piSessionMocks = vi.hoisted(() => ({
  runTaskPlanningTurn: vi.fn(),
  runResearchSynthesisTurn: vi.fn(),
  runFollowupResolutionTurn: vi.fn(),
}));

vi.mock("../../src/lib/linear.js", () => ({
  searchLinearIssues: linearMocks.searchLinearIssues,
  createManagedLinearIssue: linearMocks.createManagedLinearIssue,
  createManagedLinearIssueBatch: linearMocks.createManagedLinearIssueBatch,
  updateManagedLinearIssue: linearMocks.updateManagedLinearIssue,
  assignLinearIssue: linearMocks.assignLinearIssue,
  addLinearComment: linearMocks.addLinearComment,
  addLinearProgressComment: linearMocks.addLinearProgressComment,
  addLinearRelation: linearMocks.addLinearRelation,
  getLinearIssue: linearMocks.getLinearIssue,
  markLinearIssueBlocked: linearMocks.markLinearIssueBlocked,
  updateLinearIssueState: linearMocks.updateLinearIssueState,
  listRiskyLinearIssues: linearMocks.listRiskyLinearIssues,
}));

vi.mock("../../src/lib/slack-context.js", () => ({
  getSlackThreadContext: slackContextMocks.getSlackThreadContext,
  getRecentChannelContext: slackContextMocks.getRecentChannelContext,
}));

vi.mock("../../src/lib/web-research.js", () => ({
  webSearchFetch: webResearchMocks.webSearchFetch,
  webFetchUrl: webResearchMocks.webFetchUrl,
}));

vi.mock("../../src/lib/pi-session.js", () => ({
  runTaskPlanningTurn: piSessionMocks.runTaskPlanningTurn,
  runResearchSynthesisTurn: piSessionMocks.runResearchSynthesisTurn,
  runFollowupResolutionTurn: piSessionMocks.runFollowupResolutionTurn,
}));

function stripTaskTitle(text: string): string {
  return text
    .trim()
    .replace(/^<@[^>]+>\s*/, "")
    .replace(/^\s*(?:[-*・•]\s+|\d+[.)]\s+)/, "")
    .replace(/(の)?(タスク|issue|Issue|イシュー|ticket|チケット)(を)?/g, " ")
    .replace(/(しておいて|やっておいて|追加して|作成して|作って|登録して|おいて|お願い(します)?|対応して|進めておいて|進めて)/g, " ")
    .replace(/[。！!？?]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/を$/, "")
    .trim();
}

function defaultTaskPlan(input: { combinedRequest: string }): Record<string, unknown> {
  const singleTitle = stripTaskTitle(input.combinedRequest) || "Slack からの依頼";
  return {
    action: "create",
    planningReason: "single-issue",
    parentTitle: null,
    parentDueDate: undefined,
    children: [
      { title: singleTitle, kind: "execution", dueDate: undefined },
    ],
  };
}

function makeActiveIssue(overrides: Record<string, unknown> & { identifier: string; title: string }) {
  return {
    id: `issue-${overrides.identifier}`,
    url: `https://linear.app/kyaukyuai/issue/${overrides.identifier}`,
    assignee: { id: "user-1", displayName: "y.kakui" },
    state: { id: "state-started", name: "Started", type: "started" },
    relations: [],
    inverseRelations: [],
    ...overrides,
  };
}

describe("manager transcript fixtures", () => {
  let workspaceDir: string;
  let systemPaths: ReturnType<typeof buildSystemPaths>;

  const config = {
    slackAppToken: "xapp-test",
    slackBotToken: "xoxb-test",
    slackAllowedChannelIds: new Set(["C0ALAMDRB9V"]),
    anthropicApiKey: undefined,
    linearApiKey: "lin_api_test",
    linearWorkspace: "kyaukyuai",
    linearTeamKey: "AIC",
    botModel: "claude-sonnet-4-5",
    workspaceDir: "",
    heartbeatIntervalMin: 30,
    heartbeatActiveLookbackHours: 24,
    schedulerPollSec: 30,
    workgraphMaintenanceIntervalMin: 15,
    workgraphHealthWarnActiveEvents: 200,
    workgraphAutoCompactMaxActiveEvents: 500,
    logLevel: "info" as const,
  };

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "pi-slack-linear-transcript-"));
    systemPaths = buildSystemPaths(workspaceDir);
    await ensureManagerStateFiles(systemPaths);

    linearMocks.searchLinearIssues.mockReset().mockResolvedValue([]);
    linearMocks.createManagedLinearIssue.mockReset();
    linearMocks.createManagedLinearIssueBatch.mockReset();
    linearMocks.updateManagedLinearIssue.mockReset();
    linearMocks.assignLinearIssue.mockReset().mockResolvedValue(undefined);
    linearMocks.addLinearComment.mockReset().mockResolvedValue(undefined);
    linearMocks.addLinearProgressComment.mockReset().mockResolvedValue({ id: "comment-1", body: "ok" });
    linearMocks.addLinearRelation.mockReset().mockResolvedValue(undefined);
    linearMocks.getLinearIssue.mockReset();
    linearMocks.markLinearIssueBlocked.mockReset().mockResolvedValue({
      issue: { id: "issue-1", identifier: "AIC-100", title: "blocked" },
      blockedStateApplied: true,
    });
    linearMocks.updateLinearIssueState.mockReset().mockResolvedValue({
      id: "issue-1",
      identifier: "AIC-100",
      title: "done",
    });
    linearMocks.listRiskyLinearIssues.mockReset().mockResolvedValue([]);
    slackContextMocks.getSlackThreadContext.mockReset().mockResolvedValue({
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-transcript",
      entries: [],
    });
    slackContextMocks.getRecentChannelContext.mockReset().mockResolvedValue([]);
    webResearchMocks.webSearchFetch.mockReset().mockResolvedValue([]);
    webResearchMocks.webFetchUrl.mockReset().mockResolvedValue({
      url: "https://example.com",
      title: "Example",
      snippet: "Example snippet",
    });
    piSessionMocks.runTaskPlanningTurn.mockReset().mockImplementation(async (_config: unknown, _paths: unknown, input: { combinedRequest: string }) => defaultTaskPlan(input));
    piSessionMocks.runResearchSynthesisTurn.mockReset().mockResolvedValue({
      findings: ["関連情報の洗い出しを開始しました。"],
      uncertainties: ["スコープや対処方針の確定が必要なら、この thread で詰めます。"],
      nextActions: [],
    });
    piSessionMocks.runFollowupResolutionTurn.mockReset().mockResolvedValue({
      answered: false,
      confidence: 0.3,
      reasoningSummary: "要求に対する返答としてはまだ不十分です。",
    });
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("replays realistic Slack conversations from transcript fixtures", async () => {
    const fixture = await loadTranscriptFixture(
      new URL("./fixtures/greeting-query-create-inspect-progress.json", import.meta.url).pathname,
    );

    const scenarioSetup = async (turn: TranscriptTurnFixture): Promise<void> => {
      switch (turn.beforeScenario) {
        case "list-my-work":
          linearMocks.listRiskyLinearIssues.mockResolvedValueOnce([
            makeActiveIssue({
              identifier: "AIC-930",
              title: "今日の優先 task",
              assignee: { id: "user-1", displayName: "y.kakui" },
              dueDate: "2026-03-19",
              priority: 1,
              priorityLabel: "Urgent",
            }),
            makeActiveIssue({
              identifier: "AIC-931",
              title: "他メンバーの task",
              assignee: { id: "user-2", displayName: "t.tahira" },
              dueDate: "2026-03-19",
              priority: 1,
              priorityLabel: "Urgent",
            }),
          ]);
          return;
        case "create-invite-task":
          linearMocks.createManagedLinearIssue.mockResolvedValueOnce({
            id: "issue-940",
            identifier: "AIC-940",
            title: "OPT社の社内チャネルへの招待依頼",
            url: "https://linear.app/kyaukyuai/issue/AIC-940",
            assignee: { id: "user-1", displayName: "y.kakui" },
            state: { id: "state-started", name: "Started", type: "started" },
            relations: [],
            inverseRelations: [],
          });
          return;
        case "inspect-created-task":
          linearMocks.getLinearIssue.mockResolvedValueOnce({
            id: "issue-940",
            identifier: "AIC-940",
            title: "OPT社の社内チャネルへの招待依頼",
            url: "https://linear.app/kyaukyuai/issue/AIC-940",
            assignee: { id: "user-1", displayName: "y.kakui" },
            state: { id: "state-started", name: "Started", type: "started" },
            dueDate: "2026-03-21",
            relations: [],
            inverseRelations: [],
          });
          return;
        case "progress-created-task":
          linearMocks.getLinearIssue.mockResolvedValueOnce({
            id: "issue-940",
            identifier: "AIC-940",
            title: "OPT社の社内チャネルへの招待依頼",
            url: "https://linear.app/kyaukyuai/issue/AIC-940",
            assignee: { id: "user-1", displayName: "y.kakui" },
            state: { id: "state-started", name: "Started", type: "started" },
            dueDate: "2026-03-21",
            relations: [],
            inverseRelations: [],
          });
          return;
        default:
      }
    };

    await runTranscriptFixture({
      fixture,
      systemPaths,
      beforeTurn: scenarioSetup,
      invokeTurn: (message, now) => handleManagerMessage(
        { ...config, workspaceDir },
        systemPaths,
        message,
        now,
      ),
    });
  });
});
