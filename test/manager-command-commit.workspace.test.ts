import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitManagerCommandProposals } from "../src/lib/manager-command-commit.js";
import { buildSystemPaths } from "../src/lib/system-workspace.js";
import {
  buildLinearTestEnv,
  cleanupManagerCommandCommitTestContext,
  createManagerCommandCommitTestContext,
  type ManagerCommandCommitTestContext,
} from "./manager-command-commit-test-support.js";

describe("manager command commit workspace", () => {
  let testContext: ManagerCommandCommitTestContext;

  beforeEach(async () => {
    testContext = await createManagerCommandCommitTestContext();
  });

  afterEach(async () => {
    await cleanupManagerCommandCommitTestContext(testContext.workspaceDir);
  });

  it("updates workspace memory explicitly from durable entries", async () => {
    const result = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "update_workspace_memory",
          sourceLabel: "2026.03.10 | AIクローンプラットフォーム 初回会議共有資料",
          entries: [
            {
              category: "project-overview",
              projectName: "AIクローンプラットフォーム",
              summary: "AIクローンプラットフォームプロジェクトはコギトとの協働プロジェクト",
              canonicalText: "AIクローンプラットフォームプロジェクトはコギト社との協働プロジェクトであり、金澤クローンを中心としたPoCが主テーマ。",
            },
            {
              category: "roadmap-and-milestones",
              projectName: "AIクローンプラットフォーム",
              summary: "初回PoCでは金澤クローンのSlack運用到達を目標にする",
              canonicalText: "初回PoCでは、金澤クローンがSlack上で日常相談に耐える状態まで到達することを目標にする。",
            },
          ],
          reasonSummary: "Notion の概要資料を MEMORY に保存する依頼です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-memory-update",
        messageTs: "msg-memory-update-1",
        userId: "U1",
        text: "この資料の概要を MEMORY に保存しておいて",
      },
      now: new Date("2026-03-25T01:14:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.committed).toHaveLength(1);
    expect(result.committed[0]?.summary).toContain("Workspace MEMORY を更新しました。");
    expect(result.committed[0]?.summary).toContain("2026.03.10 | AIクローンプラットフォーム 初回会議共有資料");

    const memory = await readFile(buildSystemPaths(testContext.workspaceDir).memoryFile, "utf8");
    expect(memory).toContain("## Projects");
    expect(memory).toContain("### AIクローンプラットフォーム");
    expect(memory).toContain("AIクローンプラットフォームプロジェクトはコギト社との協働プロジェクト");
    expect(memory).toContain("初回PoCでは、金澤クローンがSlack上で日常相談に耐える状態まで到達することを目標にする。");
  });

  it("rejects issue-level roadmap memory entries", async () => {
    const result = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "update_workspace_memory",
          entries: [
            {
              category: "roadmap-and-milestones",
              projectName: "AIクローンプラットフォーム",
              summary: "AIC-38 の現在期限",
              canonicalText: "AIC-38 は 2026-03-27 期限で現在 Backlog のままです。",
            },
          ],
          reasonSummary: "一時的な task 状態を保存しようとしたケースです。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-memory-update-reject",
        messageTs: "msg-memory-update-reject-1",
        userId: "U1",
        text: "AIC-38 の期限を MEMORY に保存しておいて",
      },
      now: new Date("2026-03-25T01:15:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.committed).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain("project-level milestones only");
  });

  it("replaces the agenda template immediately through manager commit", async () => {
    const result = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "replace_workspace_text_file",
          target: "agenda-template",
          content: "## 目的\n- 方針確認\n## 議題\n- 期限整理",
          reasonSummary: "agenda template の明示更新依頼です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-agenda-template",
        messageTs: "msg-agenda-template-1",
        userId: "U1",
        text: "AGENDA_TEMPLATE.md をこの内容で更新して",
      },
      now: new Date("2026-03-26T01:00:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.pendingConfirmation).toBeUndefined();
    expect(result.rejected).toEqual([]);
    expect(result.committed).toEqual([
      expect.objectContaining({
        commandType: "replace_workspace_text_file",
        summary: "AGENDA_TEMPLATE.md を更新しました。",
      }),
    ]);
    await expect(readFile(buildSystemPaths(testContext.workspaceDir).agendaTemplateFile, "utf8")).resolves.toBe("## 目的\n- 方針確認\n## 議題\n- 期限整理\n");
  });

  it("replaces the heartbeat prompt immediately through manager commit", async () => {
    const result = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "replace_workspace_text_file",
          target: "heartbeat-prompt",
          content: "現在の blocked issue だけ短く知らせてください。",
          reasonSummary: "heartbeat prompt の明示更新依頼です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-heartbeat-template",
        messageTs: "msg-heartbeat-template-1",
        userId: "U1",
        text: "HEARTBEAT.md をこの内容で更新して",
      },
      now: new Date("2026-03-26T01:01:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.pendingConfirmation).toBeUndefined();
    expect(result.rejected).toEqual([]);
    expect(result.committed).toEqual([
      expect.objectContaining({
        commandType: "replace_workspace_text_file",
        summary: "HEARTBEAT.md を更新しました。",
      }),
    ]);
    await expect(readFile(buildSystemPaths(testContext.workspaceDir).heartbeatPromptFile, "utf8")).resolves.toBe("現在の blocked issue だけ短く知らせてください。\n");
  });

  it("returns an owner-map preview before confirmation", async () => {
    const before = await testContext.repositories.ownerMap.load();
    const result = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "update_owner_map",
          operation: "upsert-entry",
          entryId: "opt",
          linearAssignee: "t.tahira",
          domains: ["sales"],
          keywords: ["OPT"],
          primary: false,
          reasonSummary: "OPT 担当 mapping の追加依頼です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-owner-map-preview",
        messageTs: "msg-owner-map-preview-1",
        userId: "U1",
        text: "owner-map に OPT 担当を追加して",
      },
      now: new Date("2026-03-26T01:02:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.committed).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.pendingConfirmation).toMatchObject({
      kind: "owner-map",
      previewSummaryLines: ["entry opt を追加/更新"],
    });
    await expect(testContext.repositories.ownerMap.load()).resolves.toEqual(before);
  });

  it("commits owner-map changes only after explicit confirmation mode", async () => {
    const proposals = [
      {
        commandType: "update_owner_map" as const,
        operation: "set-default-owner" as const,
        defaultOwner: "y.kakui",
        reasonSummary: "fallback owner を変更する依頼です。",
      },
      {
        commandType: "update_owner_map" as const,
        operation: "upsert-entry" as const,
        entryId: "opt",
        linearAssignee: "t.tahira",
        domains: ["sales"],
        keywords: ["OPT"],
        primary: false,
        reasonSummary: "OPT 担当 mapping の追加依頼です。",
      },
    ];
    const result = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals,
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-owner-map-confirm",
        messageTs: "msg-owner-map-confirm-1",
        userId: "U1",
        text: "はい",
      },
      now: new Date("2026-03-26T01:03:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
      ownerMapConfirmationMode: "confirm",
    });

    expect(result.pendingConfirmation).toBeUndefined();
    expect(result.rejected).toEqual([]);
    expect(result.committed).toHaveLength(2);
    await expect(testContext.repositories.ownerMap.load()).resolves.toEqual({
      defaultOwner: "y.kakui",
      entries: expect.arrayContaining([
        expect.objectContaining({ id: "kyaukyuai" }),
        expect.objectContaining({
          id: "opt",
          linearAssignee: "t.tahira",
          domains: ["sales"],
          keywords: ["OPT"],
        }),
      ]),
    });
  });
});
