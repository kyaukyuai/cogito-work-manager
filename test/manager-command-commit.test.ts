import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitManagerCommandProposals } from "../src/lib/manager-command-commit.js";
import { ensureManagerStateFiles } from "../src/lib/manager-state.js";
import { buildSystemPaths } from "../src/lib/system-workspace.js";
import { createFileBackedManagerRepositories } from "../src/state/repositories/file-backed-manager-repositories.js";
import { recordPlanningOutcome } from "../src/state/workgraph/recorder.js";

const linearMocks = vi.hoisted(() => ({
  addLinearComment: vi.fn(),
  addLinearProgressComment: vi.fn(),
  addLinearRelation: vi.fn(),
  assignLinearIssue: vi.fn(),
  createManagedLinearIssue: vi.fn(),
  createManagedLinearIssueBatch: vi.fn(),
  getLinearIssue: vi.fn(),
  markLinearIssueBlocked: vi.fn(),
  searchLinearIssues: vi.fn(),
  updateManagedLinearIssue: vi.fn(),
  updateLinearIssueState: vi.fn(),
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
  markLinearIssueBlocked: linearMocks.markLinearIssueBlocked,
  searchLinearIssues: linearMocks.searchLinearIssues,
  updateManagedLinearIssue: linearMocks.updateManagedLinearIssue,
  updateLinearIssueState: linearMocks.updateLinearIssueState,
  updateLinearIssueStateWithComment: linearMocks.updateLinearIssueStateWithComment,
}));

vi.mock("../src/lib/slack-context.js", () => ({
  getSlackThreadContext: slackContextMocks.getSlackThreadContext,
}));

describe("manager command commit", () => {
  let workspaceDir: string;
  let repositories: ReturnType<typeof createFileBackedManagerRepositories>;
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
    workspaceDir = await mkdtemp(join(tmpdir(), "manager-command-commit-"));
    const systemPaths = buildSystemPaths(workspaceDir);
    await ensureManagerStateFiles(systemPaths);
    repositories = createFileBackedManagerRepositories(systemPaths);

    linearMocks.addLinearComment.mockReset();
    linearMocks.addLinearProgressComment.mockReset();
    linearMocks.addLinearRelation.mockReset();
    linearMocks.assignLinearIssue.mockReset();
    linearMocks.createManagedLinearIssue.mockReset();
    linearMocks.createManagedLinearIssueBatch.mockReset();
    linearMocks.getLinearIssue.mockReset();
    linearMocks.markLinearIssueBlocked.mockReset();
    linearMocks.searchLinearIssues.mockReset().mockResolvedValue([]);
    linearMocks.updateManagedLinearIssue.mockReset();
    linearMocks.updateLinearIssueState.mockReset();
    linearMocks.updateLinearIssueStateWithComment.mockReset();
    slackContextMocks.getSlackThreadContext.mockReset().mockResolvedValue({
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-default",
      entries: [],
    });
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("rejects ambiguous status updates before issuing external writes", async () => {
    await recordPlanningOutcome(repositories.workgraph, {
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
      config: { ...config, workspaceDir },
      repositories,
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
      policy: await repositories.policy.load(),
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
    });

    expect(result.committed).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain("issue ID");
    expect(linearMocks.addLinearProgressComment).not.toHaveBeenCalled();
  });

  it("rejects owner follow-up resolutions without an assignee", async () => {
    await writeFile(
      buildSystemPaths(workspaceDir).followupsFile,
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
      config: { ...config, workspaceDir },
      repositories,
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
      policy: await repositories.policy.load(),
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
    });

    expect(result.committed).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain("担当者名");
    expect(linearMocks.getLinearIssue).not.toHaveBeenCalled();
  });

  it("commits completed status updates with a single update-and-comment call", async () => {
    linearMocks.updateLinearIssueStateWithComment.mockResolvedValueOnce({
      id: "issue-1",
      identifier: "AIC-501",
      title: "完了済み task",
      state: { id: "state-done", name: "Done", type: "completed" },
      relations: [],
      inverseRelations: [],
    });

    const result = await commitManagerCommandProposals({
      config: { ...config, workspaceDir },
      repositories,
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
      policy: await repositories.policy.load(),
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
    });

    expect(result.committed).toHaveLength(1);
    expect(linearMocks.updateLinearIssueStateWithComment).toHaveBeenCalledWith(
      "AIC-501",
      "completed",
      expect.stringContaining("## Completion source"),
      expect.any(Object),
    );
    expect(linearMocks.addLinearComment).not.toHaveBeenCalled();
  });
});
