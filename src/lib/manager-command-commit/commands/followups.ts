import type { FollowupLedgerEntry } from "../../../state/manager-state-contract.js";
import { recordFollowupTransitions } from "../../../state/workgraph/recorder.js";
import { issueMatchesCompletedState } from "../../../orchestrators/review/risk.js";
import {
  buildAwaitingFollowupPatch,
  upsertFollowup,
  type ReviewHelperDeps,
} from "../../../orchestrators/review/review-helpers.js";
import { formatFollowupResolutionReply } from "../../../orchestrators/updates/reply-format.js";
import {
  applyFollowupAssessmentResult,
  applyFollowupExtractedFields,
  updateFollowupsWithIssueResponse,
} from "../../../orchestrators/updates/followup-state.js";
import type { FollowupResolutionResult } from "../../../planners/followup-resolution/index.js";
import { getLinearIssue } from "../../linear.js";
import type {
  ManagerCommandHandlerResult,
  ResolveFollowupProposal,
  ReviewFollowupProposal,
} from "../contracts.js";
import type { CommitManagerCommandArgs } from "../contracts.js";
import { buildOccurredAt } from "../common.js";

function validateFollowupProposalFields(
  current: FollowupLedgerEntry,
  proposal: ResolveFollowupProposal,
): string | undefined {
  const extractedFields = proposal.extractedFields ?? {};

  if (current.requestKind && proposal.requestKind && current.requestKind !== proposal.requestKind) {
    return `待っている follow-up は ${current.requestKind} 向けですが、提案は ${proposal.requestKind} 向けでした。必要な内容を補足してください。`;
  }

  const requestKind = proposal.requestKind ?? current.requestKind;
  if (requestKind === "owner" && !extractedFields.assignee) {
    return "担当者の確認依頼を解消するには、担当者名が必要です。担当者を明記してください。";
  }
  if (requestKind === "due-date" && !extractedFields.dueDate) {
    return "期限確認の follow-up を解消するには、期限が必要です。日付を明記してください。";
  }
  if (!proposal.answered && proposal.confidence < 0.7 && Object.keys(extractedFields).length === 0) {
    return "follow-up への返答として十分か判断しきれませんでした。状況や不足情報をもう少し具体的に送ってください。";
  }
  return undefined;
}

function buildFollowupResolutionLike(proposal: ResolveFollowupProposal): FollowupResolutionResult {
  return {
    answered: proposal.answered,
    confidence: proposal.confidence,
    answerKind: proposal.answerKind,
    reasoningSummary: proposal.reasonSummary,
    extractedFields: proposal.extractedFields,
  };
}

function buildReviewDeps(): Pick<ReviewHelperDeps, "nowIso"> {
  return {
    nowIso: (now) => now.toISOString(),
  };
}

export async function commitResolveFollowupProposal(
  args: CommitManagerCommandArgs,
  proposal: ResolveFollowupProposal,
): Promise<ManagerCommandHandlerResult> {
  const followups = await args.repositories.followups.load();
  const current = followups.find((entry) => entry.issueId === proposal.issueId && entry.status === "awaiting-response");
  if (!current) {
    return {
      proposal,
      reason: "no awaiting follow-up found",
    };
  }

  const rejectionReason = validateFollowupProposalFields(current, proposal);
  if (rejectionReason) {
    return {
      proposal,
      reason: rejectionReason,
    };
  }

  const issue = await getLinearIssue(proposal.issueId, args.env, undefined, { includeComments: true });
  const assessment = buildFollowupResolutionLike(proposal);
  let updatedIssue = issue;
  let resolveReason: "answered" | "risk-cleared" | "completed" | undefined;

  if (proposal.requestKind === "owner" && proposal.extractedFields?.assignee) {
    updatedIssue = await applyFollowupExtractedFields(current, issue, assessment, args.message, args.env);
    resolveReason = updatedIssue.assignee ? "risk-cleared" : undefined;
  } else if (proposal.requestKind === "due-date" && proposal.extractedFields?.dueDate) {
    updatedIssue = await applyFollowupExtractedFields(current, issue, assessment, args.message, args.env);
    resolveReason = updatedIssue.dueDate ? "risk-cleared" : undefined;
  } else {
    updatedIssue = await applyFollowupExtractedFields(current, issue, assessment, args.message, args.env);
    if (proposal.answered && proposal.confidence >= 0.7) {
      resolveReason = issueMatchesCompletedState(updatedIssue) ? "completed" : "answered";
    }
  }

  let nextFollowups = updateFollowupsWithIssueResponse(
    followups,
    [updatedIssue],
    "followup-response",
    proposal.responseText,
    args.now,
  );
  nextFollowups = applyFollowupAssessmentResult(
    nextFollowups,
    updatedIssue.identifier,
    assessment,
    args.now,
    resolveReason,
  );
  await args.repositories.followups.save(nextFollowups);
  await recordFollowupTransitions(args.repositories.workgraph, followups, nextFollowups, {
    occurredAt: buildOccurredAt(args.now),
    source: {
      channelId: args.message.channelId,
      rootThreadTs: args.message.rootThreadTs,
      messageTs: args.message.messageTs,
    },
  });

  return {
    commandType: proposal.commandType,
    issueIds: [updatedIssue.identifier],
    summary: formatFollowupResolutionReply(current, updatedIssue, assessment),
  };
}

export async function commitReviewFollowupProposal(
  args: CommitManagerCommandArgs,
  proposal: ReviewFollowupProposal,
): Promise<ManagerCommandHandlerResult> {
  const followups = await args.repositories.followups.load();
  const nextEntry = buildAwaitingFollowupPatch(
    followups,
    {
      issueId: proposal.issueId,
      issueTitle: proposal.issueTitle,
      issueUrl: undefined,
      request: proposal.request,
      requestKind: proposal.requestKind,
      acceptableAnswerHint: proposal.acceptableAnswerHint,
      assigneeDisplayName: proposal.assigneeDisplayName,
      slackUserId: proposal.slackUserId,
      riskCategory: proposal.riskCategory,
      shouldMention: true,
      notification: {
        kind: "followup",
        mentionLevel: proposal.slackUserId ? "direct" : "none",
        targetSlackUserId: proposal.slackUserId,
      },
      source: proposal.source,
    },
    proposal.riskCategory,
    args.now,
    buildReviewDeps(),
  );
  const nextFollowups = upsertFollowup(followups, nextEntry);
  await args.repositories.followups.save(nextFollowups);
  await recordFollowupTransitions(args.repositories.workgraph, followups, nextFollowups, {
    occurredAt: buildOccurredAt(args.now),
    reviewKind: "heartbeat",
    source: proposal.source
      ? {
          channelId: proposal.source.channelId,
          rootThreadTs: proposal.source.rootThreadTs,
          messageTs: proposal.source.sourceMessageTs,
        }
      : undefined,
  });

  return {
    commandType: proposal.commandType,
    issueIds: [proposal.issueId],
    summary: `${proposal.issueId} の follow-up を作成しました。`,
  };
}
