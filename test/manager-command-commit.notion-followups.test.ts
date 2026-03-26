import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitManagerCommandProposals } from "../src/lib/manager-command-commit.js";
import { buildSystemPaths } from "../src/lib/system-workspace.js";
import { saveThreadNotionPageTarget } from "../src/lib/thread-notion-page-target.js";
import { buildThreadPaths } from "../src/lib/thread-workspace.js";
import {
  buildLinearTestEnv,
  cleanupManagerCommandCommitTestContext,
  createManagerCommandCommitTestContext,
  type ManagerCommandCommitTestContext,
} from "./manager-command-commit-test-support.js";

const linearMocks = vi.hoisted(() => ({
  getLinearIssue: vi.fn(),
}));

const notionMocks = vi.hoisted(() => ({
  archiveNotionPage: vi.fn(),
  createNotionAgendaPage: vi.fn(),
  updateNotionPage: vi.fn(),
}));

vi.mock("../src/lib/linear.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/linear.js")>("../src/lib/linear.js");
  return {
    ...actual,
    getLinearIssue: linearMocks.getLinearIssue,
  };
});

vi.mock("../src/lib/notion.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/notion.js")>("../src/lib/notion.js");
  return {
    ...actual,
    archiveNotionPage: notionMocks.archiveNotionPage,
    createNotionAgendaPage: notionMocks.createNotionAgendaPage,
    updateNotionPage: notionMocks.updateNotionPage,
  };
});

describe("manager command commit notion and followups", () => {
  let testContext: ManagerCommandCommitTestContext;

  beforeEach(async () => {
    testContext = await createManagerCommandCommitTestContext();
    linearMocks.getLinearIssue.mockReset();
    notionMocks.archiveNotionPage.mockReset();
    notionMocks.createNotionAgendaPage.mockReset();
    notionMocks.updateNotionPage.mockReset();
  });

  afterEach(async () => {
    await cleanupManagerCommandCommitTestContext(testContext.workspaceDir);
  });

  it("rejects owner follow-up resolutions without an assignee", async () => {
    await writeFile(
      buildSystemPaths(testContext.workspaceDir).followupsFile,
      `${JSON.stringify([
        {
          issueId: "AIC-960",
          requestKind: "owner",
          status: "awaiting-response",
          requestText: "担当者を共有してください。",
        },
      ], null, 2)}\n`,
      "utf8",
    );

    const result = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "resolve_followup",
          issueId: "AIC-960",
          answered: true,
          confidence: 0.92,
          requestKind: "owner",
          responseText: "担当は確認中です。",
          reasonSummary: "follow-up に返答があったと判断しました。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-followup-owner",
        messageTs: "msg-followup-1",
        userId: "U1",
        text: "担当は確認中です",
      },
      now: new Date("2026-03-19T03:00:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.committed).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain("担当者名");
    expect(linearMocks.getLinearIssue).not.toHaveBeenCalled();
  });

  it("creates a Notion agenda under the configured parent page", async () => {
    notionMocks.createNotionAgendaPage.mockResolvedValueOnce({
      id: "notion-page-1",
      object: "page",
      title: "AIクローン会議アジェンダ",
      url: "https://www.notion.so/notion-page-1",
      createdTime: "2026-03-24T00:00:00.000Z",
    });

    const result = await commitManagerCommandProposals({
      config: {
        ...testContext.config,
        notionApiToken: "secret_test",
        notionAgendaParentPageId: "parent-page-1",
      },
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "create_notion_agenda",
          title: "AIクローン会議アジェンダ",
          summary: "キックオフ用の論点整理です。",
          sections: [{ heading: "議題", bullets: ["PoC 対象範囲", "役割分担"] }],
          reasonSummary: "Notion に会議用アジェンダを作る依頼です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-notion-agenda",
        messageTs: "msg-notion-agenda-1",
        userId: "U1",
        text: "Notion にアジェンダを作って",
      },
      now: new Date("2026-03-24T00:05:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.committed).toHaveLength(1);
    expect(notionMocks.createNotionAgendaPage).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "AIクローン会議アジェンダ",
        parentPageId: "parent-page-1",
        summary: "キックオフ用の論点整理です。",
      }),
      expect.objectContaining({ NOTION_API_TOKEN: "secret_test" }),
    );
    expect(result.committed[0]?.summary).toContain("Notion agenda created:");
    expect(result.committed[0]?.summary).toContain("<https://www.notion.so/notion-page-1|AIクローン会議アジェンダ>");
  });

  it("rejects a Notion agenda proposal when no parent page is configured", async () => {
    const result = await commitManagerCommandProposals({
      config: { ...testContext.config, notionApiToken: "secret_test", notionAgendaParentPageId: undefined },
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "create_notion_agenda",
          title: "AIクローン会議アジェンダ",
          reasonSummary: "Notion に会議用アジェンダを作る依頼です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-notion-agenda-missing-parent",
        messageTs: "msg-notion-agenda-2",
        userId: "U1",
        text: "Notion にアジェンダを作って",
      },
      now: new Date("2026-03-24T00:06:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.committed).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain("NOTION_AGENDA_PARENT_PAGE_ID");
    expect(notionMocks.createNotionAgendaPage).not.toHaveBeenCalled();
  });

  it("updates a Notion page title and appends content", async () => {
    notionMocks.updateNotionPage.mockResolvedValueOnce({
      id: "notion-page-2",
      object: "page",
      title: "更新後の議事録",
      url: "https://www.notion.so/notion-page-2",
      lastEditedTime: "2026-03-24T01:00:00.000Z",
      raw: {},
    });

    const result = await commitManagerCommandProposals({
      config: { ...testContext.config, notionApiToken: "secret_test" },
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "update_notion_page",
          pageId: "notion-page-2",
          mode: "append",
          title: "更新後の議事録",
          summary: "会議後の補足です。",
          sections: [{ heading: "次のアクション", bullets: ["担当を確認する"] }],
          reasonSummary: "直前の Notion ページに追記する依頼です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-notion-update",
        messageTs: "msg-notion-update-1",
        userId: "U1",
        text: "そのページに追記して",
      },
      now: new Date("2026-03-24T01:02:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.committed).toHaveLength(1);
    expect(notionMocks.updateNotionPage).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: "notion-page-2",
        mode: "append",
        title: "更新後の議事録",
        summary: "会議後の補足です。",
        sections: [{ heading: "次のアクション", bullets: ["担当を確認する"] }],
      }),
      expect.objectContaining({ NOTION_API_TOKEN: "secret_test" }),
    );
    expect(result.committed[0]?.summary).toContain("Notion page updated:");
    expect(result.committed[0]?.summary).toContain("<https://www.notion.so/notion-page-2|更新後の議事録>");
  });

  it("prefers the current active thread Notion page target over a stale page id for generic follow-ups", async () => {
    const threadPaths = buildThreadPaths(testContext.workspaceDir, "C0ALAMDRB9V", "thread-notion-current-target");
    await saveThreadNotionPageTarget(threadPaths, {
      pageId: "notion-page-current",
      title: "2026.03.25 | AIクローンプラットフォーム",
      url: "https://www.notion.so/notion-page-current",
      recordedAt: "2026-03-25T03:00:00.000Z",
    });

    notionMocks.updateNotionPage.mockResolvedValueOnce({
      id: "notion-page-current",
      object: "page",
      title: "2026.03.25 | AIクローンプラットフォーム",
      url: "https://www.notion.so/notion-page-current",
      lastEditedTime: "2026-03-25T03:01:00.000Z",
      raw: {},
    });

    const result = await commitManagerCommandProposals({
      config: { ...testContext.config, notionApiToken: "secret_test" },
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "update_notion_page",
          pageId: "notion-page-archived-old",
          mode: "append",
          summary: "決定事項を追記しました。",
          reasonSummary: "同じ thread の Notion ページに決定事項を追記する依頼です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-notion-current-target",
        messageTs: "msg-notion-current-target-1",
        userId: "U1",
        text: "Notion に決定事項を追記しておいて",
      },
      now: new Date("2026-03-25T03:01:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.committed).toHaveLength(1);
    expect(notionMocks.updateNotionPage).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: "notion-page-current",
        mode: "append",
        summary: "決定事項を追記しました。",
      }),
      expect.objectContaining({ NOTION_API_TOKEN: "secret_test" }),
    );
    expect(result.committed[0]?.notionPageTargetEffect).toEqual({
      action: "set-active",
      pageId: "notion-page-current",
      title: "2026.03.25 | AIクローンプラットフォーム",
      url: "https://www.notion.so/notion-page-current",
    });
  });

  it("registers created Notion agenda pages as managed pages", async () => {
    notionMocks.createNotionAgendaPage.mockResolvedValueOnce({
      id: "notion-page-managed",
      object: "page",
      title: "会議アジェンダ",
      url: "https://www.notion.so/notion-page-managed",
      createdTime: "2026-03-24T01:05:00.000Z",
    });

    const result = await commitManagerCommandProposals({
      config: {
        ...testContext.config,
        notionApiToken: "secret_test",
        notionAgendaParentPageId: "parent-page-1",
      },
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "create_notion_agenda",
          title: "会議アジェンダ",
          reasonSummary: "Notion に agenda を作る依頼です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-notion-managed",
        messageTs: "msg-notion-managed-1",
        userId: "U1",
        text: "Notion に agenda を作って",
      },
      now: new Date("2026-03-24T01:05:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.committed).toHaveLength(1);
    await expect(testContext.repositories.notionPages.load()).resolves.toEqual([
      expect.objectContaining({
        pageId: "notion-page-managed",
        pageKind: "agenda",
        title: "会議アジェンダ",
        url: "https://www.notion.so/notion-page-managed",
        managedBy: "cogito",
      }),
    ]);
  });

  it("replaces one managed Notion section by heading", async () => {
    await testContext.repositories.notionPages.save([
      {
        pageId: "notion-page-managed",
        pageKind: "agenda",
        title: "管理ページ",
        url: "https://www.notion.so/notion-page-managed",
        createdAt: "2026-03-24T01:00:00.000Z",
        managedBy: "cogito",
      },
    ]);
    notionMocks.updateNotionPage.mockResolvedValueOnce({
      id: "notion-page-managed",
      object: "page",
      title: "管理ページ",
      url: "https://www.notion.so/notion-page-managed",
      lastEditedTime: "2026-03-24T01:06:00.000Z",
      raw: {},
    });

    const result = await commitManagerCommandProposals({
      config: { ...testContext.config, notionApiToken: "secret_test" },
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "update_notion_page",
          pageId: "notion-page-managed",
          mode: "replace_section",
          sectionHeading: "議題",
          bullets: ["優先順位を更新する"],
          reasonSummary: "議題セクションを置き換える依頼です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-notion-replace",
        messageTs: "msg-notion-replace-1",
        userId: "U1",
        text: "議題を更新して",
      },
      now: new Date("2026-03-24T01:06:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.committed).toHaveLength(1);
    expect(notionMocks.updateNotionPage).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: "notion-page-managed",
        mode: "replace_section",
        sectionHeading: "議題",
        bullets: ["優先順位を更新する"],
      }),
      expect.objectContaining({ NOTION_API_TOKEN: "secret_test" }),
    );
    expect(result.committed[0]?.summary).toContain("Notion section updated:");
  });

  it("rejects replace_section updates for unregistered pages", async () => {
    const result = await commitManagerCommandProposals({
      config: { ...testContext.config, notionApiToken: "secret_test" },
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "update_notion_page",
          pageId: "notion-page-unmanaged",
          mode: "replace_section",
          sectionHeading: "議題",
          paragraph: "更新内容です。",
          reasonSummary: "未登録ページを更新したい依頼です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-notion-replace-reject",
        messageTs: "msg-notion-replace-reject-1",
        userId: "U1",
        text: "議題を更新して",
      },
      now: new Date("2026-03-24T01:07:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.committed).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain("コギト管理ページのみ");
    expect(notionMocks.updateNotionPage).not.toHaveBeenCalled();
  });

  it("archives a Notion page for a delete request", async () => {
    notionMocks.archiveNotionPage.mockResolvedValueOnce({
      id: "notion-page-3",
      object: "page",
      title: "削除対象ページ",
      url: "https://www.notion.so/notion-page-3",
      inTrash: true,
      raw: {},
    });

    const result = await commitManagerCommandProposals({
      config: { ...testContext.config, notionApiToken: "secret_test" },
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "archive_notion_page",
          pageId: "notion-page-3",
          reasonSummary: "不要になった Notion ページを削除したい依頼です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-notion-archive",
        messageTs: "msg-notion-archive-1",
        userId: "U1",
        text: "そのページを削除して",
      },
      now: new Date("2026-03-24T01:03:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.committed).toHaveLength(1);
    expect(notionMocks.archiveNotionPage).toHaveBeenCalledWith(
      "notion-page-3",
      expect.objectContaining({ NOTION_API_TOKEN: "secret_test" }),
    );
    expect(result.committed[0]?.summary).toContain("Notion page archived:");
    expect(result.committed[0]?.summary).toContain("<https://www.notion.so/notion-page-3|削除対象ページ>");
  });
});
