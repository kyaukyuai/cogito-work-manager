import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitManagerCommandProposals } from "../src/lib/manager-command-commit.js";
import { recordPlanningOutcome } from "../src/state/workgraph/recorder.js";
import {
  buildLinearTestEnv,
  cleanupManagerCommandCommitTestContext,
  createManagerCommandCommitTestContext,
  type ManagerCommandCommitTestContext,
} from "./manager-command-commit-test-support.js";

const linearMocks = vi.hoisted(() => ({
  addLinearComment: vi.fn(),
  addLinearProgressComment: vi.fn(),
  addLinearRelation: vi.fn(),
  assignLinearIssue: vi.fn(),
  createManagedLinearIssue: vi.fn(),
  createManagedLinearIssueBatch: vi.fn(),
  getLinearIssue: vi.fn(),
  searchLinearIssues: vi.fn(),
  updateManagedLinearIssue: vi.fn(),
  updateLinearIssueStateWithComment: vi.fn(),
}));

const slackContextMocks = vi.hoisted(() => ({
  getSlackThreadContext: vi.fn(),
}));

vi.mock("../src/lib/linear.js", () => ({
  addLinearComment: linearMocks.addLinearComment,
  addLinearProgressComment: linearMocks.addLinearProgressComment,
  addLinearRelation: linearMocks.addLinearRelation,
  assignLinearIssue: linearMocks.assignLinearIssue,
  createManagedLinearIssue: linearMocks.createManagedLinearIssue,
  createManagedLinearIssueBatch: linearMocks.createManagedLinearIssueBatch,
  getLinearIssue: linearMocks.getLinearIssue,
  searchLinearIssues: linearMocks.searchLinearIssues,
  updateManagedLinearIssue: linearMocks.updateManagedLinearIssue,
  updateLinearIssueStateWithComment: linearMocks.updateLinearIssueStateWithComment,
}));

vi.mock("../src/lib/slack-context.js", () => ({
  getSlackThreadContext: slackContextMocks.getSlackThreadContext,
}));

function createLinearTimeoutError(message: string): Error & { timeoutMs: number } {
  const error = new Error(message) as Error & { timeoutMs: number };
  error.name = "LinearCommandTimeoutError";
  error.timeoutMs = 30_000;
  return error;
}

describe("manager command commit linear", () => {
  let testContext: ManagerCommandCommitTestContext;

  beforeEach(async () => {
    testContext = await createManagerCommandCommitTestContext();
    linearMocks.addLinearComment.mockReset();
    linearMocks.addLinearProgressComment.mockReset();
    linearMocks.addLinearRelation.mockReset();
    linearMocks.assignLinearIssue.mockReset();
    linearMocks.createManagedLinearIssue.mockReset();
    linearMocks.createManagedLinearIssueBatch.mockReset();
    linearMocks.getLinearIssue.mockReset();
    linearMocks.searchLinearIssues.mockReset().mockResolvedValue([]);
    linearMocks.updateManagedLinearIssue.mockReset();
    linearMocks.updateLinearIssueStateWithComment.mockReset();
    slackContextMocks.getSlackThreadContext.mockReset().mockResolvedValue({
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-default",
      entries: [],
    });
  });

  afterEach(async () => {
    await cleanupManagerCommandCommitTestContext(testContext.workspaceDir);
  });

  it("rejects ambiguous status updates before issuing external writes", async () => {
    await recordPlanningOutcome(testContext.repositories.workgraph, {
      occurredAt: "2026-03-19T02:00:00.000Z",
      source: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-ambiguous-update",
        messageTs: "seed-msg-1",
      },
      messageFingerprint: "ambiguous update seed",
      childIssues: [
        { issueId: "AIC-951", title: "親承認の確認", kind: "execution" },
        { issueId: "AIC-952", title: "文面の反映", kind: "execution" },
      ],
      planningReason: "complex-request",
      lastResolvedIssueId: "AIC-951",
      originalText: "複数 task の起票",
    });

    const result = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "update_issue_status",
          issueId: "AIC-952",
          signal: "progress",
          reasonSummary: "この thread の更新と判断しました。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-ambiguous-update",
        messageTs: "msg-ambiguous-1",
        userId: "U1",
        text: "進捗です。確認依頼は出しました",
      },
      now: new Date("2026-03-19T02:05:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.committed).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain("issue ID");
    expect(linearMocks.addLinearProgressComment).not.toHaveBeenCalled();
  });

  it("commits completed status updates with split update and comment calls", async () => {
    linearMocks.updateManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-1",
      identifier: "AIC-501",
      title: "完了済み task",
      state: { id: "state-done", name: "Done", type: "completed" },
      relations: [],
      inverseRelations: [],
    });

    const result = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "update_issue_status",
          issueId: "AIC-501",
          signal: "completed",
          reasonSummary: "完了報告です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-completed",
        messageTs: "msg-completed-1",
        userId: "U1",
        text: "AIC-501 は終わりました",
      },
      now: new Date("2026-03-23T01:00:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.committed).toHaveLength(1);
    expect(linearMocks.updateManagedLinearIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: "AIC-501",
        state: "completed",
      }),
      expect.any(Object),
    );
    expect(linearMocks.addLinearComment).toHaveBeenCalledWith(
      "AIC-501",
      expect.stringContaining("## Completion source"),
      expect.any(Object),
    );
    expect(result.committed[0]?.publicReply).toBe("AIC-501 を完了にしました。");
  });

  it("normalizes cancel aliases to Canceled and avoids completed wording in the reply", async () => {
    linearMocks.updateManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-60",
      identifier: "AIC-60",
      title: "金澤さんをChatGPTプロジェクトに招待する",
      state: { id: "state-canceled", name: "Canceled", type: "canceled" },
      relations: [],
      inverseRelations: [],
    });

    const result = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "update_issue_status",
          issueId: "AIC-60",
          signal: "completed",
          state: "Cancelled",
          reasonSummary: "削除依頼です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-cancel-alias",
        messageTs: "msg-cancel-alias-1",
        userId: "U1",
        text: "AIC-60 は削除しておいて",
      },
      now: new Date("2026-03-25T01:06:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.committed).toHaveLength(1);
    expect(linearMocks.updateManagedLinearIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: "AIC-60",
        state: "Canceled",
      }),
      expect.any(Object),
    );
    expect(linearMocks.addLinearComment).toHaveBeenCalledWith(
      "AIC-60",
      expect.stringContaining("## Completion source"),
      expect.any(Object),
    );
    expect(result.committed[0]?.summary).toContain("Canceled に変更しました。");
    expect(result.committed[0]?.summary).not.toContain("完了として反映しました。");
    expect(result.committed[0]?.publicReply).toBe("AIC-60 を Canceled にしました。");
  });

  it("recovers a timed-out status update by reloading the updated issue", async () => {
    linearMocks.updateManagedLinearIssue.mockRejectedValueOnce(
      createLinearTimeoutError("linear issue update AIC-67 --json --state Canceled timed out after 30000ms"),
    );
    linearMocks.getLinearIssue.mockResolvedValueOnce({
      id: "issue-67",
      identifier: "AIC-67",
      title: "田平さんがCogitと連携できる環境確認",
      state: { id: "state-canceled", name: "Canceled", type: "canceled" },
      relations: [],
      inverseRelations: [],
    });

    const result = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "update_issue_status",
          issueId: "AIC-67",
          signal: "completed",
          state: "Canceled",
          reasonSummary: "現時点で作業がないため Canceled にする",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-timeout-recovery-status",
        messageTs: "msg-timeout-recovery-status-1",
        userId: "U1",
        text: "AIC-67 は現時点では作業なしなのでクローズで大丈夫です",
      },
      now: new Date("2026-03-30T00:05:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.rejected).toEqual([]);
    expect(result.committed).toHaveLength(1);
    expect(linearMocks.getLinearIssue).toHaveBeenCalledWith("AIC-67", expect.any(Object));
    expect(linearMocks.addLinearComment).toHaveBeenCalledWith(
      "AIC-67",
      expect.stringContaining("## Completion source"),
      expect.any(Object),
    );
    expect(result.committed[0]?.publicReply).toBe("AIC-67 を Canceled にしました。");
  });

  it("recovers a timed-out add_comment proposal when the comment is already visible on reload", async () => {
    linearMocks.addLinearComment.mockRejectedValueOnce(
      createLinearTimeoutError("linear comment create AIC-64 timed out after 30000ms"),
    );
    linearMocks.getLinearIssue.mockResolvedValueOnce({
      id: "issue-64",
      identifier: "AIC-64",
      title: "田平さん招待・環境構築対応",
      comments: [
        {
          id: "comment-1",
          body: "## Close condition\n- 田平さんの確認が完了したら AIC-64 をクローズ判断する",
        },
      ],
      relations: [],
      inverseRelations: [],
    });

    const result = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "add_comment",
          issueId: "AIC-64",
          body: "## Close condition\n- 田平さんの確認が完了したら AIC-64 をクローズ判断する",
          reasonSummary: "将来クローズ条件を残す",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-timeout-recovery-comment",
        messageTs: "msg-timeout-recovery-comment-1",
        userId: "U1",
        text: "AIC-64 にクローズ条件を残しておいて",
      },
      now: new Date("2026-03-30T00:05:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.rejected).toEqual([]);
    expect(result.committed).toHaveLength(1);
    expect(linearMocks.getLinearIssue).toHaveBeenCalledWith(
      "AIC-64",
      expect.any(Object),
      undefined,
      { includeComments: true },
    );
    expect(result.committed[0]?.summary).toBe("AIC-64 にコメントを追加しました。");
  });

  it("recovers timed-out assignee updates when reload shows the requested assignee", async () => {
    linearMocks.assignLinearIssue
      .mockRejectedValueOnce(
        createLinearTimeoutError("linear issue update AIC-86 --json --assignee m.tahira@opt.ne.jp timed out after 30000ms"),
      )
      .mockRejectedValueOnce(
        createLinearTimeoutError("linear issue update AIC-87 --json --assignee m.tahira@opt.ne.jp timed out after 30000ms"),
      );
    linearMocks.getLinearIssue
      .mockResolvedValueOnce({
        id: "issue-86",
        identifier: "AIC-86",
        title: "OPT 向け契約書確認",
        assignee: {
          id: "user-2",
          name: "m.tahira",
          displayName: "m.tahira",
          email: "m.tahira@opt.ne.jp",
        },
        relations: [],
        inverseRelations: [],
      })
      .mockResolvedValueOnce({
        id: "issue-87",
        identifier: "AIC-87",
        title: "契約フロー確認",
        assignee: {
          id: "user-2",
          name: "m.tahira",
          displayName: "m.tahira",
          email: "m.tahira@opt.ne.jp",
        },
        relations: [],
        inverseRelations: [],
      });

    const result = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "assign_issue",
          issueId: "AIC-86",
          assignee: "m.tahira",
          reasonSummary: "田平さんに担当を移す",
        },
        {
          commandType: "assign_issue",
          issueId: "AIC-87",
          assignee: "m.tahira",
          reasonSummary: "田平さんに担当を移す",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-assign-timeout-recovery",
        messageTs: "msg-assign-timeout-recovery-1",
        userId: "U1",
        text: "AIC86, 87 を田平さんアサインにして",
      },
      now: new Date("2026-03-30T04:20:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.rejected).toEqual([]);
    expect(result.committed).toHaveLength(2);
    expect(linearMocks.assignLinearIssue).toHaveBeenNthCalledWith(1, "AIC-86", "m.tahira", expect.any(Object));
    expect(linearMocks.assignLinearIssue).toHaveBeenNthCalledWith(2, "AIC-87", "m.tahira", expect.any(Object));
    expect(linearMocks.getLinearIssue).toHaveBeenNthCalledWith(1, "AIC-86", expect.any(Object));
    expect(linearMocks.getLinearIssue).toHaveBeenNthCalledWith(2, "AIC-87", expect.any(Object));
    expect(result.committed[0]?.summary).toBe("AIC-86 の担当を m.tahira に更新しました。");
    expect(result.committed[1]?.summary).toBe("AIC-87 の担当を m.tahira に更新しました。");
  });

  it("commits progress updates with a due date in one update call and records the new due date", async () => {
    linearMocks.updateManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-38",
      identifier: "AIC-38",
      title: "OPT社の社内チャネルへの招待依頼",
      dueDate: "2026-03-27",
      state: { id: "state-started", name: "Started", type: "started" },
      relations: [],
      inverseRelations: [],
    });

    const result = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "update_issue_status",
          issueId: "AIC-38",
          signal: "progress",
          dueDate: "2026-03-27",
          reasonSummary: "今週を目処に完了予定です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-progress-due-date",
        messageTs: "msg-progress-due-date-1",
        userId: "U1",
        text: "AIC-38 は今週を目処に完了させます",
      },
      now: new Date("2026-03-23T00:00:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.committed).toHaveLength(1);
    expect(linearMocks.updateManagedLinearIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: "AIC-38",
        dueDate: "2026-03-27",
      }),
      expect.any(Object),
    );
    expect(linearMocks.addLinearComment).toHaveBeenCalledWith(
      "AIC-38",
      expect.stringContaining("## Progress update"),
      expect.any(Object),
    );
    expect(linearMocks.addLinearProgressComment).not.toHaveBeenCalled();
    expect(result.committed[0]?.summary).toContain("期限は 2026-03-27 として反映しました。");
    expect(result.committed[0]?.publicReply).toBe("AIC-38 の進捗を反映しました。 期限は 2026-03-27 として反映しました。");

    const projection = await testContext.repositories.workgraph.project();
    expect(projection.issues["AIC-38"]).toMatchObject({
      dueDate: "2026-03-27",
      lastStatus: "progress",
    });
  });

  it("inherits the thread parent for single issue creation proposals", async () => {
    await recordPlanningOutcome(testContext.repositories.workgraph, {
      occurredAt: "2026-03-23T00:00:00.000Z",
      source: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-parented-create",
        messageTs: "seed-parent-1",
      },
      messageFingerprint: "seed parent",
      parentIssue: {
        issueId: "AIC-39",
        title: "AIマネージャーを実用レベルへ引き上げる",
      },
      parentIssueId: "AIC-39",
      childIssues: [],
      planningReason: "complex-request",
      lastResolvedIssueId: "AIC-39",
      originalText: "親 issue を作成",
    });

    linearMocks.createManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-40",
      identifier: "AIC-40",
      title: "コギトをシステム設定・プロンプトに命名として反映する",
      url: "https://linear.app/kyaukyuai/issue/AIC-40",
      parent: {
        id: "parent-39",
        identifier: "AIC-39",
        title: "AIマネージャーを実用レベルへ引き上げる",
      },
      relations: [],
      inverseRelations: [],
    });

    const result = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "create_issue",
          planningReason: "single-issue",
          threadParentHandling: "attach",
          duplicateHandling: "create-new",
          issue: {
            title: "コギトをシステム設定・プロンプトに命名として反映する",
            description: "## Slack source\nissue 化してください",
            assigneeMode: "leave-unassigned",
          },
          reasonSummary: "既存親の子 task と判断しました。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-parented-create",
        messageTs: "msg-parented-create-1",
        userId: "U1",
        text: "issue 化してください",
      },
      now: new Date("2026-03-23T00:05:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.committed).toHaveLength(1);
    expect(linearMocks.createManagedLinearIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: "AIC-39",
        title: "コギトをシステム設定・プロンプトに命名として反映する",
      }),
      expect.any(Object),
    );
    expect(result.committed[0]?.summary).toContain("親は AIC-39 AIマネージャーを実用レベルへ引き上げる");
    expect(result.committed[0]?.summary).toContain("子 task として <https://linear.app/kyaukyuai/issue/AIC-40|AIC-40 コギトをシステム設定・プロンプトに命名として反映する> を追加しています。");
    expect(result.committed[0]?.summary).not.toContain("担当が未定義だった task は、いったん kyaukyuai に寄せています。");
  });

  it("commits multiple create_issue_batch proposals in the same turn without tripping thread dedupe", async () => {
    linearMocks.createManagedLinearIssueBatch
      .mockResolvedValueOnce({
        parent: {
          id: "issue-parent-1",
          identifier: "AIC-201",
          title: "議事録タスク：角井 勇哉（2026-03-24）",
          url: "https://linear.app/kyaukyuai/issue/AIC-201",
          relations: [],
          inverseRelations: [],
        },
        children: [
          {
            id: "issue-child-1",
            identifier: "AIC-202",
            title: "3ヶ月後のゴールとスケジュールのポンチ絵資料作成",
            url: "https://linear.app/kyaukyuai/issue/AIC-202",
            relations: [],
            inverseRelations: [],
          },
          {
            id: "issue-child-2",
            identifier: "AIC-203",
            title: "千島さんとの契約・予算の詳細詰め",
            url: "https://linear.app/kyaukyuai/issue/AIC-203",
            relations: [],
            inverseRelations: [],
          },
        ],
      })
      .mockResolvedValueOnce({
        parent: {
          id: "issue-parent-2",
          identifier: "AIC-204",
          title: "議事録タスク：田平 誠人（2026-03-24）",
          url: "https://linear.app/kyaukyuai/issue/AIC-204",
          relations: [],
          inverseRelations: [],
        },
        children: [
          {
            id: "issue-child-3",
            identifier: "AIC-205",
            title: "金澤さんから定例ミーティング名の確認",
            url: "https://linear.app/kyaukyuai/issue/AIC-205",
            relations: [],
            inverseRelations: [],
          },
        ],
      });

    const result = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "create_issue_batch",
          planningReason: "complex-request",
          reasonSummary: "議事録から角井担当 task を作成します。",
          parent: {
            title: "議事録タスク：角井 勇哉（2026-03-24）",
            description: "角井担当 task 群です。",
            assigneeMode: "assign",
            assignee: "y.kakui",
          },
          children: [
            {
              title: "3ヶ月後のゴールとスケジュールのポンチ絵資料作成",
              description: "資料作成 task です。",
              assigneeMode: "assign",
              assignee: "y.kakui",
            },
            {
              title: "千島さんとの契約・予算の詳細詰め",
              description: "契約・予算 task です。",
              assigneeMode: "assign",
              assignee: "y.kakui",
            },
          ],
        },
        {
          commandType: "create_issue_batch",
          planningReason: "complex-request",
          reasonSummary: "議事録から田平担当 task を作成します。",
          parent: {
            title: "議事録タスク：田平 誠人（2026-03-24）",
            description: "田平担当 task 群です。",
            assigneeMode: "leave-unassigned",
          },
          children: [
            {
              title: "金澤さんから定例ミーティング名の確認",
              description: "ミーティング名確認 task です。",
              assigneeMode: "leave-unassigned",
            },
          ],
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-multi-batch-create",
        messageTs: "msg-multi-batch-create-1",
        userId: "U1",
        text: "以下の議事録からタスクを作成して",
      },
      now: new Date("2026-03-24T02:49:59.833Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.rejected).toEqual([]);
    expect(result.committed).toHaveLength(2);
    expect(linearMocks.createManagedLinearIssueBatch).toHaveBeenCalledTimes(2);
    expect(result.replySummaries.join("\n")).not.toContain("duplicate intake already recorded for this thread");
  });

  it("surfaces structured batch create partial failures with retry guidance", async () => {
    linearMocks.createManagedLinearIssueBatch.mockRejectedValueOnce(Object.assign(
      new Error("Issue batch creation failed while creating child 2 of 7"),
      {
        createdIdentifiers: ["AIC-201", "AIC-202"],
        createdCount: 2,
        failedStep: {
          stage: "child",
          index: 2,
          total: 7,
          title: "千島さんとの契約・予算の詳細詰め",
        },
        retryHint: "Do not rerun the same batch file unchanged after a partial failure.",
      },
    ));

    const result = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "create_issue_batch",
          planningReason: "complex-request",
          reasonSummary: "議事録から角井担当 task を作成します。",
          parent: {
            title: "議事録タスク：角井 勇哉（2026-03-24）",
            description: "角井担当 task 群です。",
            assigneeMode: "assign",
            assignee: "y.kakui",
          },
          children: [
            {
              title: "3ヶ月後のゴールとスケジュールのポンチ絵資料作成",
              description: "資料作成 task です。",
              assigneeMode: "assign",
              assignee: "y.kakui",
            },
            {
              title: "千島さんとの契約・予算の詳細詰め",
              description: "契約・予算 task です。",
              assigneeMode: "assign",
              assignee: "y.kakui",
            },
          ],
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-batch-create-partial-failure",
        messageTs: "msg-batch-create-partial-failure-1",
        userId: "U1",
        text: "以下の議事録からタスクを作成して",
      },
      now: new Date("2026-03-24T02:49:59.833Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.committed).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain("一括起票の途中で失敗しました。");
    expect(result.rejected[0]?.reason).toContain("作成済み issue: AIC-201, AIC-202。");
    expect(result.rejected[0]?.reason).toContain("失敗箇所: child 2/7 「千島さんとの契約・予算の詳細詰め」。");
    expect(result.rejected[0]?.reason).toContain("再試行時は作成済み issue を除いて残りだけを起票してください。");
  });

  it("reuses and reparents an existing duplicate under the thread parent", async () => {
    await recordPlanningOutcome(testContext.repositories.workgraph, {
      occurredAt: "2026-03-23T00:00:00.000Z",
      source: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-parented-duplicate",
        messageTs: "seed-parent-2",
      },
      messageFingerprint: "seed duplicate parent",
      parentIssue: {
        issueId: "AIC-39",
        title: "AIマネージャーを実用レベルへ引き上げる",
      },
      parentIssueId: "AIC-39",
      childIssues: [],
      planningReason: "complex-request",
      lastResolvedIssueId: "AIC-39",
      originalText: "親 issue を作成",
    });

    linearMocks.searchLinearIssues.mockResolvedValueOnce([
      {
        id: "issue-40",
        identifier: "AIC-40",
        title: "コギトをシステム設定・プロンプトに命名として反映する",
        url: "https://linear.app/kyaukyuai/issue/AIC-40",
        relations: [],
        inverseRelations: [],
      },
    ]);
    linearMocks.updateManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-40",
      identifier: "AIC-40",
      title: "コギトをシステム設定・プロンプトに命名として反映する",
      url: "https://linear.app/kyaukyuai/issue/AIC-40",
      parent: {
        id: "parent-39",
        identifier: "AIC-39",
        title: "AIマネージャーを実用レベルへ引き上げる",
      },
      relations: [],
      inverseRelations: [],
    });

    const result = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "create_issue",
          planningReason: "single-issue",
          threadParentHandling: "attach",
          duplicateHandling: "reuse-and-attach-parent",
          issue: {
            title: "コギトをシステム設定・プロンプトに命名として反映する",
            description: "## Slack source\nissue 化してください",
            assigneeMode: "leave-unassigned",
          },
          reasonSummary: "既存 issue を再利用します。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-parented-duplicate",
        messageTs: "msg-parented-duplicate-1",
        userId: "U1",
        text: "issue 化してください",
      },
      now: new Date("2026-03-23T00:06:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.committed).toHaveLength(1);
    expect(linearMocks.createManagedLinearIssue).not.toHaveBeenCalled();
    expect(linearMocks.updateManagedLinearIssue).toHaveBeenCalledWith(
      {
        issueId: "AIC-40",
        parent: "AIC-39",
      },
      expect.any(Object),
    );
    expect(result.committed[0]?.summary).toContain("既存の issue を親 issue に紐づけ直しました。");
    expect(result.committed[0]?.summary).toContain("親は AIC-39 AIマネージャーを実用レベルへ引き上げる です。");
  });

  it("applies assignee updates when reusing an existing duplicate issue", async () => {
    linearMocks.searchLinearIssues.mockResolvedValueOnce([
      {
        id: "issue-55",
        identifier: "AIC-55",
        title: "契約締結対応",
        url: "https://linear.app/kyaukyuai/issue/AIC-55",
        relations: [],
        inverseRelations: [],
      },
    ]);
    linearMocks.assignLinearIssue.mockResolvedValueOnce({
      id: "issue-55",
      identifier: "AIC-55",
      title: "契約締結対応",
      url: "https://linear.app/kyaukyuai/issue/AIC-55",
      assignee: { id: "user-1", displayName: "y.kakui" },
      relations: [],
      inverseRelations: [],
    });

    const result = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "create_issue",
          planningReason: "single-issue",
          threadParentHandling: "ignore",
          duplicateHandling: "reuse-existing",
          issue: {
            title: "契約締結対応",
            description: "契約締結に向けた対応タスク。",
            assigneeMode: "assign",
            assignee: "y.kakui",
            dueDate: "2026-03-31",
            priority: 2,
          },
          reasonSummary: "既存 issue を再利用しつつ担当を設定します。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-assign-duplicate",
        messageTs: "msg-assign-duplicate-1",
        userId: "U1",
        text: "kyaukyuai 担当で良いです",
      },
      now: new Date("2026-03-25T00:58:22.480Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.committed).toHaveLength(1);
    expect(linearMocks.createManagedLinearIssue).not.toHaveBeenCalled();
    expect(linearMocks.assignLinearIssue).toHaveBeenCalledWith("AIC-55", "y.kakui", expect.any(Object));
    expect(result.committed[0]?.issueIds).toEqual(["AIC-55"]);
    expect(result.committed[0]?.summary).toContain("同じ内容の issue が見つかったので、新規起票はせず既存の issue に寄せます。");
  });

  it("reuses an existing open issue with a structured link_existing_issue proposal", async () => {
    linearMocks.getLinearIssue.mockResolvedValueOnce({
      id: "issue-61",
      identifier: "AIC-61",
      title: "金澤さんのChatGPTプロジェクト招待",
      url: "https://linear.app/kyaukyuai/issue/AIC-61",
      state: { id: "state-started", name: "Started", type: "started" },
      relations: [],
      inverseRelations: [],
    });

    const result = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "link_existing_issue",
          issueId: "AIC-61",
          reasonSummary: "既存の招待タスクがあるため再利用します。",
          evidenceSummary: "linear_search_issues で既存タスクを確認済みです。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-link-existing",
        messageTs: "msg-link-existing-1",
        userId: "U1",
        text: "金澤さんのChatGPTのプロジェクト招待も対応してください",
      },
      now: new Date("2026-03-27T05:46:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.committed).toHaveLength(1);
    expect(linearMocks.getLinearIssue).toHaveBeenCalledWith("AIC-61", expect.any(Object));
    expect(linearMocks.createManagedLinearIssue).not.toHaveBeenCalled();
    expect(linearMocks.updateManagedLinearIssue).not.toHaveBeenCalled();
    expect(result.committed[0]).toMatchObject({
      commandType: "link_existing_issue",
      issueIds: ["AIC-61"],
      publicReply: "AIC-61（金澤さんのChatGPTプロジェクト招待）は既存タスクを使います。",
    });

    const projection = await testContext.repositories.workgraph.project();
    expect(projection.threads["C0ALAMDRB9V:thread-link-existing"]).toMatchObject({
      intakeStatus: "linked-existing",
      linkedIssueIds: ["AIC-61"],
      lastResolvedIssueId: "AIC-61",
    });
  });

  it("rejects link_existing_issue when the target issue is already closed", async () => {
    linearMocks.getLinearIssue.mockResolvedValueOnce({
      id: "issue-61",
      identifier: "AIC-61",
      title: "金澤さんのChatGPTプロジェクト招待",
      url: "https://linear.app/kyaukyuai/issue/AIC-61",
      completedAt: "2026-03-26T12:00:00.000Z",
      state: { id: "state-done", name: "Done", type: "completed" },
      relations: [],
      inverseRelations: [],
    });

    const result = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "link_existing_issue",
          issueId: "AIC-61",
          reasonSummary: "既存タスクの再利用です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-link-existing-closed",
        messageTs: "msg-link-existing-closed-1",
        userId: "U1",
        text: "金澤さんのChatGPTのプロジェクト招待も対応してください",
      },
      now: new Date("2026-03-27T05:46:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.committed).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain("完了済みまたは Canceled");
    expect(linearMocks.createManagedLinearIssue).not.toHaveBeenCalled();
    expect(linearMocks.updateManagedLinearIssue).not.toHaveBeenCalled();
  });

  it("sets an existing issue parent directly", async () => {
    linearMocks.updateManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-40",
      identifier: "AIC-40",
      title: "コギトをシステム設定・プロンプトに命名として反映する",
      url: "https://linear.app/kyaukyuai/issue/AIC-40",
      parent: {
        id: "parent-39",
        identifier: "AIC-39",
        title: "AIマネージャーを実用レベルへ引き上げる",
      },
      relations: [],
      inverseRelations: [],
    });

    const result = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "set_issue_parent",
          issueId: "AIC-40",
          parentIssueId: "AIC-39",
          reasonSummary: "AIC-40 を AIC-39 の子 task にする依頼です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-parent-update",
        messageTs: "msg-parent-update-1",
        userId: "U1",
        text: "AIC-40 を AIC-39 の子タスクとしてください",
      },
      now: new Date("2026-03-23T01:30:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.committed).toHaveLength(1);
    expect(linearMocks.updateManagedLinearIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: "AIC-40",
        parent: "AIC-39",
      }),
      expect.any(Object),
    );
    expect(result.committed[0]?.summary).toContain("AIC-40 を AIC-39 の子 task として反映しました。");

    const projection = await testContext.repositories.workgraph.project();
    expect(projection.issues["AIC-40"]).toMatchObject({
      parentIssueId: "AIC-39",
    });
    expect(projection.threads["C0ALAMDRB9V:thread-parent-update"]).toMatchObject({
      parentIssueId: "AIC-39",
      childIssueIds: expect.arrayContaining(["AIC-40"]),
    });
  });
});
