import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveExternalCoordinationHint } from "../src/lib/external-coordination-hint.js";
import {
  loadLastManagerAgentTurn,
  saveLastManagerAgentTurn,
} from "../src/lib/last-manager-agent-turn.js";
import { savePendingManagerClarification } from "../src/lib/pending-manager-clarification.js";
import { savePendingManagerConfirmation } from "../src/lib/pending-manager-confirmation.js";
import { saveThreadQueryContinuation } from "../src/lib/query-continuation.js";
import { saveSystemThreadContext } from "../src/lib/system-thread-context.js";
import {
  appendThreadLog,
  buildThreadPaths,
  ensureThreadWorkspace,
} from "../src/lib/thread-workspace.js";
import {
  evaluateHumanToHumanSmalltalkReplyGate,
  HUMAN_TO_HUMAN_SMALLTALK_IGNORE_REASON,
  loadHumanToHumanSmalltalkReplyGateContext,
  persistHumanToHumanSmalltalkReplySuppressionOnLastTurn,
} from "../src/runtime/human-to-human-smalltalk-suppression.js";

describe("human-to-human smalltalk suppression", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  async function buildPaths() {
    workspaceDir = await mkdtemp(join(tmpdir(), "cogito-smalltalk-"));
    const paths = buildThreadPaths(workspaceDir, "C123", "1775114910.852199");
    await ensureThreadWorkspace(paths);
    return paths;
  }

  it("suppresses public replies for human-directed root threads with no active work context", async () => {
    const paths = await buildPaths();
    await appendThreadLog(paths, {
      type: "user",
      ts: "1775114910.852199",
      threadTs: "1775114910.852199",
      userId: "U_TAHIRA",
      text: "<@U01L86BCA9X> 金澤さんが他の文脈で共有してたmdファイル共有します！",
    });

    const context = await loadHumanToHumanSmalltalkReplyGateContext({
      paths,
      botUserId: "UBOT",
      currentHasBotMention: false,
      now: new Date("2026-04-02T06:06:00.000Z"),
    });
    expect(context).toMatchObject({
      currentHasBotMention: false,
      rootHumanDirectedWithoutBot: true,
      hasActiveThreadContext: false,
    });

    const decision = evaluateHumanToHumanSmalltalkReplyGate({
      context,
      handled: true,
      intent: "conversation",
      conversationKind: "smalltalk",
    });
    expect(decision.shouldSuppress).toBe(true);
    expect(decision.ignoreReason).toBe(HUMAN_TO_HUMAN_SMALLTALK_IGNORE_REASON);
  });

  it("does not suppress when active thread context already exists", async () => {
    const paths = await buildPaths();
    await appendThreadLog(paths, {
      type: "user",
      ts: "1775114910.852199",
      threadTs: "1775114910.852199",
      userId: "U_TAHIRA",
      text: "<@U01L86BCA9X> 共有します！",
    });
    await saveThreadQueryContinuation(paths, {
      kind: "list-active",
      scope: "team",
      userMessage: "一覧をください",
      replySummary: "一覧を返しました。",
      issueIds: ["AIC-1"],
      shownIssueIds: ["AIC-1"],
      remainingIssueIds: [],
      totalItemCount: 1,
      recordedAt: "2026-04-02T06:00:00.000Z",
    });
    await savePendingManagerClarification(paths, {
      intent: "create_work",
      originalUserMessage: "起票して",
      lastUserMessage: "補足です",
      clarificationReply: "どの project ですか？",
      relatedIssueIds: [],
      recordedAt: "2026-04-02T06:01:00.000Z",
    });
    await savePendingManagerConfirmation(paths, {
      kind: "owner-map",
      originalUserMessage: "owner map を更新して",
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
      previewSummaryLines: ["preview"],
      previewReply: "owner-map.json の変更案です。",
      recordedAt: "2026-04-02T06:02:00.000Z",
    });
    await saveSystemThreadContext(paths, {
      sourceKind: "review",
      rootPostedTs: "1775114910.852199",
      issueRefs: [{ issueId: "AIC-87" }],
      recordedAt: "2026-04-02T06:03:00.000Z",
    });
    await saveExternalCoordinationHint(paths, {
      issueId: "AIC-55",
      targetSlackUserId: "U456",
      sourceMessageTs: "1775115000.000001",
      sourceUserId: "U123",
      requestText: "確認してください",
      attachmentNames: [],
      resolutionSummary: "matched",
      recordedAt: "2026-04-02T06:04:00.000Z",
    });
    await saveLastManagerAgentTurn(paths, {
      recordedAt: "2026-04-02T06:05:00.000Z",
      replyPath: "agent",
      intent: "update_progress",
      summary: "進捗を更新する。",
      committedCommands: [{
        commandType: "update_issue_status",
        issueIds: ["AIC-55"],
        summary: "進捗更新",
      }],
      taskExecutionDecision: "execute",
    });

    const context = await loadHumanToHumanSmalltalkReplyGateContext({
      paths,
      botUserId: "UBOT",
      currentHasBotMention: false,
      now: new Date("2026-04-02T06:06:00.000Z"),
    });
    expect(context.hasActiveThreadContext).toBe(true);
    expect(context.activeThreadContextFlags).toMatchObject({
      lastQueryContext: true,
      pendingManagerClarification: true,
      pendingManagerConfirmation: true,
      systemThreadContext: true,
      externalCoordinationHint: true,
      recentCommittedCommands: true,
      recentTaskExecution: true,
    });

    const decision = evaluateHumanToHumanSmalltalkReplyGate({
      context,
      handled: true,
      intent: "conversation",
      conversationKind: "smalltalk",
    });
    expect(decision.shouldSuppress).toBe(false);
  });

  it("records the public reply suppression reason on the last manager turn", async () => {
    const paths = await buildPaths();
    await saveLastManagerAgentTurn(paths, {
      recordedAt: "2026-04-02T07:00:00.000Z",
      replyPath: "agent",
      intent: "conversation",
      conversationKind: "smalltalk",
      summary: "ユーザーの感嘆コメントに返答する。",
    });

    await persistHumanToHumanSmalltalkReplySuppressionOnLastTurn(
      paths,
      HUMAN_TO_HUMAN_SMALLTALK_IGNORE_REASON,
    );

    await expect(loadLastManagerAgentTurn(paths)).resolves.toMatchObject({
      publicReplySuppressedReason: HUMAN_TO_HUMAN_SMALLTALK_IGNORE_REASON,
    });
  });
});
