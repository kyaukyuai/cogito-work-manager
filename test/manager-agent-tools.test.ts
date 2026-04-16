import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/lib/config.js";
import { buildThreadAttachmentArtifactsDir, saveThreadAttachmentCatalog } from "../src/gateways/slack-attachments/index.js";
import { ensureManagerStateFiles } from "../src/lib/manager-state.js";
import { createManagerAgentTools } from "../src/lib/manager-agent-tools.js";
import { buildSystemPaths } from "../src/lib/system-workspace.js";
import { buildThreadPaths, ensureThreadWorkspace } from "../src/lib/thread-workspace.js";
import { WEBHOOK_INITIAL_PROPOSAL_MARKER } from "../src/orchestrators/webhooks/initial-proposal-comment.js";

const linearMocks = vi.hoisted(() => ({
  getLinearIssue: vi.fn(),
  getLinearProject: vi.fn(),
  listOpenLinearIssues: vi.fn(),
  listLinearProjects: vi.fn(),
  listLinearTeamMembers: vi.fn(),
  searchLinearIssues: vi.fn(),
}));

const notionMocks = vi.hoisted(() => ({
  getNotionPageContent: vi.fn(),
}));

vi.mock("../src/gateways/linear/issues.js", async () => {
  const actual = await vi.importActual<typeof import("../src/gateways/linear/issues.js")>("../src/gateways/linear/issues.js");
  return {
    ...actual,
    getLinearIssue: linearMocks.getLinearIssue,
    listOpenLinearIssues: linearMocks.listOpenLinearIssues,
    listLinearTeamMembers: linearMocks.listLinearTeamMembers,
    searchLinearIssues: linearMocks.searchLinearIssues,
  };
});

vi.mock("../src/gateways/linear/projects.js", async () => {
  const actual = await vi.importActual<typeof import("../src/gateways/linear/projects.js")>("../src/gateways/linear/projects.js");
  return {
    ...actual,
    getLinearProject: linearMocks.getLinearProject,
    listLinearProjects: linearMocks.listLinearProjects,
  };
});

vi.mock("../src/lib/notion.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/notion.js")>("../src/lib/notion.js");
  return {
    ...actual,
    getNotionPageContent: notionMocks.getNotionPageContent,
  };
});

const config: AppConfig = {
  slackAppToken: "xapp-test",
  slackBotToken: "xoxb-test",
  slackAllowedChannelIds: new Set(["C0ALAMDRB9V"]),
  anthropicApiKey: "anthropic-test",
  linearApiKey: "lin_api_test",
  linearWorkspace: "kyaukyuai",
  linearTeamKey: "AIC",
  notionApiToken: "secret_test",
  notionAgendaParentPageId: "parent-page-1",
  botModel: "claude-sonnet-4-6",
  botThinkingLevel: "minimal",
  botMaxOutputTokens: undefined,
  botRetryMaxRetries: 1,
  workspaceDir: "/tmp/cogito-work-manager",
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
  logLevel: "info",
};

function buildRepositoriesForTools() {
  return {
    policy: {
      load: vi.fn().mockResolvedValue({
        controlRoomChannelId: "C0ALAMDRB9V",
        assistantName: "コギト",
        fallbackOwner: "kyaukyuai",
        businessHours: {
          timezone: "Asia/Tokyo",
          weekdays: [1, 2, 3, 4, 5],
          start: "09:00",
          end: "18:00",
        },
        heartbeatEnabled: true,
        heartbeatIntervalMin: 30,
        heartbeatActiveLookbackHours: 24,
        staleBusinessDays: 3,
        blockedBusinessDays: 1,
        followupCooldownHours: 24,
        clarificationCooldownHours: 12,
        autoCreate: true,
        autoStatusUpdate: true,
        autoAssign: true,
        autoPlan: true,
        reviewExplicitFollowupCount: 1,
        mentionOnFirstFollowupCategories: ["blocked", "overdue", "due_today", "due_soon"],
        mentionOnRepingCategories: ["stale", "owner_missing"],
        mentionAfterRepingCount: 1,
        researchAutoPlanMinActions: 2,
        researchAutoPlanMaxChildren: 3,
        urgentPriorityThreshold: 2,
        reviewCadence: {
          morningEnabled: true,
          morning: "09:00",
          eveningEnabled: true,
          evening: "17:00",
          weeklyEnabled: true,
          weeklyDay: "mon",
          weeklyTime: "09:30",
        },
      }),
      save: vi.fn(),
    },
    ownerMap: {
      load: vi.fn().mockResolvedValue({
        defaultOwner: "kyaukyuai",
        entries: [
          {
            id: "kyaukyuai",
            domains: ["default"],
            keywords: ["manager"],
            linearAssignee: "y.kakui",
            slackUserId: "U01L86BCA9X",
            primary: true,
          },
        ],
      }),
      save: vi.fn(),
    },
    workgraph: {} as never,
  };
}

describe("manager agent tools", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    notionMocks.getNotionPageContent.mockReset();
    linearMocks.getLinearIssue.mockReset();
    linearMocks.getLinearProject.mockReset();
    linearMocks.listOpenLinearIssues.mockReset();
    linearMocks.listLinearProjects.mockReset();
    linearMocks.listLinearTeamMembers.mockReset();
    linearMocks.searchLinearIssues.mockReset();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("validates conversationKind in report_manager_intent", async () => {
    const tools = createManagerAgentTools(config, buildRepositoriesForTools());
    const tool = tools.find((entry) => entry.name === "report_manager_intent");

    expect(tool).toBeDefined();

    const ok = await tool!.execute("tool-call-intent-ok", {
      intent: "conversation",
      conversationKind: "greeting",
      confidence: 0.9,
      summary: "挨拶です。",
    });
    expect(ok.details).toMatchObject({
      intentReport: {
        intent: "conversation",
        conversationKind: "greeting",
      },
    });

    await expect(tool!.execute("tool-call-intent-invalid", {
      intent: "conversation",
      confidence: 0.9,
      summary: "挨拶です。",
    })).rejects.toThrow(/conversationKind/i);
  });

  it("validates partial follow-up resolution reports", async () => {
    const tools = createManagerAgentTools(config, buildRepositoriesForTools());
    const tool = tools.find((entry) => entry.name === "report_partial_followup_resolution");

    expect(tool).toBeDefined();

    const ok = await tool!.execute("tool-call-partial-followup-ok", {
      matchedIssueIds: ["AIC-87"],
      unmatchedTopics: ["議事録連携"],
      summary: "AIC-87 is matched but meeting-notes integration has no existing issue.",
    });
    expect(ok.details).toMatchObject({
      partialFollowupResolutionReport: {
        matchedIssueIds: ["AIC-87"],
        unmatchedTopics: ["議事録連携"],
      },
    });

    await expect(tool!.execute("tool-call-partial-followup-invalid", {
      matchedIssueIds: ["AIC-87", "AIC-87"],
      unmatchedTopics: ["議事録連携", "議事録連携"],
    })).rejects.toThrow(/duplicates/i);
  });

  it("returns dueRelativeLabel and daysUntilDue in review facts", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-03-24T08:00:00Z"));
      linearMocks.listOpenLinearIssues.mockResolvedValue([
        {
          id: "issue-parent",
          identifier: "AIC-39",
          title: "AIマネージャーを実用レベルへ引き上げる",
          url: "https://linear.app/kyaukyuai/issue/AIC-39",
          dueDate: "2026-03-26",
          state: { id: "state-review", name: "In Review", type: "started" },
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
          children: [],
        },
      ]);

      const tools = createManagerAgentTools(config, buildRepositoriesForTools());
      const tool = tools.find((entry) => entry.name === "linear_list_review_facts");

      expect(tool).toBeDefined();
      const result = await tool!.execute("tool-call-relative-due", { limit: 10 });
      const details = result.details as Array<Record<string, unknown>>;

      expect(linearMocks.listOpenLinearIssues).toHaveBeenCalledWith(
        expect.objectContaining({ LINEAR_TEAM_KEY: "AIC" }),
        undefined,
        { limit: 10 },
      );
      expect(details).toHaveLength(1);
      expect(details[0]).toMatchObject({
        identifier: "AIC-39",
        dueDate: "2026-03-26",
        daysUntilDue: 2,
        dueRelativeLabel: "2日後",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns review facts with explicit open and closed child issue state", async () => {
    linearMocks.listOpenLinearIssues.mockResolvedValue([
      {
        id: "issue-parent",
        identifier: "AIC-39",
        title: "AIマネージャーを実用レベルへ引き上げる",
        url: "https://linear.app/kyaukyuai/issue/AIC-39",
        state: { id: "state-backlog", name: "Backlog", type: "unstarted" },
        assignee: { id: "user-1", displayName: "y.kakui" },
        children: [
          {
            id: "issue-child",
            identifier: "AIC-41",
            title: "Notion連携の実装",
            url: "https://linear.app/kyaukyuai/issue/AIC-41",
          },
        ],
        relations: [],
        inverseRelations: [],
      },
    ]);
    linearMocks.getLinearIssue.mockResolvedValue({
      id: "issue-child",
      identifier: "AIC-41",
      title: "Notion連携の実装",
      url: "https://linear.app/kyaukyuai/issue/AIC-41",
      state: { id: "state-done", name: "Done", type: "done" },
      completedAt: "2026-03-23T08:56:11.797Z",
      relations: [],
      inverseRelations: [],
    });

    const tools = createManagerAgentTools(config, buildRepositoriesForTools());
    const tool = tools.find((entry) => entry.name === "linear_list_review_facts");

    expect(tool).toBeDefined();
    const result = await tool!.execute("tool-call-1", { limit: 10 });
    const details = result.details as Array<Record<string, unknown>>;

    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({
      identifier: "AIC-39",
      stateName: "Backlog",
      stateType: "unstarted",
      isOpen: true,
      openChildren: [],
      closedChildren: [
        expect.objectContaining({
          identifier: "AIC-41",
          stateName: "Done",
          stateType: "done",
          isOpen: false,
          completedAt: "2026-03-23T08:56:11.797Z",
        }),
      ],
    });
  });

  it("includes comment facts in linear_get_issue_facts", async () => {
    linearMocks.getLinearIssue.mockResolvedValue({
      id: "issue-1",
      identifier: "AIC-85",
      title: "Slackから自動収集してAIクローンに反映する仕組みの検討",
      url: "https://linear.app/kyaukyuai/issue/AIC-85",
      description: "どのような仕組みにすべきか検討したい。",
      state: { id: "state-backlog", name: "Backlog", type: "unstarted" },
      relations: [],
      inverseRelations: [],
      comments: [
        {
          id: "comment-1",
          body: `${WEBHOOK_INITIAL_PROPOSAL_MARKER}\n\n既存の初回提案コメント`,
          createdAt: "2026-03-27T02:25:00.000Z",
          user: { name: "cogito" },
        },
      ],
    });

    const tools = createManagerAgentTools(config, buildRepositoriesForTools());
    const tool = tools.find((entry) => entry.name === "linear_get_issue_facts");

    expect(tool).toBeDefined();
    const result = await tool!.execute("tool-call-issue-facts", { issueId: "AIC-85" });

    expect(result.details).toMatchObject({
      identifier: "AIC-85",
      commentCount: 1,
      comments: [
        expect.objectContaining({
          body: `${WEBHOOK_INITIAL_PROPOSAL_MARKER}\n\n既存の初回提案コメント`,
        }),
      ],
    });
  });

  it("lists project facts for project queries", async () => {
    linearMocks.listLinearProjects.mockResolvedValue([
      {
        id: "project-1",
        slugId: "auth-refresh",
        name: "Auth refresh",
        description: "Rotate sessions and clean up auth debt.",
        status: { id: "status-started", name: "Started", type: "started" },
        lead: { id: "user-1", name: "y.kakui", displayName: "y.kakui" },
        teams: [{ id: "team-aic", key: "AIC", name: "AI Clone" }],
        targetDate: "2026-04-30",
      },
    ]);

    const tools = createManagerAgentTools(config, buildRepositoriesForTools());
    const tool = tools.find((entry) => entry.name === "linear_list_project_facts");

    expect(tool).toBeDefined();
    const result = await tool!.execute("tool-call-project-list", { query: "auth", limit: 5 });
    const details = result.details as Array<Record<string, unknown>>;

    expect(linearMocks.listLinearProjects).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "auth",
        limit: 5,
      }),
      expect.objectContaining({
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_TEAM_KEY: "AIC",
      }),
      undefined,
    );
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({
      slugId: "auth-refresh",
      name: "Auth refresh",
      statusName: "Started",
      teams: [expect.objectContaining({ key: "AIC" })],
      targetDate: "2026-04-30",
    });
  });

  it("includes exact project membership in active issue facts", async () => {
    linearMocks.listOpenLinearIssues.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "AIC-101",
        title: "Read cloned dialog summaries",
        state: { id: "state-backlog", name: "Backlog", type: "backlog" },
        project: {
          id: "project-1",
          name: "ai-clone",
          slugId: "b97730114138",
        },
        relations: [],
        inverseRelations: [],
      },
    ]);

    const tools = createManagerAgentTools(config, buildRepositoriesForTools());
    const tool = tools.find((entry) => entry.name === "linear_list_active_issue_facts");

    expect(tool).toBeDefined();
    const result = await tool!.execute("tool-call-issue-list", { limit: 5 });
    const details = result.details as Array<Record<string, unknown>>;

    expect(linearMocks.listOpenLinearIssues).toHaveBeenCalledWith(
      expect.objectContaining({ LINEAR_TEAM_KEY: "AIC" }),
      undefined,
      { limit: 5 },
    );
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({
      identifier: "AIC-101",
      project: {
        name: "ai-clone",
        slugId: "b97730114138",
      },
    });
  });

  it("returns one project fact for linear_get_project_facts", async () => {
    linearMocks.getLinearProject.mockResolvedValue({
      id: "project-1",
      slugId: "auth-refresh",
      name: "Auth refresh",
      description: "Rotate sessions and clean up auth debt.",
      status: { id: "status-planned", name: "Planned", type: "planned" },
      lead: { id: "user-1", name: "y.kakui", displayName: "y.kakui" },
      teams: [{ id: "team-aic", key: "AIC", name: "AI Clone" }],
      issueSummary: { total: 4, completed: 1, started: 2, unstarted: 1, backlog: 1, triage: 0, canceled: 0 },
    });

    const tools = createManagerAgentTools(config, buildRepositoriesForTools());
    const tool = tools.find((entry) => entry.name === "linear_get_project_facts");

    expect(tool).toBeDefined();
    const result = await tool!.execute("tool-call-project-get", { projectIdOrSlug: "auth-refresh" });

    expect(linearMocks.getLinearProject).toHaveBeenCalledWith(
      "auth-refresh",
      expect.objectContaining({
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_TEAM_KEY: "AIC",
      }),
      undefined,
    );
    expect(result.details).toMatchObject({
      slugId: "auth-refresh",
      name: "Auth refresh",
      statusName: "Planned",
      issueSummary: {
        total: 4,
        started: 2,
      },
    });
  });

  it("lists unified custom and built-in schedules", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "manager-agent-tools-scheduler-"));
    tempDirs.push(workspaceDir);
    const systemPaths = buildSystemPaths(workspaceDir);
    await ensureManagerStateFiles(systemPaths);
    await writeFile(systemPaths.jobsFile, `${JSON.stringify([
      {
        id: "custom-daily-check",
        enabled: true,
        channelId: "C0ALAMDRB9V",
        prompt: "custom prompt",
        kind: "daily",
        time: "11:00",
      },
      {
        id: "manager-review-evening",
        enabled: true,
        channelId: "C0ALAMDRB9V",
        prompt: "manager review: evening",
        kind: "daily",
        time: "17:00",
        action: "evening-review",
      },
    ], null, 2)}\n`, "utf8");

    const tools = createManagerAgentTools(
      { ...config, workspaceDir },
      buildRepositoriesForTools(),
    );
    const tool = tools.find((entry) => entry.name === "scheduler_list_schedules");

    expect(tool).toBeDefined();
    const result = await tool!.execute("tool-call-schedules", {});
    const details = result.details as Array<Record<string, unknown>>;

    expect(details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "manager-review-evening",
          kind: "evening-review",
          source: "policy",
          scheduleType: "daily",
        }),
        expect.objectContaining({
          id: "custom-daily-check",
          kind: "custom-job",
          source: "jobs",
          scheduleType: "daily",
          time: "11:00",
        }),
        expect.objectContaining({
          id: "heartbeat",
          kind: "heartbeat",
          source: "policy",
        }),
      ]),
    );
  });

  it("shows full Notion page lines in the default content window when they fit", async () => {
    notionMocks.getNotionPageContent.mockResolvedValueOnce({
      id: "notion-page-1",
      title: "AIクローンプラットフォーム 初回会議共有資料",
      url: "https://www.notion.so/notion-page-1",
      excerpt: "初回会議の概要",
      lines: [
        { text: "1. 本日の確認事項" },
        { text: "2. 3ヶ月後の金澤クローンのゴール" },
        { text: "3. その先に目指すビジョン" },
        { text: "4. NotebookLM との違い" },
        { text: "5. 今回の実施スコープ" },
        { text: "6. 3ヶ月の進め方" },
        { text: "7. 本日合意したいこと" },
      ],
    });

    const tools = createManagerAgentTools(config, buildRepositoriesForTools());
    const tool = tools.find((entry) => entry.name === "notion_get_page_content");

    expect(tool).toBeDefined();
    const result = await tool!.execute("tool-call-notion-content", { pageId: "notion-page-1" });
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("Extracted page lines: 7 total.");
    expect(text).toContain("Page lines (1-7 of 7):");
    expect(text).toContain("6. 3ヶ月の進め方");
    expect(text).toContain("7. 本日合意したいこと");
  });

  it("supports continuing through a longer Notion page with startLine", async () => {
    notionMocks.getNotionPageContent.mockResolvedValueOnce({
      id: "notion-page-1",
      title: "AIクローンプラットフォーム 初回会議共有資料",
      url: "https://www.notion.so/notion-page-1",
      excerpt: "初回会議の概要",
      lines: Array.from({ length: 61 }, (_, index) => ({ text: `Line ${index + 1}` })),
    });

    const tools = createManagerAgentTools(config, buildRepositoriesForTools());
    const tool = tools.find((entry) => entry.name === "notion_get_page_content");

    expect(tool).toBeDefined();
    const result = await tool!.execute("tool-call-notion-content", { pageId: "notion-page-1", startLine: 21, maxLines: 20 });
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("Extracted page lines: 61 total.");
    expect(text).toContain("Page lines (21-40 of 61):");
    expect(text).toContain("Line 21");
    expect(text).toContain("Line 40");
    expect(text).toContain("Call notion_get_page_content again with startLine=41");
  });

  it("includes a dedicated workspace memory proposal tool", async () => {
    const tools = createManagerAgentTools(config, buildRepositoriesForTools());

    expect(tools.some((entry) => entry.name === "propose_update_workspace_memory")).toBe(true);
  });

  it("includes dedicated workspace config read and proposal tools", async () => {
    const tools = createManagerAgentTools(config, buildRepositoriesForTools());

    expect(tools.some((entry) => entry.name === "workspace_get_agenda_template")).toBe(true);
    expect(tools.some((entry) => entry.name === "workspace_get_heartbeat_prompt")).toBe(true);
    expect(tools.some((entry) => entry.name === "workspace_get_owner_map")).toBe(true);
    expect(tools.some((entry) => entry.name === "propose_replace_workspace_text_file")).toBe(true);
    expect(tools.some((entry) => entry.name === "propose_update_owner_map")).toBe(true);
    expect(tools.some((entry) => entry.name === "propose_post_slack_message")).toBe(true);
  });

  it("includes a structured existing-issue reuse proposal tool", async () => {
    const tools = createManagerAgentTools(config, buildRepositoriesForTools());

    expect(tools.some((entry) => entry.name === "propose_link_existing_issue")).toBe(true);
  });

  it("includes an LLM-assisted duplicate resolution tool", async () => {
    const tools = createManagerAgentTools(config, buildRepositoriesForTools());

    expect(tools.some((entry) => entry.name === "linear_resolve_duplicate_candidates")).toBe(true);
  });

  it("includes duplicate candidate search with deterministic multi-query recall", async () => {
    linearMocks.searchLinearIssues.mockImplementation(async ({ query }: { query: string }) => {
      if (/chatgpt/.test(query) || /プロジェクト 招待/.test(query)) {
        return [{
          id: "issue-61",
          identifier: "AIC-61",
          title: "金澤さんのChatGPTプロジェクトに角井さんを招待してもらう",
          url: "https://linear.app/kyaukyuai/issue/AIC-61",
          state: { id: "state-backlog", name: "Backlog", type: "unstarted" },
          updatedAt: "2026-03-27T06:00:00.000Z",
          relations: [],
          inverseRelations: [],
        }];
      }
      return [];
    });

    const tools = createManagerAgentTools(config, buildRepositoriesForTools());
    const tool = tools.find((entry) => entry.name === "linear_find_duplicate_candidates");

    expect(tool).toBeDefined();

    const result = await tool!.execute("tool-call-duplicate-candidates", {
      text: "金澤さんのChatGPTのプロジェクト招待",
    });

    expect(linearMocks.searchLinearIssues).toHaveBeenCalledTimes(5);
    expect(result.details).toMatchObject([
      {
        identifier: "AIC-61",
        matchedQueries: expect.arrayContaining(["金澤 chatgpt プロジェクト 招待", "プロジェクト 招待"]),
        matchedTokenCount: 4,
      },
    ]);
  });

  it("skips LLM duplicate recall when deterministic search finds one exact lexical match", async () => {
    linearMocks.searchLinearIssues.mockImplementation(async () => [{
      id: "issue-87",
      identifier: "AIC-87",
      title: "金澤さんにMTG定例名を確認する",
      url: "https://linear.app/kyaukyuai/issue/AIC-87",
      state: { id: "state-backlog", name: "Backlog", type: "unstarted" },
      updatedAt: "2026-03-27T06:00:00.000Z",
      relations: [],
      inverseRelations: [],
    }]);
    const runDuplicateRecallTurn = vi.fn();

    const tools = createManagerAgentTools(config, buildRepositoriesForTools(), { runDuplicateRecallTurn });
    const tool = tools.find((entry) => entry.name === "linear_resolve_duplicate_candidates");

    expect(tool).toBeDefined();
    const result = await tool!.execute("tool-call-duplicate-resolve-exact", {
      text: "金澤さんにMTG定例名を確認する",
    });

    expect(runDuplicateRecallTurn).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      assessment: {
        assessmentStatus: "exact",
        recommendedAction: "link_existing",
        selectedIssueId: "AIC-87",
      },
      finalCandidates: [
        expect.objectContaining({ identifier: "AIC-87" }),
      ],
    });
  });

  it("uses LLM duplicate recall extra queries to surface an existing issue", async () => {
    linearMocks.searchLinearIssues.mockImplementation(async ({ query }: { query: string }) => {
      if (query === "角井 chatgpt 招待") {
        return [{
          id: "issue-61",
          identifier: "AIC-61",
          title: "金澤さんのChatGPTプロジェクトに角井さんを招待してもらう",
          url: "https://linear.app/kyaukyuai/issue/AIC-61",
          state: { id: "state-backlog", name: "Backlog", type: "unstarted" },
          updatedAt: "2026-03-27T06:00:00.000Z",
          relations: [],
          inverseRelations: [],
        }];
      }
      return [];
    });
    const runDuplicateRecallTurn = vi.fn()
      .mockResolvedValueOnce({
        assessmentStatus: "no_match",
        recommendedAction: "create_new",
        reasonSummary: "追加の lexical query を試したいです。",
        missingSlots: [],
        extraQueries: ["角井 chatgpt 招待"],
      })
      .mockResolvedValueOnce({
        assessmentStatus: "exact",
        recommendedAction: "link_existing",
        selectedIssueId: "AIC-61",
        reasonSummary: "角井さん招待まで含む既存 issue に一致します。",
        missingSlots: [],
        extraQueries: [],
      });

    const tools = createManagerAgentTools(config, buildRepositoriesForTools(), { runDuplicateRecallTurn });
    const tool = tools.find((entry) => entry.name === "linear_resolve_duplicate_candidates");

    expect(tool).toBeDefined();
    const result = await tool!.execute("tool-call-duplicate-resolve-extra-query", {
      text: "金澤さんのChatGPTのプロジェクト招待",
    });

    expect(runDuplicateRecallTurn).toHaveBeenCalledTimes(2);
    expect(result.details).toMatchObject({
      extraQueries: ["角井 chatgpt 招待"],
      assessment: {
        assessmentStatus: "exact",
        recommendedAction: "link_existing",
        selectedIssueId: "AIC-61",
      },
      finalCandidates: [
        expect.objectContaining({ identifier: "AIC-61" }),
      ],
    });
  });

  it("falls back to lexical-only unavailable assessment when LLM duplicate recall fails", async () => {
    linearMocks.searchLinearIssues.mockImplementation(async ({ query }: { query: string }) => {
      if (/chatgpt/.test(query)) {
        return [{
          id: "issue-61",
          identifier: "AIC-61",
          title: "金澤さんのChatGPTプロジェクトに角井さんを招待してもらう",
          url: "https://linear.app/kyaukyuai/issue/AIC-61",
          state: { id: "state-backlog", name: "Backlog", type: "unstarted" },
          updatedAt: "2026-03-27T06:00:00.000Z",
          relations: [],
          inverseRelations: [],
        }];
      }
      return [];
    });
    const runDuplicateRecallTurn = vi.fn().mockRejectedValue(new Error("planner failed"));

    const tools = createManagerAgentTools(config, buildRepositoriesForTools(), { runDuplicateRecallTurn });
    const tool = tools.find((entry) => entry.name === "linear_resolve_duplicate_candidates");

    expect(tool).toBeDefined();
    const result = await tool!.execute("tool-call-duplicate-resolve-failure", {
      text: "金澤さんのChatGPTのプロジェクト招待",
    });

    expect(result.details).toMatchObject({
      assessment: {
        assessmentStatus: "unavailable",
        recommendedAction: "clarify",
      },
      finalCandidates: [
        expect.objectContaining({ identifier: "AIC-61" }),
      ],
    });
  });

  it("lists and reads stored thread attachments", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-attachments-"));
    tempDirs.push(workspaceDir);
    const localConfig: AppConfig = {
      ...config,
      workspaceDir,
    };
    const paths = buildThreadPaths(workspaceDir, "C0ALAMDRB9V", "111.000");
    await ensureThreadWorkspace(paths);
    const artifactsDir = buildThreadAttachmentArtifactsDir(paths);
    await mkdir(artifactsDir, { recursive: true });
    const artifactPath = join(artifactsDir, "111.666-F123.extracted.txt");
    await writeFile(artifactPath, "第一条\n第二条\n第三条\n", "utf8");
    await saveThreadAttachmentCatalog(paths, {
      entries: [
        {
          attachmentId: "111.666-F123",
          sourceAttachmentId: "F123",
          sourceMessageTs: "111.666",
          name: "contract.txt",
          mimeType: "text/plain",
          storedPath: join(paths.attachmentsDir, "F123-contract.txt"),
          kind: "document",
          previewText: "第一条\n第二条",
          createdAt: "2026-03-30T01:36:00.000Z",
          updatedAt: "2026-03-30T01:36:00.000Z",
          extraction: {
            status: "completed",
            artifactPath,
            lineCount: 3,
          },
          transcription: {
            status: "not_applicable",
          },
        },
      ],
    });

    const tools = createManagerAgentTools(localConfig, buildRepositoriesForTools());
    const listTool = tools.find((entry) => entry.name === "slack_list_thread_attachments");
    const readTool = tools.find((entry) => entry.name === "slack_read_thread_attachment");

    expect(listTool).toBeDefined();
    expect(readTool).toBeDefined();

    const listResult = await listTool!.execute("tool-call-list-attachments", {
      channelId: "C0ALAMDRB9V",
      threadTs: "111.000",
      sourceMessageTs: "111.666",
    });
    expect(listResult.content[0]?.text).toContain("contract.txt");
    expect(listResult.content[0]?.text).toContain("extractionStatus: completed");

    const readResult = await readTool!.execute("tool-call-read-attachment", {
      channelId: "C0ALAMDRB9V",
      threadTs: "111.000",
      attachmentId: "111.666-F123",
      maxLines: 2,
    });
    expect(readResult.content[0]?.text).toContain("Attachment: contract.txt");
    expect(readResult.content[0]?.text).toContain("Lines (1-2 of 3):");
    expect(readResult.content[0]?.text).toContain("第一条");
    expect(readResult.content[0]?.text).toContain("More lines are available.");
  });
});
