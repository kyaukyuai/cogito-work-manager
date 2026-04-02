import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyManagerQuery,
  classifyManagerSignal,
  handleManagerMessage,
} from "../src/lib/manager.js";
import { ensureManagerStateFiles } from "../src/lib/manager-state.js";
import {
  loadThreadQueryContinuation,
  saveThreadQueryContinuation,
} from "../src/lib/query-continuation.js";
import { buildSystemPaths } from "../src/lib/system-workspace.js";
import { buildThreadPaths, ensureThreadWorkspace } from "../src/lib/thread-workspace.js";
import { createDefaultTestManagerAgentTurn } from "./helpers/default-manager-agent-mock.js";

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
  updateLinearIssueStateWithComment: vi.fn(),
  listOpenLinearIssues: vi.fn(),
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

const notionMocks = vi.hoisted(() => ({
  archiveNotionPage: vi.fn(),
  createNotionAgendaPage: vi.fn(),
  updateNotionPage: vi.fn(),
}));

const piSessionMocks = vi.hoisted(() => ({
  runManagerAgentTurn: vi.fn(),
  runManagerSystemTurn: vi.fn(),
  runMessageRouterTurn: vi.fn(),
  runManagerReplyTurn: vi.fn(),
  runTaskPlanningTurn: vi.fn(),
  runResearchSynthesisTurn: vi.fn(),
  runFollowupResolutionTurn: vi.fn(),
  runPartialFollowupUnmatchedTurn: vi.fn().mockResolvedValue({
    matchedIssueIds: [],
    unmatchedTopics: [],
    reasoningSummary: "No unmatched follow-up topics.",
  }),
}));

vi.mock("../src/lib/linear.js", () => ({
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
  updateLinearIssueStateWithComment: linearMocks.updateLinearIssueStateWithComment,
  listOpenLinearIssues: linearMocks.listOpenLinearIssues,
  listRiskyLinearIssues: linearMocks.listRiskyLinearIssues,
}));

vi.mock("../src/lib/slack-context.js", () => ({
  getSlackThreadContext: slackContextMocks.getSlackThreadContext,
  getRecentChannelContext: slackContextMocks.getRecentChannelContext,
}));

vi.mock("../src/lib/web-research.js", () => ({
  webSearchFetch: webResearchMocks.webSearchFetch,
  webFetchUrl: webResearchMocks.webFetchUrl,
}));

vi.mock("../src/lib/notion.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/notion.js")>("../src/lib/notion.js");
  return {
    ...actual,
    archiveNotionPage: notionMocks.archiveNotionPage,
    createNotionAgendaPage: notionMocks.createNotionAgendaPage,
    updateNotionPage: notionMocks.updateNotionPage,
  };
});

vi.mock("../src/lib/pi-session.js", () => ({
  runManagerAgentTurn: piSessionMocks.runManagerAgentTurn,
  runManagerSystemTurn: piSessionMocks.runManagerSystemTurn,
  runMessageRouterTurn: piSessionMocks.runMessageRouterTurn,
  runManagerReplyTurn: piSessionMocks.runManagerReplyTurn,
  runTaskPlanningTurn: piSessionMocks.runTaskPlanningTurn,
  runResearchSynthesisTurn: piSessionMocks.runResearchSynthesisTurn,
  runFollowupResolutionTurn: piSessionMocks.runFollowupResolutionTurn,
  runPartialFollowupUnmatchedTurn: piSessionMocks.runPartialFollowupUnmatchedTurn,
}));

function stripTaskTitle(text: string): string {
  return text
    .trim()
    .replace(/^<@[^>]+>\s*/, "")
    .replace(/^\s*(?:[-*・•]\s+|\d+[.)]\s+)/, "")
    .replace(/(の)?(タスク|issue|Issue|イシュー|ticket|チケット)(を)?/g, " ")
    .replace(/(しておいて|やっておいて|追加して|作成して|作って|登録して|おいて|お願い(します)?|対応して|進めておいて|進めて)/g, " ")
    .replace(/(を)?(調査|確認|検証|比較|リサーチ|洗い出し|調べ)(しておいて|して|お願いします|お願い)?/g, " ")
    .replace(/[。！!？?]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/を$/, "")
    .trim();
}

function extractExplicitTasks(text: string): Array<{ title: string; dueDate?: string; assigneeHint?: string }> {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const bullets = lines
    .filter((line) => /^\s*[-*・•]\s+/.test(line))
    .map((line) => ({ title: stripTaskTitle(line) }));
  return bullets;
}

function defaultTaskPlan(input: { combinedRequest: string }): Record<string, unknown> {
  const text = input.combinedRequest;

  if (text.includes("期限は 2026-03-20 で、作業は")) {
    const children = extractExplicitTasks(text);
    return {
      action: "create",
      planningReason: "complex-request",
      parentTitle: "来週のリリースに向けた対応",
      parentDueDate: "2026-03-20",
      children: children.map((child) => ({
        title: child.title,
        kind: "execution",
        dueDate: child.dueDate ?? undefined,
        assigneeHint: child.assigneeHint ?? undefined,
      })),
    };
  }

  const singleTitle = stripTaskTitle(text) || "Slack からの依頼";
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

function defaultMessageRouter(input: {
  messageText: string;
  threadContext?: {
    pendingClarification?: boolean;
    intakeStatus?: string;
    parentIssueId?: string;
    childIssueIds?: string[];
  };
}) {
  const text = input.messageText.trim();
  if (/^(?:おはよう|こんにちは|こんばんは|お疲れさま|おつかれさま)(?:ございます)?[。！!？?]*$/.test(text)) {
    return {
      action: "conversation",
      conversationKind: "greeting",
      confidence: 0.95,
      reasoningSummary: "挨拶です。",
    };
  }

  const queryKind = classifyManagerQuery(text);
  if (queryKind) {
    const queryScope = /(?:自分|自分の|私|私の|僕|僕の|わたし|わたしの)/.test(text)
      ? "self"
      : /(?:この件|その件|他には|ほかに|他の)/.test(text) || queryKind === "inspect-work" || queryKind === "recommend-next-step"
        ? "thread-context"
        : "team";
    return {
      action: "query",
      queryKind,
      queryScope,
      confidence: 0.9,
      reasoningSummary: "query と判断しました。",
    };
  }

  const signal = classifyManagerSignal(text);
  if (signal === "progress") {
    return { action: "update_progress", confidence: 0.9, reasoningSummary: "進捗更新です。" };
  }
  if (signal === "completed") {
    return { action: "update_completed", confidence: 0.9, reasoningSummary: "完了更新です。" };
  }
  if (signal === "blocked") {
    return { action: "update_blocked", confidence: 0.9, reasoningSummary: "blocked 更新です。" };
  }
  if (signal === "request") {
    return { action: "create_work", confidence: 0.9, reasoningSummary: "新規依頼です。" };
  }
  return {
    action: "conversation",
    conversationKind: "other",
    confidence: 0.6,
    reasoningSummary: "雑談として扱います。",
  };
}

function renderMockIssue(issue: Record<string, unknown>): string {
  const identifier = String(issue.identifier ?? "");
  const title = String(issue.title ?? "");
  return `${identifier} ${title}`.trim();
}

function greetingFromJstDateTime(value: unknown): string {
  const match = typeof value === "string" ? value.match(/\b(\d{2}):(\d{2})\b/) : undefined;
  const hour = match ? Number(match[1]) : NaN;
  if (Number.isNaN(hour)) return "こんばんは";
  if (hour >= 5 && hour < 11) return "おはようございます";
  if (hour >= 11 && hour < 18) return "こんにちは";
  return "こんばんは";
}

function defaultManagerReply(input: {
  kind: string;
  conversationKind?: string;
  currentDateTimeJst?: string;
  facts?: Record<string, unknown>;
}) {
  const facts = input.facts ?? {};

  if (input.kind === "conversation") {
    if (input.conversationKind === "greeting") {
      return {
        reply: `${greetingFromJstDateTime(input.currentDateTimeJst ?? facts.currentDateTimeJst)}。確認したいことや進めたい task があれば、そのまま送ってください。`,
      };
    }
    return {
      reply: "必要なことがあれば、そのまま続けて送ってください。状況確認でも task の相談でも対応します。",
    };
  }

  if (input.kind === "list-active") {
    const items = Array.isArray(facts.selectedItems) ? facts.selectedItems as Array<Record<string, unknown>> : [];
    if (items.length === 0) {
      return { reply: "いま active な task は見当たりません。" };
    }
    return {
      reply: [
        "タスク一覧を確認しました。",
        ...items.map((item) => `- ${renderMockIssue(item)}`),
        "気になる issue があれば、issue ID を返してもらえれば詳細も追えます。",
      ].join("\n"),
    };
  }

  if (input.kind === "list-today") {
    const items = Array.isArray(facts.selectedItems) ? facts.selectedItems as Array<Record<string, unknown>> : [];
    const viewerDisplayLabel = typeof facts.viewerDisplayLabel === "string" ? facts.viewerDisplayLabel : undefined;
    return {
      reply: [
        viewerDisplayLabel ? `${viewerDisplayLabel} を基準に、今日優先して見たい task を整理しました。` : "今日優先して見たい task を整理しました。",
        ...items.map((item) => `- ${renderMockIssue(item)}`),
        facts.viewerMappingMissing ? "ownerMap.slackUserId を入れると自分向けに寄せられます。" : undefined,
      ].filter(Boolean).join("\n"),
    };
  }

  if (input.kind === "what-should-i-do") {
    const items = Array.isArray(facts.selectedItems) ? facts.selectedItems as Array<Record<string, unknown>> : [];
    const top = items[0];
    const viewerDisplayLabel = typeof facts.viewerDisplayLabel === "string" ? facts.viewerDisplayLabel : undefined;
    return {
      reply: [
        top
          ? viewerDisplayLabel
            ? `今日まず手を付けるなら ${viewerDisplayLabel} の中では ${renderMockIssue(top)} から見るのがよさそうです。`
            : `今日まず手を付けるなら ${renderMockIssue(top)} から見るのがよさそうです。`
          : "いま着手中の task は見当たりません。",
        ...items.map((item) => `- ${renderMockIssue(item)}`),
        facts.viewerMappingMissing ? "ownerMap.slackUserId を入れると自分向けに寄せられます。" : undefined,
        "必要なら、このまま優先順位を一緒に絞ります。",
      ].filter(Boolean).join("\n"),
    };
  }

  if (input.kind === "inspect-work") {
    const issue = (facts.issue ?? {}) as Record<string, unknown>;
    return {
      reply: [
        `${renderMockIssue(issue)} の状況を確認しました。`,
        issue.state ? `状態は ${issue.state} です。` : undefined,
        issue.dueDate ? `期限は ${issue.dueDate} です。` : undefined,
        issue.priorityLabel ? `優先度は ${issue.priorityLabel} です。` : undefined,
      ].filter(Boolean).join(" "),
    };
  }

  if (input.kind === "recommend-next-step") {
    const issue = (facts.issue ?? {}) as Record<string, unknown>;
    return {
      reply: [
        `${renderMockIssue(issue)} について、次の一手を整理しました。`,
        typeof facts.recentThreadSummary === "string" ? facts.recentThreadSummary : undefined,
        typeof facts.recommendedAction === "string" ? facts.recommendedAction : undefined,
      ].filter(Boolean).join(" "),
    };
  }

  return { reply: "対応しました。" };
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

function makeIssueFact(
  identifier: string,
  title: string,
  projectName?: string,
): Record<string, unknown> {
  return {
    identifier,
    title,
    project: projectName
      ? {
          id: `project-${projectName}`,
          name: projectName,
          slugId: projectName,
        }
      : undefined,
    stateName: "Started",
  };
}

describe("handleManagerMessage query flows", () => {
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
    notionApiToken: "secret_test",
    notionAgendaParentPageId: "parent-page-1",
    botModel: "claude-sonnet-4-5",
    botThinkingLevel: "minimal" as const,
    botMaxOutputTokens: undefined,
    botRetryMaxRetries: 1,
    workspaceDir: "",
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

  async function updateOwnerMap(patch: Record<string, unknown>): Promise<void> {
    const raw = await readFile(systemPaths.ownerMapFile, "utf8");
    const current = JSON.parse(raw) as Record<string, unknown>;
    await writeFile(systemPaths.ownerMapFile, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, "utf8");
  }

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-query-"));
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
    linearMocks.getLinearIssue.mockReset().mockImplementation(async (issueId: string) => ({
      id: `issue-${issueId}`,
      identifier: issueId,
      title: issueId,
      url: `https://linear.app/kyaukyuai/issue/${issueId}`,
      assignee: { id: "user-1", displayName: "y.kakui" },
      state: { id: "state-1", name: "Started", type: "started" },
      relations: [],
      inverseRelations: [],
    }));
    linearMocks.markLinearIssueBlocked.mockReset();
    linearMocks.updateLinearIssueState.mockReset();
    linearMocks.updateLinearIssueStateWithComment.mockReset();
    linearMocks.listRiskyLinearIssues.mockReset().mockResolvedValue([]);
    linearMocks.listOpenLinearIssues.mockReset().mockImplementation(async (...args: unknown[]) => linearMocks.listRiskyLinearIssues(...args));

    slackContextMocks.getSlackThreadContext.mockReset().mockResolvedValue({
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-query",
      entries: [],
    });
    slackContextMocks.getRecentChannelContext.mockReset().mockResolvedValue([]);
    webResearchMocks.webSearchFetch.mockReset().mockResolvedValue([]);
    webResearchMocks.webFetchUrl.mockReset().mockResolvedValue({
      url: "https://example.com",
      title: "Example",
      snippet: "Example snippet",
    });
    notionMocks.archiveNotionPage.mockReset();
    notionMocks.createNotionAgendaPage.mockReset();
    notionMocks.updateNotionPage.mockReset();

    piSessionMocks.runManagerAgentTurn.mockReset().mockImplementation(createDefaultTestManagerAgentTurn({
      config: { ...config, workspaceDir },
      systemPaths,
      linearMocks: {
        listOpenLinearIssues: linearMocks.listOpenLinearIssues,
        searchLinearIssues: linearMocks.searchLinearIssues,
        getLinearIssue: linearMocks.getLinearIssue,
      },
      slackContextMocks: {
        getSlackThreadContext: slackContextMocks.getSlackThreadContext,
      },
      route: defaultMessageRouter,
      buildReply: defaultManagerReply,
    }));
    piSessionMocks.runManagerSystemTurn.mockReset().mockRejectedValue(new Error("manager system fallback"));
    piSessionMocks.runMessageRouterTurn.mockReset().mockImplementation(async (_config: unknown, _paths: unknown, input: { messageText: string; threadContext?: { pendingClarification?: boolean } }) => defaultMessageRouter(input));
    piSessionMocks.runManagerReplyTurn.mockReset().mockImplementation(async (_config: unknown, _paths: unknown, input: { kind: string; conversationKind?: string; facts?: Record<string, unknown> }) => defaultManagerReply(input));
    piSessionMocks.runTaskPlanningTurn.mockReset().mockImplementation(async (_config: unknown, _paths: unknown, input: { combinedRequest: string }) => defaultTaskPlan(input));
    piSessionMocks.runResearchSynthesisTurn.mockReset();
    piSessionMocks.runFollowupResolutionTurn.mockReset();
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("lists active tasks for query-style task list requests", async () => {
    linearMocks.listRiskyLinearIssues.mockResolvedValueOnce([
      makeActiveIssue({
        identifier: "AIC-501",
        title: "OPT社の社内チャネルへの招待依頼",
        dueDate: "2026-03-20",
        priority: 2,
        priorityLabel: "High",
      }),
      makeActiveIssue({
        identifier: "AIC-502",
        title: "契約書ドラフトの確認",
        dueDate: "2026-03-19",
        priority: 1,
        priorityLabel: "Urgent",
      }),
    ]);

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-query-active",
        messageTs: "msg-1",
        userId: "U1",
        text: "タスク一覧を確認して",
      },
      new Date("2026-03-19T01:00:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("タスク一覧を確認しました。");
    expect(result.reply).toContain("AIC-501");
    expect(result.reply).toContain("AIC-502");
    expect(result.reply).toContain("気になる issue があれば");
    expect(piSessionMocks.runTaskPlanningTurn).not.toHaveBeenCalled();
    expect(linearMocks.createManagedLinearIssue).not.toHaveBeenCalled();
  });

  it("answers today and prioritization queries without sending them to intake", async () => {
    linearMocks.listRiskyLinearIssues.mockResolvedValue([
      makeActiveIssue({
        identifier: "AIC-601",
        title: "今日中にOPT社へ確認事項を送る",
        dueDate: "2026-03-19",
        priority: 1,
        priorityLabel: "Urgent",
      }),
      makeActiveIssue({
        identifier: "AIC-602",
        title: "ドラフト作成",
        dueDate: "2026-03-20",
        priority: 2,
        priorityLabel: "High",
      }),
      makeActiveIssue({
        identifier: "AIC-603",
        title: "来週レビュー用のメモ整理",
        priority: 3,
        priorityLabel: "Medium",
        updatedAt: "2026-03-18T00:00:00.000Z",
      }),
    ]);

    const today = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-query-today",
        messageTs: "msg-1",
        userId: "U1",
        text: "今日のタスク一覧を確認して",
      },
      new Date("2026-03-19T01:00:00.000Z"),
    );

    expect(today.handled).toBe(true);
    expect(today.reply).toContain("今日優先して見たい task を整理しました。");
    expect(today.reply).toContain("AIC-601");
    expect(today.reply).toContain("AIC-602");

    const shouldDo = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-query-priority",
        messageTs: "msg-2",
        userId: "U1",
        text: "今日やるべきタスクある？",
      },
      new Date("2026-03-19T01:05:00.000Z"),
    );

    expect(shouldDo.handled).toBe(true);
    expect(shouldDo.reply).toContain("今日まず手を付けるなら");
    expect(shouldDo.reply).toContain("AIC-601");
    expect(shouldDo.reply).toContain("必要なら、このまま優先順位を一緒に絞ります。");
    expect(piSessionMocks.runTaskPlanningTurn).not.toHaveBeenCalled();
  });

  it("prefers the viewer's assigned work for today and prioritization queries when owner mapping exists", async () => {
    await updateOwnerMap({
      entries: [
        {
          id: "kyaukyuai",
          domains: ["default"],
          keywords: [],
          linearAssignee: "y.kakui",
          slackUserId: "U1",
          primary: true,
        },
      ],
    });

    linearMocks.listRiskyLinearIssues.mockResolvedValue([
      makeActiveIssue({
        identifier: "AIC-611",
        title: "自分の担当 task",
        assignee: { id: "user-1", displayName: "y.kakui" },
        dueDate: "2026-03-20",
        priority: 2,
        priorityLabel: "High",
      }),
      makeActiveIssue({
        identifier: "AIC-612",
        title: "他メンバーの urgent task",
        assignee: { id: "user-2", displayName: "t.tahira" },
        dueDate: "2026-03-19",
        priority: 1,
        priorityLabel: "Urgent",
      }),
    ]);

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-my-work-query",
        messageTs: "msg-1",
        userId: "U1",
        text: "今日やるべきタスクある？",
      },
      new Date("2026-03-19T01:00:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("y.kakui さんの担当");
    expect(result.reply).toContain("AIC-611");
    expect(result.reply).not.toContain("AIC-612");
  });

  it("mentions missing Slack owner mapping when personalized prioritization cannot be applied", async () => {
    linearMocks.listRiskyLinearIssues.mockResolvedValueOnce([
      makeActiveIssue({
        identifier: "AIC-613",
        title: "チーム全体の urgent task",
        assignee: { id: "user-2", displayName: "t.tahira" },
        dueDate: "2026-03-19",
        priority: 1,
        priorityLabel: "Urgent",
      }),
    ]);

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-my-work-unmapped",
        messageTs: "msg-1",
        userId: "U2",
        text: "自分の今日やるべきタスクある？",
      },
      new Date("2026-03-19T01:00:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("ownerMap.slackUserId");
    expect(result.reply).toContain("AIC-613");
  });

  it("inspects the status of a thread-linked issue for conversational status questions", async () => {
    linearMocks.createManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-701",
      identifier: "AIC-701",
      title: "OPT社の社内チャネルへの招待依頼",
      url: "https://linear.app/kyaukyuai/issue/AIC-701",
      assignee: { id: "user-1", displayName: "y.kakui" },
      state: { id: "state-started", name: "Started", type: "started" },
      dueDate: "2026-03-21",
      priority: 2,
      priorityLabel: "High",
      relations: [],
      inverseRelations: [],
    });

    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-inspect",
        messageTs: "msg-1",
        userId: "U1",
        text: "OPT社の社内チャネルに招待してもらうタスクを追加して",
      },
      new Date("2026-03-19T01:00:00.000Z"),
    );
    piSessionMocks.runTaskPlanningTurn.mockClear();

    linearMocks.getLinearIssue.mockResolvedValueOnce({
      id: "issue-701",
      identifier: "AIC-701",
      title: "OPT社の社内チャネルへの招待依頼",
      url: "https://linear.app/kyaukyuai/issue/AIC-701",
      assignee: { id: "user-1", displayName: "y.kakui" },
      state: { id: "state-started", name: "Started", type: "started" },
      dueDate: "2026-03-21",
      priority: 2,
      priorityLabel: "High",
      cycle: { id: "cycle-1", name: "Sprint 3" },
      relations: [],
      inverseRelations: [],
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-inspect",
        messageTs: "msg-2",
        userId: "U1",
        text: "この件どうなってる？",
      },
      new Date("2026-03-19T01:05:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("AIC-701");
    expect(result.reply).toContain("状況を確認しました。");
    expect(result.reply).toContain("状態は Started です。");
    expect(result.reply).toContain("期限は 2026-03-21 です。");
    expect(result.reply).toContain("優先度は High です。");
    expect(piSessionMocks.runTaskPlanningTurn).not.toHaveBeenCalled();
  });

  it("uses recent thread context to disambiguate inspect queries in a multi-issue thread", async () => {
    linearMocks.createManagedLinearIssueBatch.mockResolvedValueOnce({
      parent: {
        id: "parent-90",
        identifier: "AIC-910",
        title: "来週のリリースに向けた対応",
        url: "https://linear.app/kyaukyuai/issue/AIC-910",
        relations: [],
        inverseRelations: [],
      },
      children: [
        {
          id: "child-91",
          identifier: "AIC-911",
          title: "API レート制限の確認",
          url: "https://linear.app/kyaukyuai/issue/AIC-911",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
        {
          id: "child-92",
          identifier: "AIC-912",
          title: "修正対応",
          url: "https://linear.app/kyaukyuai/issue/AIC-912",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
      ],
    });

    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-inspect-disambiguation",
        messageTs: "msg-1",
        userId: "U1",
        text: "期限は 2026-03-20 で、作業は\n- API レート制限の確認\n- 修正対応\nに分けて進めて",
      },
      new Date("2026-03-19T01:00:00.000Z"),
    );
    piSessionMocks.runTaskPlanningTurn.mockClear();

    slackContextMocks.getSlackThreadContext.mockResolvedValueOnce({
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-inspect-disambiguation",
      entries: [
        { type: "assistant", text: "まずは AIC-911 API レート制限の確認 を見ます" },
        { type: "user", text: "了解、API レート制限の確認から進めます" },
      ],
    });
    linearMocks.getLinearIssue.mockResolvedValueOnce({
      id: "child-91",
      identifier: "AIC-911",
      title: "API レート制限の確認",
      url: "https://linear.app/kyaukyuai/issue/AIC-911",
      assignee: { id: "user-1", displayName: "y.kakui" },
      state: { id: "state-started", name: "Started", type: "started" },
      dueDate: "2026-03-20",
      relations: [],
      inverseRelations: [],
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-inspect-disambiguation",
        messageTs: "msg-2",
        userId: "U1",
        text: "この件どうなってる？",
      },
      new Date("2026-03-19T01:05:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("AIC-911");
    expect(result.reply).not.toContain("AIC-912 の状況");
    expect(piSessionMocks.runTaskPlanningTurn).not.toHaveBeenCalled();
  });

  it("recommends the next step for a thread-linked issue using issue state and thread context", async () => {
    linearMocks.createManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-720",
      identifier: "AIC-720",
      title: "OPT社の社内チャネルへの招待依頼",
      url: "https://linear.app/kyaukyuai/issue/AIC-720",
      assignee: { id: "user-1", displayName: "y.kakui" },
      state: { id: "state-started", name: "Started", type: "started" },
      relations: [],
      inverseRelations: [],
    });

    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-next-step",
        messageTs: "msg-1",
        userId: "U1",
        text: "OPT社の社内チャネルに招待してもらうタスクを追加して",
      },
      new Date("2026-03-19T01:00:00.000Z"),
    );
    piSessionMocks.runTaskPlanningTurn.mockClear();

    slackContextMocks.getSlackThreadContext.mockResolvedValue({
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-next-step",
      entries: [
        { type: "assistant", text: "招待先を確認したら、そのまま依頼してください。" },
        { type: "user", text: "OPT社に投げる文面の下書きまではできています" },
      ],
    });
    linearMocks.getLinearIssue.mockResolvedValueOnce({
      id: "issue-720",
      identifier: "AIC-720",
      title: "OPT社の社内チャネルへの招待依頼",
      url: "https://linear.app/kyaukyuai/issue/AIC-720",
      assignee: { id: "user-1", displayName: "y.kakui" },
      state: { id: "state-started", name: "Started", type: "started" },
      dueDate: "2026-03-21",
      relations: [],
      inverseRelations: [],
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-next-step",
        messageTs: "msg-2",
        userId: "U1",
        text: "この件次どう進める？",
      },
      new Date("2026-03-19T01:05:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("次の一手を整理しました。");
    expect(result.reply).toContain("AIC-720");
    expect(result.reply).toContain("下書きまではできています");
    expect(result.reply).toContain("次は今の進捗を 1 行で返すか");
    expect(piSessionMocks.runTaskPlanningTurn).not.toHaveBeenCalled();
  });

  it("renders explicit project-grouped task queries from exact issue.project facts and persists exact continuation", async () => {
    const exactFacts = [
      makeIssueFact("AIC-129", "temporal eval task 1", "ai-clone"),
      makeIssueFact("AIC-128", "temporal eval task 2", "ai-clone"),
      makeIssueFact("AIC-126", "temporal eval task 3", "ai-clone"),
      makeIssueFact("AIC-118", "clone-provision-regression", "ai-clone"),
      makeIssueFact("AIC-117", "cold-worker prompt timeout", "ai-clone"),
      makeIssueFact("AIC-113", "collector follow-up", "ai-clone"),
      makeIssueFact("AIC-107", "kickoff import", "ai-clone"),
      makeIssueFact("AIC-101", "dialog summary import", "ai-clone"),
      makeIssueFact("AIC-99", "Notion import", "ai-clone-collector"),
      makeIssueFact("AIC-85", "collector planning", "ai-clone-collector"),
      makeIssueFact("AIC-105", "FFS personalization 3", "operation"),
      makeIssueFact("AIC-104", "FFS personalization 2", "operation"),
      makeIssueFact("AIC-103", "FFS personalization 1", "operation"),
      makeIssueFact("AIC-87", "Collect recurring meeting names", "operation"),
      makeIssueFact("AIC-86", "Invite Kakui to executives channel", "operation"),
      makeIssueFact("AIC-61", "Invite Kakui to ChatGPT project", "operation"),
      makeIssueFact("AIC-59", "Kickoff announcement", "operation"),
      makeIssueFact("AIC-58", "Onboarding prep", "operation"),
      makeIssueFact("AIC-57", "Account setup", "operation"),
      makeIssueFact("AIC-56", "Internal rollout", "operation"),
      makeIssueFact("AIC-38", "Invite request", "operation"),
      makeIssueFact("AIC-55", "Contract closing", "operation"),
      makeIssueFact("AIC-133", "Project-less issue 1"),
      makeIssueFact("AIC-132", "Project-less issue 2"),
      makeIssueFact("AIC-130", "Project-less issue 3"),
      makeIssueFact("AIC-127", "Project-less issue 4"),
      makeIssueFact("AIC-125", "Project-less issue 5"),
      makeIssueFact("AIC-123", "Project-less issue 6"),
      makeIssueFact("AIC-122", "Project-less issue 7"),
      makeIssueFact("AIC-120", "Project-less issue 8"),
    ];

    piSessionMocks.runManagerAgentTurn.mockReset().mockResolvedValueOnce({
      reply: [
        "プロジェクト別にまとめます。",
        "ai-clone（9件）",
        "AIC-103〜105 人事情報（FFS）活用・パーソナライズ — High",
        "プロジェクト未割り当て（5件）",
      ].join("\n"),
      toolCalls: [
        {
          toolName: "report_manager_intent",
          details: {
            intentReport: {
              intent: "query",
              queryKind: "list-active",
              queryScope: "team",
              confidence: 0.95,
              summary: "プロジェクトごとの task list query です。",
            },
          },
        },
        {
          toolName: "linear_list_active_issue_facts",
          details: exactFacts,
        },
        {
          toolName: "report_query_snapshot",
          details: {
            querySnapshot: {
              issueIds: ["AIC-103"],
              shownIssueIds: ["AIC-103"],
              remainingIssueIds: [],
              totalItemCount: 1,
              replySummary: "inaccurate grouped summary",
              scope: "team",
            },
          },
        },
      ],
      proposals: [],
      invalidProposalCount: 0,
      intentReport: {
        intent: "query",
        queryKind: "list-active",
        queryScope: "team",
        confidence: 0.95,
        summary: "プロジェクトごとの task list query です。",
      },
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-query-project-grouped",
        messageTs: "msg-1",
        userId: "U1",
        text: "<@U0ALQ3MN4RL> project ごとのタスク一覧をだして",
      },
      new Date("2026-04-02T01:47:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("プロジェクトごとにまとめます。");
    expect(result.reply).toContain("ai-clone（8件）");
    expect(result.reply).toContain("ai-clone-collector（2件）");
    expect(result.reply).toContain("operation（12件）");
    expect(result.reply).toContain("プロジェクト未設定（8件）");
    expect(result.reply).toContain("- AIC-133 Project-less issue 1（Started）");
    expect(result.reply).not.toContain("AIC-103〜105");
    expect(result.reply).not.toContain("AIC-61・AIC-87");

    const continuation = await loadThreadQueryContinuation(
      buildThreadPaths(workspaceDir, "C0ALAMDRB9V", "thread-query-project-grouped"),
    );
    expect(continuation).toMatchObject({
      kind: "list-active",
      scope: "team",
      totalItemCount: 30,
      shownIssueIds: [
        "AIC-129", "AIC-128", "AIC-126",
        "AIC-99", "AIC-85",
        "AIC-105", "AIC-104", "AIC-103",
        "AIC-133", "AIC-132", "AIC-130",
      ],
      remainingIssueIds: [
        "AIC-118", "AIC-117", "AIC-113", "AIC-107", "AIC-101",
        "AIC-87", "AIC-86", "AIC-61", "AIC-59", "AIC-58", "AIC-57", "AIC-56", "AIC-38", "AIC-55",
        "AIC-127", "AIC-125", "AIC-123", "AIC-122", "AIC-120",
      ],
    });
    expect(continuation?.replySummary).toContain("[project-grouped-exact]");
  });

  it("uses exact project-grouped continuation instead of repeating or guessing later items", async () => {
    const exactFacts = [
      makeIssueFact("AIC-129", "temporal eval task 1", "ai-clone"),
      makeIssueFact("AIC-128", "temporal eval task 2", "ai-clone"),
      makeIssueFact("AIC-126", "temporal eval task 3", "ai-clone"),
      makeIssueFact("AIC-118", "clone-provision-regression", "ai-clone"),
      makeIssueFact("AIC-117", "cold-worker prompt timeout", "ai-clone"),
      makeIssueFact("AIC-113", "collector follow-up", "ai-clone"),
      makeIssueFact("AIC-107", "kickoff import", "ai-clone"),
      makeIssueFact("AIC-101", "dialog summary import", "ai-clone"),
      makeIssueFact("AIC-99", "Notion import", "ai-clone-collector"),
      makeIssueFact("AIC-85", "collector planning", "ai-clone-collector"),
      makeIssueFact("AIC-105", "FFS personalization 3", "operation"),
      makeIssueFact("AIC-104", "FFS personalization 2", "operation"),
      makeIssueFact("AIC-103", "FFS personalization 1", "operation"),
      makeIssueFact("AIC-87", "Collect recurring meeting names", "operation"),
      makeIssueFact("AIC-86", "Invite Kakui to executives channel", "operation"),
      makeIssueFact("AIC-61", "Invite Kakui to ChatGPT project", "operation"),
      makeIssueFact("AIC-59", "Kickoff announcement", "operation"),
      makeIssueFact("AIC-58", "Onboarding prep", "operation"),
      makeIssueFact("AIC-57", "Account setup", "operation"),
      makeIssueFact("AIC-56", "Internal rollout", "operation"),
      makeIssueFact("AIC-38", "Invite request", "operation"),
      makeIssueFact("AIC-55", "Contract closing", "operation"),
      makeIssueFact("AIC-133", "Project-less issue 1"),
      makeIssueFact("AIC-132", "Project-less issue 2"),
      makeIssueFact("AIC-130", "Project-less issue 3"),
      makeIssueFact("AIC-127", "Project-less issue 4"),
      makeIssueFact("AIC-125", "Project-less issue 5"),
      makeIssueFact("AIC-123", "Project-less issue 6"),
      makeIssueFact("AIC-122", "Project-less issue 7"),
      makeIssueFact("AIC-120", "Project-less issue 8"),
    ];

    piSessionMocks.runManagerAgentTurn
      .mockReset()
      .mockResolvedValueOnce({
        reply: "grouped reply should be overridden",
        toolCalls: [
          {
            toolName: "report_manager_intent",
            details: {
              intentReport: {
                intent: "query",
                queryKind: "list-active",
                queryScope: "team",
                confidence: 0.95,
                summary: "プロジェクトごとの task list query です。",
              },
            },
          },
          { toolName: "linear_list_active_issue_facts", details: exactFacts },
        ],
        proposals: [],
        invalidProposalCount: 0,
        intentReport: {
          intent: "query",
          queryKind: "list-active",
          queryScope: "team",
          confidence: 0.95,
          summary: "プロジェクトごとの task list query です。",
        },
      })
      .mockResolvedValueOnce({
        reply: "continued reply should also be overridden",
        toolCalls: [
          {
            toolName: "report_manager_intent",
            details: {
              intentReport: {
                intent: "query",
                queryKind: "list-active",
                queryScope: "thread-context",
                confidence: 0.92,
                summary: "直前の一覧の続きです。",
              },
            },
          },
          { toolName: "linear_list_active_issue_facts", details: exactFacts },
        ],
        proposals: [],
        invalidProposalCount: 0,
        intentReport: {
          intent: "query",
          queryKind: "list-active",
          queryScope: "thread-context",
          confidence: 0.92,
          summary: "直前の一覧の続きです。",
        },
      });

    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-query-project-grouped-continuation",
        messageTs: "msg-1",
        userId: "U1",
        text: "project ごとのタスク一覧をだして",
      },
      new Date("2026-04-02T01:47:00.000Z"),
    );

    const followup = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-query-project-grouped-continuation",
        messageTs: "msg-2",
        userId: "U1",
        text: "他には？",
      },
      new Date("2026-04-02T01:48:00.000Z"),
    );

    expect(followup.reply).toContain("- AIC-118 clone-provision-regression（Started）");
    expect(followup.reply).toContain("- AIC-87 Collect recurring meeting names（Started）");
    expect(followup.reply).toContain("- AIC-127 Project-less issue 4（Started）");
    expect(followup.reply).not.toContain("AIC-129");
    expect(followup.reply).not.toContain("AIC-133 Project-less issue 1");

    const continuation = await loadThreadQueryContinuation(
      buildThreadPaths(workspaceDir, "C0ALAMDRB9V", "thread-query-project-grouped-continuation"),
    );
    expect(continuation?.shownIssueIds).toEqual([
      "AIC-129", "AIC-128", "AIC-126",
      "AIC-99", "AIC-85",
      "AIC-105", "AIC-104", "AIC-103",
      "AIC-133", "AIC-132", "AIC-130",
      "AIC-118", "AIC-117", "AIC-113",
      "AIC-87", "AIC-86", "AIC-61",
      "AIC-127", "AIC-125", "AIC-123",
    ]);
    expect(continuation?.remainingIssueIds).toEqual([
      "AIC-107", "AIC-101",
      "AIC-59", "AIC-58", "AIC-57", "AIC-56", "AIC-38", "AIC-55",
      "AIC-122", "AIC-120",
    ]);
  });

  it("returns a safety reply instead of guessed project grouping when exact issue facts are unavailable", async () => {
    piSessionMocks.runManagerAgentTurn.mockReset().mockResolvedValueOnce({
      reply: "operation（12件）\nAIC-103〜105 ...",
      toolCalls: [
        {
          toolName: "report_manager_intent",
          details: {
            intentReport: {
              intent: "query",
              queryKind: "list-active",
              queryScope: "team",
              confidence: 0.95,
              summary: "プロジェクトごとの task list query です。",
            },
          },
        },
      ],
      proposals: [],
      invalidProposalCount: 0,
      intentReport: {
        intent: "query",
        queryKind: "list-active",
        queryScope: "team",
        confidence: 0.95,
        summary: "プロジェクトごとの task list query です。",
      },
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-query-project-grouped-safety",
        messageTs: "msg-1",
        userId: "U1",
        text: "プロジェクト別のタスク一覧を見せて",
      },
      new Date("2026-04-02T01:47:00.000Z"),
    );

    expect(result.reply).toBe("プロジェクトごとの一覧を正確に組み立てられませんでした。もう一度お試しください。");
    await expect(
      loadThreadQueryContinuation(buildThreadPaths(workspaceDir, "C0ALAMDRB9V", "thread-query-project-grouped-safety")),
    ).resolves.toBeUndefined();
  });

  it("forces a fresh exact project-grouped query instead of reusing stale grouped continuation", async () => {
    const stalePaths = buildThreadPaths(workspaceDir, "C0ALAMDRB9V", "thread-query-project-grouped-stale");
    await ensureThreadWorkspace(stalePaths);
    await saveThreadQueryContinuation(
      stalePaths,
      {
        kind: "list-active",
        scope: "team",
        userMessage: "<@U0ALQ3MN4RL> project ごとのタスク一覧をだして",
        replySummary: "プロジェクト（ai-clone/operation/未設定）ごとにアクティブタスクを一覧化した。",
        issueIds: ["AIC-999"],
        shownIssueIds: ["AIC-999"],
        remainingIssueIds: [],
        totalItemCount: 1,
        recordedAt: "2026-04-02T01:47:58.152Z",
      },
    );

    const exactFacts = [
      makeIssueFact("AIC-129", "temporal eval task 1", "ai-clone"),
      makeIssueFact("AIC-128", "temporal eval task 2", "ai-clone"),
      makeIssueFact("AIC-55", "Contract closing", "operation"),
      makeIssueFact("AIC-133", "Project-less issue 1"),
    ];

    piSessionMocks.runManagerAgentTurn.mockReset().mockResolvedValueOnce({
      reply: "stale grouped reply should be ignored",
      toolCalls: [
        {
          toolName: "report_manager_intent",
          details: {
            intentReport: {
              intent: "query",
              queryKind: "list-active",
              queryScope: "team",
              confidence: 0.95,
              summary: "プロジェクトごとの task list query です。",
            },
          },
        },
        { toolName: "linear_list_active_issue_facts", details: exactFacts },
        {
          toolName: "report_query_snapshot",
          details: {
            querySnapshot: {
              issueIds: ["AIC-999"],
              shownIssueIds: ["AIC-999"],
              remainingIssueIds: [],
              totalItemCount: 1,
              replySummary: "stale grouped summary",
              scope: "team",
            },
          },
        },
      ],
      proposals: [],
      invalidProposalCount: 0,
      intentReport: {
        intent: "query",
        queryKind: "list-active",
        queryScope: "team",
        confidence: 0.95,
        summary: "プロジェクトごとの task list query です。",
      },
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-query-project-grouped-stale",
        messageTs: "msg-1",
        userId: "U1",
        text: "<@U0ALQ3MN4RL> project ごとのタスク一覧をだして",
      },
      new Date("2026-04-02T02:31:00.000Z"),
    );

    expect(piSessionMocks.runManagerAgentTurn).toHaveBeenCalledTimes(1);
    expect(piSessionMocks.runManagerAgentTurn.mock.calls[0]?.[2]).toMatchObject({
      lastQueryContext: undefined,
    });
    expect(result.reply).toContain("プロジェクトごとにまとめます。");
    expect(result.reply).toContain("ai-clone（2件）");
    expect(result.reply).toContain("operation（1件）");
    expect(result.reply).toContain("プロジェクト未設定（1件）");

    const continuation = await loadThreadQueryContinuation(
      stalePaths,
    );
    expect(continuation?.replySummary).toContain("[project-grouped-exact]");
    expect(continuation?.issueIds).toEqual(["AIC-129", "AIC-128", "AIC-55", "AIC-133"]);
  });

  it("does not persist a stale grouped query snapshot when explicit project-grouped facts are unavailable", async () => {
    const staleSafetyPaths = buildThreadPaths(workspaceDir, "C0ALAMDRB9V", "thread-query-project-grouped-stale-safety");
    await ensureThreadWorkspace(staleSafetyPaths);
    await saveThreadQueryContinuation(
      staleSafetyPaths,
      {
        kind: "list-active",
        scope: "team",
        userMessage: "<@U0ALQ3MN4RL> project ごとのタスク一覧をだして",
        replySummary: "プロジェクト（ai-clone/operation/未設定）ごとにアクティブタスクを一覧化した。",
        issueIds: ["AIC-999"],
        shownIssueIds: ["AIC-999"],
        remainingIssueIds: [],
        totalItemCount: 1,
        recordedAt: "2026-04-02T01:47:58.152Z",
      },
    );

    piSessionMocks.runManagerAgentTurn.mockReset().mockResolvedValueOnce({
      reply: "old grouped reply",
      toolCalls: [
        {
          toolName: "report_manager_intent",
          details: {
            intentReport: {
              intent: "query",
              queryKind: "list-active",
              queryScope: "team",
              confidence: 0.95,
              summary: "プロジェクトごとの task list query です。",
            },
          },
        },
        {
          toolName: "report_query_snapshot",
          details: {
            querySnapshot: {
              issueIds: ["AIC-999"],
              shownIssueIds: ["AIC-999"],
              remainingIssueIds: [],
              totalItemCount: 1,
              replySummary: "stale grouped summary",
              scope: "team",
            },
          },
        },
      ],
      proposals: [],
      invalidProposalCount: 0,
      intentReport: {
        intent: "query",
        queryKind: "list-active",
        queryScope: "team",
        confidence: 0.95,
        summary: "プロジェクトごとの task list query です。",
      },
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-query-project-grouped-stale-safety",
        messageTs: "msg-1",
        userId: "U1",
        text: "<@U0ALQ3MN4RL> project ごとのタスク一覧をだして",
      },
      new Date("2026-04-02T02:31:00.000Z"),
    );

    expect(result.reply).toBe("プロジェクトごとの一覧を正確に組み立てられませんでした。もう一度お試しください。");
    await expect(
      loadThreadQueryContinuation(staleSafetyPaths),
    ).resolves.toBeUndefined();
  });

  it("disables streaming policy for project-grouped continuation queries", async () => {
    const continuationPaths = buildThreadPaths(workspaceDir, "C0ALAMDRB9V", "thread-query-project-grouped-continuation");
    await ensureThreadWorkspace(continuationPaths);
    await saveThreadQueryContinuation(
      continuationPaths,
      {
        kind: "list-active",
        scope: "team",
        userMessage: "<@U0ALQ3MN4RL> project ごとのタスク一覧をだして",
        replySummary: "[project-grouped-exact] exact project-grouped task list",
        issueIds: ["AIC-129", "AIC-128", "AIC-55", "AIC-133"],
        shownIssueIds: ["AIC-129", "AIC-128"],
        remainingIssueIds: ["AIC-55", "AIC-133"],
        totalItemCount: 4,
        recordedAt: "2026-04-02T03:10:00.000Z",
      },
    );

    piSessionMocks.runManagerAgentTurn.mockReset().mockResolvedValueOnce({
      reply: "プロジェクトごとにまとめます。\n\noperation（1件）\n- AIC-55 Contract closing",
      toolCalls: [
        {
          toolName: "report_manager_intent",
          details: {
            intentReport: {
              intent: "query",
              queryKind: "list-active",
              queryScope: "team",
              confidence: 0.95,
              summary: "project-grouped continuation query です。",
            },
          },
        },
        {
          toolName: "linear_list_active_issue_facts",
          details: [
            makeIssueFact("AIC-55", "Contract closing", "operation"),
            makeIssueFact("AIC-133", "Project-less issue 1"),
          ],
        },
        {
          toolName: "report_query_snapshot",
          details: {
            querySnapshot: {
              issueIds: ["AIC-55", "AIC-133"],
              shownIssueIds: ["AIC-55", "AIC-133"],
              remainingIssueIds: [],
              totalItemCount: 2,
              replySummary: "ignored agent snapshot",
              scope: "team",
            },
          },
        },
      ],
      proposals: [],
      invalidProposalCount: 0,
      intentReport: {
        intent: "query",
        queryKind: "list-active",
        queryScope: "team",
        confidence: 0.95,
        summary: "project-grouped continuation query です。",
      },
    });

    const onReplyStreamingPolicy = vi.fn();
    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-query-project-grouped-continuation",
        messageTs: "msg-1",
        userId: "U1",
        text: "他には？",
      },
      new Date("2026-04-02T03:11:00.000Z"),
      undefined,
      {
        managerAgentObserver: {
          onReplyStreamingPolicy,
        },
      },
    );

    expect(onReplyStreamingPolicy).toHaveBeenCalledWith({
      mode: "disabled",
      reason: "deterministic-project-grouped-query",
    });
  });
});
