import {
  addLinearComment,
  addLinearProgressComment,
  addLinearRelation,
  assignLinearIssue,
  getLinearIssue,
  markLinearIssueBlocked,
  updateManagedLinearIssue,
  type LinearIssue,
} from "../../linear.js";
import {
  formatCompactStatusReply,
  formatStatusReply,
} from "../../../orchestrators/updates/reply-format.js";
import { updateFollowupsWithIssueResponse } from "../../../orchestrators/updates/followup-state.js";
import { getSlackThreadContext } from "../../slack-context.js";
import { loadThreadQueryContinuation } from "../../query-continuation.js";
import { buildThreadPaths } from "../../thread-workspace.js";
import { loadExternalCoordinationHint } from "../../external-coordination-hint.js";
import { loadSystemThreadContext } from "../../system-thread-context.js";
import { buildWorkgraphThreadKey } from "../../../state/workgraph/events.js";
import { getThreadPlanningContext } from "../../../state/workgraph/queries.js";
import { recordFollowupTransitions, recordIssueSignals } from "../../../state/workgraph/recorder.js";
import type {
  AddCommentProposal,
  AddRelationProposal,
  AssignIssueProposal,
  ManagerCommandHandlerResult,
  SetIssueParentProposal,
  UpdateIssuePriorityProposal,
  UpdateIssueStatusProposal,
} from "../contracts.js";
import type {
  CommitManagerCommandArgs,
  ManagerCommitMessageContext,
  ManagerCommitSystemContext,
} from "../contracts.js";
import { buildOccurredAt, isMessageContext, unique } from "../common.js";

function extractIssueIdentifiers(text: string): string[] {
  return unique(
    Array.from(text.matchAll(/\b([A-Z][A-Z0-9]+-\d+)\b/g))
      .map((match) => match[1]?.trim())
      .filter(Boolean),
  );
}

interface CommitIssueHints {
  threadKey: string;
  explicitIssueIds: string[];
  recentIssueIds: string[];
  candidateIssueIds: string[];
  queryShownIssueIds: string[];
  systemThreadContextIssueIds: string[];
  latestFocusIssueId?: string;
  lastResolvedIssueId?: string;
  externalCoordinationHintIssueId?: string;
}

async function collectCommitIssueHints(args: CommitManagerCommandArgs): Promise<CommitIssueHints> {
  const threadKey = buildWorkgraphThreadKey(args.message.channelId, args.message.rootThreadTs);
  const threadPaths = buildThreadPaths(args.config.workspaceDir, args.message.channelId, args.message.rootThreadTs);
  const explicitIssueIds = extractIssueIdentifiers(args.message.text);
  const recentThread = await getSlackThreadContext(
    args.config.workspaceDir,
    args.message.channelId,
    args.message.rootThreadTs,
    8,
  ).catch(() => undefined);
  const recentIssueIds = unique(
    (recentThread?.entries ?? [])
      .slice(-6)
      .flatMap((entry) => extractIssueIdentifiers(entry.text ?? "")),
  );
  const lastQueryContext = await loadThreadQueryContinuation(threadPaths).catch(() => undefined);
  const externalCoordinationHint = await loadExternalCoordinationHint(threadPaths).catch(() => undefined);
  const systemThreadContext = await loadSystemThreadContext(threadPaths).catch(() => undefined);
  const planningContext = await getThreadPlanningContext(args.repositories.workgraph, threadKey);
  const latestFocusIssueId = planningContext?.thread.latestFocusIssueId;
  const lastResolvedIssueId = planningContext?.latestResolvedIssue?.issueId ?? planningContext?.thread.lastResolvedIssueId;
  const queryShownIssueIds = unique(
    lastQueryContext?.shownIssueIds?.length
      ? lastQueryContext.shownIssueIds
      : (lastQueryContext?.issueIds ?? []),
  );
  const candidateIssueIds = unique([
    latestFocusIssueId,
    lastResolvedIssueId,
    planningContext?.parentIssue?.issueId,
    ...(planningContext?.childIssues.map((issue) => issue.issueId) ?? []),
    ...(planningContext?.linkedIssues.map((issue) => issue.issueId) ?? []),
    ...queryShownIssueIds,
    ...(systemThreadContext?.issueRefs.map((entry) => entry.issueId) ?? []),
    externalCoordinationHint?.issueId,
    ...(explicitIssueIds.length === 0 && recentIssueIds.length === 1 ? recentIssueIds : []),
  ]);

  return {
    threadKey,
    explicitIssueIds,
    recentIssueIds,
    candidateIssueIds,
    queryShownIssueIds,
    systemThreadContextIssueIds: unique(systemThreadContext?.issueRefs.map((entry) => entry.issueId) ?? []),
    latestFocusIssueId,
    lastResolvedIssueId,
    externalCoordinationHintIssueId: externalCoordinationHint?.issueId,
  };
}

function validateIssueTargetHints(
  hints: CommitIssueHints,
  proposalIssueId: string,
): string | undefined {
  if (hints.explicitIssueIds.length > 0 && !hints.explicitIssueIds.includes(proposalIssueId)) {
    return `このメッセージでは ${hints.explicitIssueIds.join(", ")} が明示されていますが、更新提案は ${proposalIssueId} でした。更新する issue ID を明記してください。`;
  }

  if (hints.explicitIssueIds.length === 0 && hints.recentIssueIds.length === 1) {
    const recentIssueId = hints.recentIssueIds[0];
    if (
      recentIssueId
      && recentIssueId !== proposalIssueId
      && proposalIssueId !== hints.externalCoordinationHintIssueId
    ) {
      return `直近の会話では ${recentIssueId} を見ていましたが、更新提案は ${proposalIssueId} でした。更新する issue ID を明記してください。`;
    }
  }

  if (hints.candidateIssueIds.length === 0 && hints.explicitIssueIds.length === 0) {
    return "更新対象の issue をこの thread から特定できませんでした。`AIC-123` のように issue ID を添えてください。";
  }

  if (
    hints.candidateIssueIds.length === 1
    && hints.candidateIssueIds[0] !== proposalIssueId
    && !hints.explicitIssueIds.includes(proposalIssueId)
  ) {
    return `この thread で確認できる更新対象は ${hints.candidateIssueIds[0]} ですが、更新提案は ${proposalIssueId} でした。更新する issue ID を明記してください。`;
  }

  if (
    hints.candidateIssueIds.length > 1
    && !hints.explicitIssueIds.includes(proposalIssueId)
    && proposalIssueId !== hints.latestFocusIssueId
    && proposalIssueId !== hints.lastResolvedIssueId
    && !hints.queryShownIssueIds.includes(proposalIssueId)
    && !hints.systemThreadContextIssueIds.includes(proposalIssueId)
    && proposalIssueId !== hints.externalCoordinationHintIssueId
  ) {
    return "この thread には複数の issue が紐づいているため、どの issue を更新するか判断できませんでした。`AIC-123` のように issue ID を添えてください。";
  }

  return undefined;
}

async function validateUpdateIssueStatusProposal(
  args: CommitManagerCommandArgs,
  proposal: UpdateIssueStatusProposal,
): Promise<string | undefined> {
  return validateIssueTargetHints(await collectCommitIssueHints(args), proposal.issueId);
}

async function validateUpdateIssuePriorityProposal(
  args: CommitManagerCommandArgs,
  proposal: UpdateIssuePriorityProposal,
): Promise<string | undefined> {
  return validateIssueTargetHints(await collectCommitIssueHints(args), proposal.issueId);
}

async function validateAddCommentProposal(
  args: CommitManagerCommandArgs,
  proposal: AddCommentProposal,
): Promise<string | undefined> {
  if (!isMessageContext(args.message)) {
    return undefined;
  }
  return validateIssueTargetHints(await collectCommitIssueHints(args), proposal.issueId);
}

function normalizeCompletedStateAlias(state: string | undefined): string | undefined {
  const normalized = state?.trim();
  if (!normalized) return normalized;
  const lowered = normalized.toLowerCase();
  if (
    lowered === "cancel"
    || lowered === "cancelled"
    || lowered === "canceled"
    || normalized === "キャンセル"
    || normalized === "削除"
    || normalized === "取り消し"
  ) {
    return "Canceled";
  }
  return normalized;
}

async function runLoggedUpdateIssueStatusStep<T>(
  args: CommitManagerCommandArgs,
  proposal: UpdateIssueStatusProposal,
  step: string,
  action: () => Promise<T>,
): Promise<T> {
  args.logger?.info("update_issue_status step started", {
    issueId: proposal.issueId,
    signal: proposal.signal,
    step,
  });
  try {
    const result = await action();
    args.logger?.info("update_issue_status step completed", {
      issueId: proposal.issueId,
      signal: proposal.signal,
      step,
    });
    return result;
  } catch (error) {
    args.logger?.error("update_issue_status step failed", {
      issueId: proposal.issueId,
      signal: proposal.signal,
      step,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function runLoggedUpdateIssuePriorityStep<T>(
  args: CommitManagerCommandArgs,
  proposal: UpdateIssuePriorityProposal,
  step: string,
  action: () => Promise<T>,
): Promise<T> {
  args.logger?.info("update_issue_priority step started", {
    issueId: proposal.issueId,
    priority: proposal.priority,
    step,
  });
  try {
    const result = await action();
    args.logger?.info("update_issue_priority step completed", {
      issueId: proposal.issueId,
      priority: proposal.priority,
      step,
    });
    return result;
  } catch (error) {
    args.logger?.error("update_issue_priority step failed", {
      issueId: proposal.issueId,
      priority: proposal.priority,
      step,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function normalizeIssueStateName(issue: LinearIssue): string | undefined {
  return issue.state?.name?.trim();
}

function normalizeIssuePriority(issue: LinearIssue): number | undefined {
  return typeof issue.priority === "number" ? issue.priority : undefined;
}

function isLinearCommandTimeoutError(error: unknown): error is Error & { timeoutMs: number } {
  return error instanceof Error
    && error.name === "LinearCommandTimeoutError"
    && typeof (error as { timeoutMs?: unknown }).timeoutMs === "number";
}

function matchesRecoveredIssueUpdate(
  issue: LinearIssue,
  expected: {
    state?: string;
    dueDate?: string;
  },
): boolean {
  const actualState = normalizeIssueStateName(issue);
  if (expected.state && actualState !== expected.state) {
    return false;
  }
  if (expected.dueDate && issue.dueDate !== expected.dueDate) {
    return false;
  }
  return true;
}

function matchesRecoveredIssuePriority(
  issue: LinearIssue,
  expectedPriority: number,
): boolean {
  return normalizeIssuePriority(issue) === expectedPriority;
}

function hasRecoveredComment(issue: LinearIssue, expectedBody: string): boolean {
  const normalizedExpected = expectedBody.trim();
  return (issue.comments ?? []).some((comment) => comment.body.trim() === normalizedExpected);
}

function normalizeAssigneeValue(value: string | undefined | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function matchesRecoveredAssignee(issue: LinearIssue, expectedAssignee: string): boolean {
  const normalizedExpected = normalizeAssigneeValue(expectedAssignee);
  if (!normalizedExpected) {
    return false;
  }

  const candidates = new Set<string>();
  for (const value of [
    issue.assignee?.displayName,
    issue.assignee?.name,
    issue.assignee?.email,
    issue.assignee?.id,
  ]) {
    const normalized = normalizeAssigneeValue(value);
    if (normalized) {
      candidates.add(normalized);
    }
  }

  const email = normalizeAssigneeValue(issue.assignee?.email);
  if (email.includes("@")) {
    candidates.add(email.split("@")[0] ?? "");
  }

  return candidates.has(normalizedExpected);
}

async function recoverIssueUpdateAfterTimeout(args: {
  commitArgs: CommitManagerCommandArgs;
  proposal: UpdateIssueStatusProposal;
  state?: string;
  dueDate?: string;
  failedStep: string;
  error: unknown;
}): Promise<LinearIssue> {
  const { commitArgs, proposal, state, dueDate, failedStep, error } = args;
  if (!isLinearCommandTimeoutError(error)) {
    throw error;
  }
  const issue = await getLinearIssue(proposal.issueId, commitArgs.env);
  if (!matchesRecoveredIssueUpdate(issue, { state, dueDate })) {
    throw error;
  }
  commitArgs.logger?.warn("update_issue_status step recovered after timeout", {
    issueId: proposal.issueId,
    signal: proposal.signal,
    step: failedStep,
    recoveredState: normalizeIssueStateName(issue),
    recoveredDueDate: issue.dueDate ?? undefined,
    timeoutMs: error.timeoutMs,
  });
  return issue;
}

async function recoverCommentAfterTimeout(args: {
  commitArgs: CommitManagerCommandArgs;
  issueId: string;
  expectedBody: string;
  step: string;
  error: unknown;
}): Promise<void> {
  const { commitArgs, issueId, expectedBody, step, error } = args;
  if (!isLinearCommandTimeoutError(error)) {
    throw error;
  }
  const issue = await getLinearIssue(issueId, commitArgs.env, undefined, { includeComments: true });
  if (!hasRecoveredComment(issue, expectedBody)) {
    throw error;
  }
  commitArgs.logger?.warn("linear comment step recovered after timeout", {
    issueId,
    step,
    timeoutMs: error.timeoutMs,
    recoveredCommentLength: expectedBody.trim().length,
  });
}

async function recoverAssignIssueAfterTimeout(args: {
  commitArgs: CommitManagerCommandArgs;
  proposal: AssignIssueProposal;
  error: unknown;
}): Promise<LinearIssue> {
  const { commitArgs, proposal, error } = args;
  if (!isLinearCommandTimeoutError(error)) {
    throw error;
  }
  const issue = await getLinearIssue(proposal.issueId, commitArgs.env);
  if (!matchesRecoveredAssignee(issue, proposal.assignee)) {
    throw error;
  }
  commitArgs.logger?.warn("assign_issue recovered after timeout", {
    issueId: proposal.issueId,
    assignee: proposal.assignee,
    recoveredAssignee: issue.assignee?.displayName ?? issue.assignee?.name ?? issue.assignee?.email ?? undefined,
    timeoutMs: error.timeoutMs,
  });
  return issue;
}

async function recoverIssuePriorityAfterTimeout(args: {
  commitArgs: CommitManagerCommandArgs;
  proposal: UpdateIssuePriorityProposal;
  error: unknown;
}): Promise<LinearIssue> {
  const { commitArgs, proposal, error } = args;
  if (!isLinearCommandTimeoutError(error)) {
    throw error;
  }
  const issue = await getLinearIssue(proposal.issueId, commitArgs.env);
  if (!matchesRecoveredIssuePriority(issue, proposal.priority)) {
    throw error;
  }
  commitArgs.logger?.warn("update_issue_priority recovered after timeout", {
    issueId: proposal.issueId,
    priority: proposal.priority,
    recoveredPriority: normalizeIssuePriority(issue),
    timeoutMs: error.timeoutMs,
  });
  return issue;
}

function formatPriorityLabel(priority: number): string {
  switch (priority) {
    case 1:
      return "Urgent";
    case 2:
      return "High";
    case 3:
      return "Medium";
    case 4:
      return "Low";
    default:
      return `Priority ${priority}`;
  }
}

function formatPriorityChangeVerb(args: {
  beforePriority?: number;
  afterPriority: number;
}): string {
  const { beforePriority, afterPriority } = args;
  if (beforePriority == null || beforePriority === afterPriority) {
    return "変更しました";
  }
  return afterPriority > beforePriority ? "下げました" : "上げました";
}

export function buildStatusSourceComment(
  message: ManagerCommitMessageContext | ManagerCommitSystemContext,
  heading: string,
): string {
  return [
    heading,
    `- channelId: ${message.channelId}`,
    `- rootThreadTs: ${message.rootThreadTs}`,
    `- sourceMessageTs: ${message.messageTs}`,
    "",
    message.text.trim(),
  ].join("\n");
}

export async function commitUpdateIssueStatusProposal(
  args: CommitManagerCommandArgs,
  proposal: UpdateIssueStatusProposal,
): Promise<ManagerCommandHandlerResult> {
  const rejectionReason = await validateUpdateIssueStatusProposal(args, proposal);
  if (rejectionReason) {
    return {
      proposal,
      reason: rejectionReason,
    };
  }

  const followups = await args.repositories.followups.load();
  const occurredAt = buildOccurredAt(args.now);
  const message = args.message;
  const normalizedCompletedState = proposal.signal === "completed"
    ? normalizeCompletedStateAlias(proposal.state)
    : proposal.state;
  const updatedIssues: LinearIssue[] = [];
  const blockedStateByIssueId = new Map<string, boolean>();
  const replyExtras: string[] = [];

  if (proposal.signal === "progress") {
    const progressComment = proposal.commentBody ?? buildStatusSourceComment(message, "## Progress source");
    if (proposal.dueDate || proposal.state) {
      const normalizedProgressComment = progressComment.startsWith("## Progress update")
        ? progressComment
        : `## Progress update\n${progressComment.trim()}`;
      updatedIssues.push(await runLoggedUpdateIssueStatusStep(args, proposal, "update_issue", async () => {
        try {
          return await updateManagedLinearIssue(
            {
              issueId: proposal.issueId,
              state: proposal.state,
              dueDate: proposal.dueDate,
            },
            args.env,
          );
        } catch (error) {
          return recoverIssueUpdateAfterTimeout({
            commitArgs: args,
            proposal,
            state: proposal.state,
            dueDate: proposal.dueDate,
            failedStep: "update_issue",
            error,
          });
        }
      }));
      await runLoggedUpdateIssueStatusStep(args, proposal, "add_comment", async () => {
        try {
          await addLinearComment(
            proposal.issueId,
            normalizedProgressComment,
            args.env,
          );
        } catch (error) {
          await recoverCommentAfterTimeout({
            commitArgs: args,
            issueId: proposal.issueId,
            expectedBody: normalizedProgressComment,
            step: "add_comment",
            error,
          });
        }
      });
    } else {
      const normalizedProgressComment = `## Progress update\n${progressComment.trim()}`;
      await runLoggedUpdateIssueStatusStep(args, proposal, "add_comment", async () => {
        try {
          await addLinearProgressComment(
            proposal.issueId,
            progressComment,
            args.env,
          );
        } catch (error) {
          await recoverCommentAfterTimeout({
            commitArgs: args,
            issueId: proposal.issueId,
            expectedBody: normalizedProgressComment,
            step: "add_comment",
            error,
          });
        }
      });
      updatedIssues.push(await runLoggedUpdateIssueStatusStep(args, proposal, "reload_issue", () => getLinearIssue(
        proposal.issueId,
        args.env,
      )));
    }
  } else if (proposal.signal === "completed") {
    const completionComment = proposal.commentBody ?? buildStatusSourceComment(message, "## Completion source");
    updatedIssues.push(await runLoggedUpdateIssueStatusStep(args, proposal, "update_issue", async () => {
      try {
        return await updateManagedLinearIssue(
          {
            issueId: proposal.issueId,
            state: normalizedCompletedState ?? "completed",
            dueDate: proposal.dueDate,
          },
          args.env,
        );
      } catch (error) {
        return recoverIssueUpdateAfterTimeout({
          commitArgs: args,
          proposal,
          state: normalizedCompletedState ?? "completed",
          dueDate: proposal.dueDate,
          failedStep: "update_issue",
          error,
        });
      }
    }));
    await runLoggedUpdateIssueStatusStep(args, proposal, "add_comment", async () => {
      try {
        await addLinearComment(
          proposal.issueId,
          completionComment,
          args.env,
        );
      } catch (error) {
        await recoverCommentAfterTimeout({
          commitArgs: args,
          issueId: proposal.issueId,
          expectedBody: completionComment,
          step: "add_comment",
          error,
        });
      }
    });
  } else {
    const blocked = await runLoggedUpdateIssueStatusStep(args, proposal, "blocked_update", () => markLinearIssueBlocked(
      proposal.issueId,
      proposal.commentBody ?? buildStatusSourceComment(message, "## Blocked source"),
      args.env,
    ));
    const blockedIssue = proposal.dueDate
      ? await runLoggedUpdateIssueStatusStep(args, proposal, "update_issue", () => updateManagedLinearIssue(
          {
            issueId: proposal.issueId,
            dueDate: proposal.dueDate,
          },
          args.env,
        ))
      : blocked.issue;
    updatedIssues.push(blockedIssue);
    blockedStateByIssueId.set(proposal.issueId, blocked.blockedStateApplied);
  }

  if (proposal.dueDate) {
    const reflectedDueDate = updatedIssues
      .map((issue) => issue.dueDate)
      .find((dueDate): dueDate is string => Boolean(dueDate));
    if (reflectedDueDate) {
      replyExtras.push(`期限は ${reflectedDueDate} として反映しました。`);
    }
  }

  const nextFollowups = updateFollowupsWithIssueResponse(
    followups,
    updatedIssues,
    proposal.signal,
    message.text,
    args.now,
  );
  await runLoggedUpdateIssueStatusStep(args, proposal, "save_followups", () => args.repositories.followups.save(nextFollowups));
  await runLoggedUpdateIssueStatusStep(args, proposal, "record_issue_signals", () => recordIssueSignals(args.repositories.workgraph, {
    occurredAt,
    source: {
      channelId: message.channelId,
      rootThreadTs: message.rootThreadTs,
      messageTs: message.messageTs,
    },
    textSnippet: message.text,
    updates: updatedIssues.map((issue) => ({
      issueId: issue.identifier,
      signal: proposal.signal,
      blockedStateApplied: blockedStateByIssueId.get(issue.identifier),
      dueDate: issue.dueDate ?? undefined,
    })),
  }));
  await runLoggedUpdateIssueStatusStep(args, proposal, "record_followup_transitions", () => recordFollowupTransitions(args.repositories.workgraph, followups, nextFollowups, {
    occurredAt,
    source: {
      channelId: message.channelId,
      rootThreadTs: message.rootThreadTs,
      messageTs: message.messageTs,
    },
  }));

  return {
    commandType: proposal.commandType,
    issueIds: updatedIssues.map((issue) => issue.identifier),
    summary: formatStatusReply(proposal.signal, updatedIssues, replyExtras),
    publicReply: updatedIssues.length === 1
      ? formatCompactStatusReply(proposal.signal, updatedIssues[0], replyExtras)
      : undefined,
  };
}

export async function commitUpdateIssuePriorityProposal(
  args: CommitManagerCommandArgs,
  proposal: UpdateIssuePriorityProposal,
): Promise<ManagerCommandHandlerResult> {
  const rejectionReason = await validateUpdateIssuePriorityProposal(args, proposal);
  if (rejectionReason) {
    return {
      proposal,
      reason: rejectionReason,
    };
  }

  const previousIssue = await runLoggedUpdateIssuePriorityStep(args, proposal, "load_issue_before_update", () => getLinearIssue(
    proposal.issueId,
    args.env,
  ));
  const updatedIssue = await runLoggedUpdateIssuePriorityStep(args, proposal, "update_issue", async () => {
    try {
      return await updateManagedLinearIssue(
        {
          issueId: proposal.issueId,
          priority: proposal.priority,
        },
        args.env,
      );
    } catch (error) {
      return recoverIssuePriorityAfterTimeout({
        commitArgs: args,
        proposal,
        error,
      });
    }
  });

  if (proposal.commentBody) {
    const commentBody = proposal.commentBody;
    await runLoggedUpdateIssuePriorityStep(args, proposal, "add_comment", async () => {
      try {
        await addLinearComment(
          proposal.issueId,
          commentBody,
          args.env,
        );
      } catch (error) {
        await recoverCommentAfterTimeout({
          commitArgs: args,
          issueId: proposal.issueId,
          expectedBody: commentBody,
          step: "add_comment",
          error,
        });
      }
    });
  }

  const priorityLabel = formatPriorityLabel(proposal.priority);
  const verb = formatPriorityChangeVerb({
    beforePriority: normalizeIssuePriority(previousIssue),
    afterPriority: proposal.priority,
  });
  const publicReply = proposal.commentBody
    ? `${updatedIssue.identifier} の優先度を ${priorityLabel} に${verb}。理由はコメントに残しました。`
    : `${updatedIssue.identifier} の優先度を ${priorityLabel} に${verb}。`;

  return {
    commandType: proposal.commandType,
    issueIds: [updatedIssue.identifier],
    summary: publicReply,
    publicReply,
  };
}

export async function commitAssignIssueProposal(
  args: CommitManagerCommandArgs,
  proposal: AssignIssueProposal,
): Promise<ManagerCommandHandlerResult> {
  const issue = await (async () => {
    try {
      return await assignLinearIssue(proposal.issueId, proposal.assignee, args.env);
    } catch (error) {
      return recoverAssignIssueAfterTimeout({
        commitArgs: args,
        proposal,
        error,
      });
    }
  })();
  const assigneeLabel = issue.assignee?.displayName ?? issue.assignee?.name ?? issue.assignee?.email ?? proposal.assignee;
  return {
    commandType: proposal.commandType,
    issueIds: [issue.identifier],
    summary: `${issue.identifier} の担当を ${assigneeLabel} に更新しました。`,
  };
}

export async function commitAddCommentProposal(
  args: CommitManagerCommandArgs,
  proposal: AddCommentProposal,
): Promise<ManagerCommandHandlerResult> {
  const rejectionReason = await validateAddCommentProposal(args, proposal);
  if (rejectionReason) {
    return {
      proposal,
      reason: rejectionReason,
    };
  }
  try {
    await addLinearComment(proposal.issueId, proposal.body, args.env);
  } catch (error) {
    await recoverCommentAfterTimeout({
      commitArgs: args,
      issueId: proposal.issueId,
      expectedBody: proposal.body,
      step: "add_comment",
      error,
    });
  }
  return {
    commandType: proposal.commandType,
    issueIds: [proposal.issueId],
    summary: `${proposal.issueId} にコメントを追加しました。`,
  };
}

export async function commitAddRelationProposal(
  args: CommitManagerCommandArgs,
  proposal: AddRelationProposal,
): Promise<ManagerCommandHandlerResult> {
  await addLinearRelation(proposal.issueId, proposal.relationType, proposal.relatedIssueId, args.env);
  return {
    commandType: proposal.commandType,
    issueIds: [proposal.issueId, proposal.relatedIssueId],
    summary: `${proposal.issueId} と ${proposal.relatedIssueId} の依存関係を更新しました。`,
  };
}

export async function commitSetIssueParentProposal(
  args: CommitManagerCommandArgs,
  proposal: SetIssueParentProposal,
): Promise<ManagerCommandHandlerResult> {
  if (proposal.issueId === proposal.parentIssueId) {
    return {
      proposal,
      reason: "親 issue と子 issue に同じ issue ID は使えません。親子関係を確認してください。",
    };
  }

  const updatedIssue = await updateManagedLinearIssue(
    {
      issueId: proposal.issueId,
      parent: proposal.parentIssueId,
    },
    args.env,
  );

  await args.repositories.workgraph.append([
    {
      type: "issue.parent_updated",
      occurredAt: buildOccurredAt(args.now),
      threadKey: buildWorkgraphThreadKey(args.message.channelId, args.message.rootThreadTs),
      sourceChannelId: args.message.channelId,
      sourceThreadTs: args.message.rootThreadTs,
      sourceMessageTs: args.message.messageTs,
      issueId: proposal.issueId,
      parentIssueId: proposal.parentIssueId,
      title: updatedIssue.title,
    },
  ]);

  return {
    commandType: proposal.commandType,
    issueIds: [proposal.issueId, proposal.parentIssueId],
    summary: `${proposal.issueId} を ${proposal.parentIssueId} の子 task として反映しました。`,
  };
}
