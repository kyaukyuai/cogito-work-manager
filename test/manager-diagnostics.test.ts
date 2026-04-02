import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildManagerIssueDiagnostics,
  buildManagerThreadIncidentDiagnostics,
  buildManagerStateFileDiagnostics,
  buildManagerThreadDiagnostics,
  buildManagerWorkgraphDiagnostics,
  buildManagerWorkspaceMemoryDiagnostics,
} from "../src/lib/manager-diagnostics.js";
import { saveLastManagerAgentTurn } from "../src/lib/last-manager-agent-turn.js";
import { ensureManagerStateFiles } from "../src/lib/manager-state.js";
import { savePendingManagerClarification } from "../src/lib/pending-manager-clarification.js";
import { saveThreadQueryContinuation } from "../src/lib/query-continuation.js";
import { buildSystemPaths } from "../src/lib/system-workspace.js";
import { appendThreadLog, buildThreadPaths, ensureThreadWorkspace } from "../src/lib/thread-workspace.js";
import { createFileBackedManagerRepositories } from "../src/state/repositories/file-backed-manager-repositories.js";
import { recordPlanningOutcome } from "../src/state/workgraph/recorder.js";

const linearMocks = vi.hoisted(() => ({
  getLinearIssue: vi.fn(),
}));

vi.mock("../src/gateways/linear/issues.js", async () => {
  const actual = await vi.importActual<typeof import("../src/gateways/linear/issues.js")>("../src/gateways/linear/issues.js");
  return {
    ...actual,
    getLinearIssue: linearMocks.getLinearIssue,
  };
});

describe("manager diagnostics", () => {
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
    notionApiToken: undefined,
    notionAgendaParentPageId: undefined,
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

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "manager-diagnostics-"));
    const systemPaths = buildSystemPaths(workspaceDir);
    await ensureManagerStateFiles(systemPaths);
    repositories = createFileBackedManagerRepositories(systemPaths);
    linearMocks.getLinearIssue.mockReset().mockResolvedValue({
      id: "issue-970",
      identifier: "AIC-970",
      title: "OPT社の社内チャネルへの招待依頼",
      url: "https://linear.app/kyaukyuai/issue/AIC-970",
      relations: [],
      inverseRelations: [],
    });
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("builds thread diagnostics with workgraph and Slack context", async () => {
    const clarificationRecordedAt = new Date().toISOString();
    await recordPlanningOutcome(repositories.workgraph, {
      occurredAt: "2026-03-19T04:00:00.000Z",
      source: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-diagnostics",
        messageTs: "msg-seed-1",
      },
      messageFingerprint: "diag-thread-seed",
      childIssues: [
        { issueId: "AIC-970", title: "OPT社の社内チャネルへの招待依頼", kind: "execution" },
      ],
      planningReason: "single-issue",
      lastResolvedIssueId: "AIC-970",
      originalText: "招待依頼を追加する",
    });

    const threadPaths = buildThreadPaths(workspaceDir, "C0ALAMDRB9V", "thread-diagnostics");
    await ensureThreadWorkspace(threadPaths);
    await appendThreadLog(threadPaths, {
      type: "user",
      ts: "msg-seed-1",
      threadTs: "thread-diagnostics",
      userId: "U1",
      text: "招待依頼を追加する",
    });
    await appendThreadLog(threadPaths, {
      type: "assistant",
      ts: "msg-seed-2",
      threadTs: "thread-diagnostics",
      text: "AIC-970 として登録しました。",
    });
    await saveThreadQueryContinuation(threadPaths, {
      kind: "what-should-i-do",
      scope: "team",
      userMessage: "今日やるべきタスクある？",
      replySummary: "今日まず見るなら AIC-970 です。",
      issueIds: ["AIC-970"],
      shownIssueIds: ["AIC-970"],
      remainingIssueIds: [],
      totalItemCount: 1,
      recordedAt: "2026-03-19T04:05:00.000Z",
    });
    await savePendingManagerClarification(threadPaths, {
      intent: "create_work",
      originalUserMessage: "Slack 表示崩れを直す task を作成してください。",
      lastUserMessage: "という意図です",
      clarificationReply: "補足をもらえれば起票できます。",
      missingDecisionSummary: "task title が曖昧です。",
      threadParentIssueId: "AIC-970",
      relatedIssueIds: ["AIC-970"],
      recordedAt: clarificationRecordedAt,
    });
    await saveLastManagerAgentTurn(threadPaths, {
      recordedAt: "2026-03-23T04:06:30.000Z",
      replyPath: "agent",
      intent: "create_work",
      conversationKind: "other",
      currentDateTimeJst: "2026-03-23 13:06 JST",
      pendingClarificationDecision: "continue_pending",
      pendingClarificationPersistence: "keep",
      pendingClarificationDecisionSummary: "前の create clarification への補足です。",
      duplicateResolutions: [
        {
          assessmentStatus: "fuzzy",
          recommendedAction: "clarify",
          reasonSummary: "AIC-61 は近いですが対象者が一致しません。",
          extraQueries: ["角井 chatgpt 招待"],
          finalCandidateIds: ["AIC-61"],
        },
      ],
      missingQuerySnapshot: false,
      technicalFailure: "planner timeout",
    });

    const diagnostics = await buildManagerThreadDiagnostics({
      config: { ...config, workspaceDir },
      repositories,
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-diagnostics",
    });

    expect(diagnostics.threadKey).toBe("C0ALAMDRB9V:thread-diagnostics");
    expect(diagnostics.planningContext?.latestResolvedIssue?.issueId).toBe("AIC-970");
    expect(diagnostics.lastQueryContext).toMatchObject({
      kind: "what-should-i-do",
      issueIds: ["AIC-970"],
      shownIssueIds: ["AIC-970"],
      remainingIssueIds: [],
      totalItemCount: 1,
    });
    expect(diagnostics.pendingClarification).toMatchObject({
      intent: "create_work",
      threadParentIssueId: "AIC-970",
    });
    expect(diagnostics.lastAgentTurn).toMatchObject({
      replyPath: "agent",
      intent: "create_work",
      conversationKind: "other",
      currentDateTimeJst: "2026-03-23 13:06 JST",
      pendingClarificationDecision: "continue_pending",
      pendingClarificationPersistence: "keep",
      duplicateResolutions: [
        expect.objectContaining({
          assessmentStatus: "fuzzy",
          recommendedAction: "clarify",
          extraQueries: ["角井 chatgpt 招待"],
          finalCandidateIds: ["AIC-61"],
        }),
      ],
      missingQuerySnapshot: false,
      technicalFailure: "planner timeout",
    });
    expect(diagnostics.slackThreadContext.entries).toHaveLength(2);
    expect(diagnostics.ownerMapDiagnostics.unmappedSlackEntries).toHaveLength(0);
    expect(diagnostics.ownerMapDiagnostics.mappedSlackEntries).toBe(1);
  });

  it("builds issue diagnostics with followup and latest source", async () => {
    await recordPlanningOutcome(repositories.workgraph, {
      occurredAt: "2026-03-19T04:10:00.000Z",
      source: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-issue-diagnostics",
        messageTs: "msg-seed-3",
      },
      messageFingerprint: "diag-issue-seed",
      childIssues: [
        { issueId: "AIC-970", title: "OPT社の社内チャネルへの招待依頼", kind: "execution" },
      ],
      planningReason: "single-issue",
      lastResolvedIssueId: "AIC-970",
      originalText: "招待依頼を追加する",
    });
    await writeFile(
      buildSystemPaths(workspaceDir).followupsFile,
      `${JSON.stringify([
        {
          issueId: "AIC-970",
          requestKind: "status",
          status: "awaiting-response",
          requestText: "最新状況を共有してください。",
          sourceChannelId: "C0ALAMDRB9V",
          sourceThreadTs: "thread-issue-diagnostics",
          sourceMessageTs: "msg-seed-3",
        },
      ], null, 2)}\n`,
      "utf8",
    );

    const threadPaths = buildThreadPaths(workspaceDir, "C0ALAMDRB9V", "thread-issue-diagnostics");
    await ensureThreadWorkspace(threadPaths);
    await appendThreadLog(threadPaths, {
      type: "user",
      ts: "msg-seed-3",
      threadTs: "thread-issue-diagnostics",
      userId: "U1",
      text: "招待依頼を追加する",
    });

    const diagnostics = await buildManagerIssueDiagnostics({
      config: { ...config, workspaceDir },
      repositories,
      issueId: "AIC-970",
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
    });

    expect(diagnostics.issueContext?.issueId).toBe("AIC-970");
    expect(diagnostics.latestSource?.rootThreadTs).toBe("thread-issue-diagnostics");
    expect(diagnostics.followup?.requestKind).toBe("status");
    expect(diagnostics.slackThreadContext?.entries).toHaveLength(1);
    expect(diagnostics.linearIssue?.identifier).toBe("AIC-970");
  });

  it("builds thread incident diagnostics with last reply and turn outcomes", async () => {
    await recordPlanningOutcome(repositories.workgraph, {
      occurredAt: "2026-03-30T00:00:00.000Z",
      source: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-incident-diagnostics",
        messageTs: "msg-incident-1",
      },
      messageFingerprint: "diag-incident-seed",
      childIssues: [
        { issueId: "AIC-64", title: "田平さん招待環境構築対応", kind: "execution" },
        { issueId: "AIC-67", title: "田平さんがCogitと連携できる環境確認", kind: "execution" },
      ],
      planningReason: "complex-request",
      lastResolvedIssueId: "AIC-67",
      originalText: "mixed incident replay seed",
    });

    const threadPaths = buildThreadPaths(workspaceDir, "C0ALAMDRB9V", "thread-incident-diagnostics");
    await ensureThreadWorkspace(threadPaths);
    await appendThreadLog(threadPaths, {
      type: "user",
      ts: "msg-incident-1",
      threadTs: "thread-incident-diagnostics",
      userId: "U1",
      text: "特に AIC-67 では実施することはない認識なので、田平さんの確認が終えたら、AIC-64 はクローズしましょう",
    });
    await appendThreadLog(threadPaths, {
      type: "assistant",
      ts: "msg-incident-2",
      threadTs: "thread-incident-diagnostics",
      text: "AIC-67 を Canceled にします。AIC-64 は田平さんの確認が取れたらクローズする旨をコメントに残しておきます。",
    });
    await writeFile(join(threadPaths.scratchDir, "last-reply.txt"), "AIC-67 を Canceled にします。\n", "utf8");
    await saveLastManagerAgentTurn(threadPaths, {
      recordedAt: "2026-03-30T00:05:00.000Z",
      replyPath: "agent",
      intent: "update_progress",
      currentDateTimeJst: "2026-03-30 09:05 JST",
      toolCalls: ["report_manager_intent", "propose_update_issue_status", "propose_add_comment"],
      proposalCount: 2,
      invalidProposalCount: 0,
      proposals: [
        {
          commandType: "update_issue_status",
          targetSummary: "AIC-67",
          detailSummary: "signal=completed state=Canceled",
          reasonSummary: "AIC-67 では現時点で実施事項がないため Canceled にする",
        },
        {
          commandType: "add_comment",
          targetSummary: "AIC-64",
          detailSummary: "## Close condition - 田平さんの確認が完了したら AIC-64 をクローズ判断する",
          reasonSummary: "AIC-64 の将来クローズ条件を記録する",
        },
      ],
      committedCommands: [
        {
          commandType: "update_issue_status",
          issueIds: ["AIC-67"],
          summary: "AIC-67 を Canceled にしました。",
          postCommitWarnings: ["record_issue_signals: workgraph append failed"],
          postCommitStatus: "partial-local-failure",
        },
      ],
      commitWarnings: ["record_issue_signals: workgraph append failed"],
      postCommitStatus: "partial-local-failure",
      rejectedProposals: [
        {
          commandType: "add_comment",
          targetSummary: "AIC-64",
          detailSummary: "## Close condition - 田平さんの確認が完了したら AIC-64 をクローズ判断する",
          reasonSummary: "AIC-64 の将来クローズ条件を記録する",
          reason: "AIC-64 へのコメント追加を完了できませんでした: comment write failed",
        },
      ],
      technicalFailure: "comment write failed",
    });

    const diagnostics = await buildManagerThreadIncidentDiagnostics({
      config: { ...config, workspaceDir },
      repositories,
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-incident-diagnostics",
    });

    expect(diagnostics.lastReply).toBe("AIC-67 を Canceled にします。");
    expect(diagnostics.lastAgentTurn).toMatchObject({
      replyPath: "agent",
      intent: "update_progress",
      proposalCount: 2,
      invalidProposalCount: 0,
      toolCalls: ["report_manager_intent", "propose_update_issue_status", "propose_add_comment"],
      proposals: [
        expect.objectContaining({
          commandType: "update_issue_status",
          targetSummary: "AIC-67",
        }),
        expect.objectContaining({
          commandType: "add_comment",
          targetSummary: "AIC-64",
        }),
      ],
      committedCommands: [
        expect.objectContaining({
          commandType: "update_issue_status",
          issueIds: ["AIC-67"],
          postCommitWarnings: ["record_issue_signals: workgraph append failed"],
          postCommitStatus: "partial-local-failure",
        }),
      ],
      commitWarnings: ["record_issue_signals: workgraph append failed"],
      postCommitStatus: "partial-local-failure",
      rejectedProposals: [
        expect.objectContaining({
          commandType: "add_comment",
          targetSummary: "AIC-64",
          reason: expect.stringContaining("comment write failed"),
        }),
      ],
    });
    expect(diagnostics.planningContext?.childIssues.map((issue) => issue.issueId)).toEqual(["AIC-64", "AIC-67"]);
    expect(diagnostics.slackThreadContext.entries).toHaveLength(2);
  });

  it("builds state file diagnostics with classification summaries", async () => {
    const diagnostics = await buildManagerStateFileDiagnostics({ workspaceDir });

    expect(diagnostics.systemRoot).toBe(join(workspaceDir, "system"));
    expect(diagnostics.classificationSummary.editable).toEqual(
      expect.arrayContaining(["policy.json", "owner-map.json", "HEARTBEAT.md"]),
    );
    expect(diagnostics.classificationSummary.internal).toEqual(
      expect.arrayContaining(["followups.json", "notion-pages.json", "webhook-deliveries.json", "job-status.json"]),
    );
    expect(diagnostics.classificationSummary.derived).toEqual(
      expect.arrayContaining(["workgraph-events.jsonl", "workgraph-snapshot.json", "sessions/"]),
    );
    expect(diagnostics.operatorActionSummary.doNotEdit).toEqual(
      expect.arrayContaining(["workgraph-events.jsonl", "sessions/"]),
    );
    expect(diagnostics.writePolicySummary["silent-auto-update"]).toEqual(
      expect.arrayContaining(["AGENTS.md", "MEMORY.md"]),
    );
    expect(diagnostics.writePolicySummary["explicit-slack-update"]).toEqual(
      expect.arrayContaining(["AGENDA_TEMPLATE.md", "HEARTBEAT.md", "owner-map.json"]),
    );
    expect(diagnostics.writePolicySummary["manager-commit-only"]).toEqual(
      expect.arrayContaining(["policy.json", "jobs.json"]),
    );
    expect(diagnostics.writePolicySummary["system-maintained"]).toEqual(
      expect.arrayContaining(["followups.json", "webhook-deliveries.json", "job-status.json"]),
    );
    expect(diagnostics.writePolicySummary["rebuild-only"]).toEqual(
      expect.arrayContaining(["workgraph-events.jsonl", "sessions/"]),
    );
    expect(diagnostics.files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relativePath: "policy.json",
        exists: true,
        classification: "editable",
      }),
      expect.objectContaining({
        relativePath: "sessions/",
        entryType: "directory",
      }),
    ]));
    expect(diagnostics.writePolicyNotes.silentAutoUpdate).toContain("automatically");
    expect(diagnostics.writePolicyNotes.explicitSlackUpdate).toContain("explicit Slack request");
  });

  it("builds workgraph diagnostics with operator guidance", async () => {
    await repositories.workgraph.append([
      {
        type: "planning.parent_created",
        occurredAt: "2026-03-19T05:00:00.000Z",
        threadKey: "C0ALAMDRB9V:thread-workgraph",
        sourceChannelId: "C0ALAMDRB9V",
        sourceThreadTs: "thread-workgraph",
        sourceMessageTs: "msg-workgraph-1",
        issueId: "AIC-980",
        title: "workgraph health check",
      },
      {
        type: "issue.progressed",
        occurredAt: "2026-03-19T05:10:00.000Z",
        threadKey: "C0ALAMDRB9V:thread-workgraph",
        sourceChannelId: "C0ALAMDRB9V",
        sourceThreadTs: "thread-workgraph",
        sourceMessageTs: "msg-workgraph-2",
        issueId: "AIC-980",
      },
    ]);

    const diagnostics = await buildManagerWorkgraphDiagnostics({
      config: {
        ...config,
        workspaceDir,
        workgraphHealthWarnActiveEvents: 1,
        workgraphAutoCompactMaxActiveEvents: 5,
      },
      repositories,
    });

    expect(diagnostics.health).toMatchObject({
      status: "warning",
      activeLogEventCount: 2,
      recommendedAction: "observe",
      reasons: [
        expect.objectContaining({
          code: "active-log-warning",
        }),
      ],
    });
    expect(diagnostics.files.activeLog.relativePath).toBe("workgraph-events.jsonl");
    expect(diagnostics.files.activeLog.sizeBytes).toBeGreaterThan(0);
    expect(diagnostics.operatorActionSummary).toMatchObject({
      recommendedAction: "observe",
      commands: {
        compact: `npm run workgraph:compact -- ${workspaceDir}`,
        recover: `npm run workgraph:recover -- ${workspaceDir}`,
      },
    });
    expect(diagnostics.operatorActionSummary.maintenanceRules.compactWhen).toContain(">= 5");
    expect(diagnostics.operatorActionSummary.maintenanceRules.recoverWhen).toContain("snapshotInvalid=true");
  });

  it("builds workspace memory diagnostics with coverage and boundary warnings", async () => {
    const systemPaths = buildSystemPaths(workspaceDir);
    await writeFile(systemPaths.memoryFile, [
      "## Projects",
      "",
      "### AIクローンプラットフォーム",
      "",
      "#### Overview",
      "- AIクローンプラットフォームは金澤クローンプロジェクトである。",
      "",
      "#### Members And Roles",
      "- 金澤さんは初期 PoC の中心となるクローン対象者である。",
      "",
      "#### Roadmap And Milestones",
      "- 3ヶ月後に金澤クローンが Slack 上で日常相談に耐える状態を目標にする。",
      "",
      "### OPT社内利用開始",
      "",
      "#### Overview",
      "- OPT 社内利用開始は AIクローンプラットフォームの利用対象を広げる導入フェーズである。",
      "",
      "#### Roadmap And Milestones",
      "- AIC-38 は 2026-03-27 期限で現在 Backlog のままです。",
      "",
    ].join("\n"), "utf8");

    const diagnostics = await buildManagerWorkspaceMemoryDiagnostics({ workspaceDir });

    expect(diagnostics.projectNames).toEqual(["AIクローンプラットフォーム", "OPT社内利用開始"]);
    expect(diagnostics.completeProjects).toEqual(["AIクローンプラットフォーム"]);
    expect(diagnostics.incompleteProjects).toEqual(["OPT社内利用開始"]);
    expect(diagnostics.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        projectName: "AIクローンプラットフォーム",
        missingSections: [],
        bulletCounts: {
          Overview: 1,
          "Members And Roles": 1,
          "Roadmap And Milestones": 1,
        },
      }),
      expect.objectContaining({
        projectName: "OPT社内利用開始",
        missingSections: ["Members And Roles"],
      }),
    ]));
    expect(diagnostics.currentStateWarnings).toEqual([
      expect.objectContaining({
        reason: "issue-reference",
        line: "- AIC-38 は 2026-03-27 期限で現在 Backlog のままです。",
      }),
    ]);
  });
});
