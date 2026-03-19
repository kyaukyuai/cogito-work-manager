import { z } from "zod";
import type { AppConfig } from "./config.js";
import {
  addLinearComment,
  addLinearProgressComment,
  addLinearRelation,
  assignLinearIssue,
  createManagedLinearIssue,
  createManagedLinearIssueBatch,
  getLinearIssue,
  markLinearIssueBlocked,
  searchLinearIssues,
  updateManagedLinearIssue,
  updateLinearIssueState,
  type LinearCommandEnv,
  type LinearIssue,
} from "./linear.js";
import type {
  FollowupLedgerEntry,
  ManagerPolicy,
} from "../state/manager-state-contract.js";
import type { ManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import {
  buildPlanningChildRecord,
  recordIntakeLinkedExisting,
  recordFollowupTransitions,
  recordIssueSignals,
  recordPlanningOutcome,
} from "../state/workgraph/recorder.js";
import { buildWorkgraphThreadKey } from "../state/workgraph/events.js";
import { findExistingThreadIntakeByFingerprint } from "../state/workgraph/queries.js";
import { chooseOwner } from "../orchestrators/intake/planning-support.js";
import {
  compactLinearIssues,
  formatAutonomousCreateReply,
  formatExistingIssueReply,
  formatSourceComment,
} from "../orchestrators/intake/formatting.js";
import { formatStatusReply, formatFollowupResolutionReply } from "../orchestrators/updates/reply-format.js";
import {
  applyFollowupAssessmentResult,
  applyFollowupExtractedFields,
  updateFollowupsWithIssueResponse,
} from "../orchestrators/updates/followup-state.js";
import type { FollowupResolutionResult } from "./pi-session.js";
import { issueMatchesCompletedState } from "../orchestrators/review/risk.js";
import {
  buildAwaitingFollowupPatch,
  upsertFollowup,
  type ReviewHelperDeps,
} from "../orchestrators/review/review-helpers.js";

const optionalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
const optionalStringSchema = z.string().trim().min(1).optional();

const proposalBaseSchema = z.object({
  reasonSummary: z.string().trim().min(1),
  evidenceSummary: z.string().trim().min(1).optional(),
  dedupeKeyCandidate: z.string().trim().min(1).optional(),
});

const createIssuePayloadSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  state: optionalStringSchema,
  dueDate: optionalDateSchema,
  assignee: optionalStringSchema,
  parent: optionalStringSchema,
  priority: z.number().int().min(0).max(4).optional(),
});

const createIssueProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("create_issue"),
  planningReason: z.enum(["single-issue", "complex-request", "research-first"]).default("single-issue"),
  issue: createIssuePayloadSchema,
});

const createIssueBatchProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("create_issue_batch"),
  planningReason: z.enum(["single-issue", "complex-request", "research-first"]),
  parent: createIssuePayloadSchema,
  children: z.array(createIssuePayloadSchema.extend({
    kind: z.enum(["execution", "research"]).default("execution"),
  })).min(1).max(8),
});

const updateIssueStatusProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("update_issue_status"),
  issueId: z.string().trim().min(1),
  signal: z.enum(["progress", "completed", "blocked"]),
  commentBody: optionalStringSchema,
  state: optionalStringSchema,
});

const assignIssueProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("assign_issue"),
  issueId: z.string().trim().min(1),
  assignee: z.string().trim().min(1),
});

const addCommentProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("add_comment"),
  issueId: z.string().trim().min(1),
  body: z.string().trim().min(1),
});

const addRelationProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("add_relation"),
  issueId: z.string().trim().min(1),
  relatedIssueId: z.string().trim().min(1),
  relationType: z.enum(["blocks", "blocked-by"]),
});

const followupExtractedFieldsSchema = z.record(z.string(), z.string()).default({});

const resolveFollowupProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("resolve_followup"),
  issueId: z.string().trim().min(1),
  answered: z.boolean(),
  confidence: z.number().min(0).max(1),
  answerKind: optionalStringSchema,
  requestKind: z.enum(["status", "blocked-details", "owner", "due-date"]).optional(),
  responseText: z.string().trim().min(1),
  acceptableAnswerHint: optionalStringSchema,
  extractedFields: followupExtractedFieldsSchema.optional(),
});

const reviewFollowupProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("review_followup"),
  issueId: z.string().trim().min(1),
  issueTitle: z.string().trim().min(1),
  riskCategory: z.string().trim().min(1),
  requestKind: z.enum(["status", "blocked-details", "owner", "due-date"]),
  request: z.string().trim().min(1),
  acceptableAnswerHint: optionalStringSchema,
  assigneeDisplayName: optionalStringSchema,
  slackUserId: optionalStringSchema,
  source: z.object({
    channelId: z.string().trim().min(1),
    rootThreadTs: z.string().trim().min(1),
    sourceMessageTs: z.string().trim().min(1),
  }).optional(),
});

export const managerCommandProposalSchema = z.discriminatedUnion("commandType", [
  createIssueProposalSchema,
  createIssueBatchProposalSchema,
  updateIssueStatusProposalSchema,
  assignIssueProposalSchema,
  addCommentProposalSchema,
  addRelationProposalSchema,
  resolveFollowupProposalSchema,
  reviewFollowupProposalSchema,
]);

export type ManagerCommandProposal = z.infer<typeof managerCommandProposalSchema>;

export interface ManagerIntentReport {
  intent:
    | "conversation"
    | "query"
    | "create_work"
    | "update_progress"
    | "update_completed"
    | "update_blocked"
    | "followup_resolution"
    | "review"
    | "heartbeat"
    | "scheduler";
  queryKind?: "list-active" | "list-today" | "what-should-i-do" | "inspect-work" | "search-existing" | "recommend-next-step";
  queryScope?: "self" | "team" | "thread-context";
  confidence?: number;
  summary?: string;
}

export interface ManagerAgentToolCall {
  toolName: string;
  input?: unknown;
  details?: unknown;
  isError?: boolean;
}

export interface ManagerCommitMessageContext {
  channelId: string;
  rootThreadTs: string;
  messageTs: string;
  userId?: string;
  text: string;
}

export interface ManagerCommitSystemContext {
  channelId: string;
  rootThreadTs: string;
  messageTs: string;
  text: string;
}

export interface ManagerProposalRejection {
  proposal: ManagerCommandProposal;
  reason: string;
}

export interface ManagerCommittedCommand {
  commandType: ManagerCommandProposal["commandType"];
  issueIds: string[];
  summary: string;
}

export interface ManagerCommitResult {
  committed: ManagerCommittedCommand[];
  rejected: ManagerProposalRejection[];
  replySummaries: string[];
}

export interface CommitManagerCommandArgs {
  config: AppConfig;
  repositories: Pick<ManagerRepositories, "ownerMap" | "planning" | "followups" | "workgraph">;
  proposals: ManagerCommandProposal[];
  message: ManagerCommitMessageContext | ManagerCommitSystemContext;
  now: Date;
  policy: ManagerPolicy;
  env: LinearCommandEnv;
}

function normalizeTitle(title: string | undefined): string {
  return (title ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[。！!？?]+$/g, "")
    .toLowerCase();
}

function fingerprintText(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[。！!？?]+$/g, "")
    .toLowerCase()
    .replace(/(linear|issue|イシュー|ticket|チケット|todo|タスク|登録|追加|作成|作って|しておいて|お願い|お願いします)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeProposalKey(proposal: ManagerCommandProposal): string {
  return proposal.dedupeKeyCandidate
    ?? JSON.stringify({
      commandType: proposal.commandType,
      proposal,
    });
}

function isMessageContext(value: CommitManagerCommandArgs["message"]): value is ManagerCommitMessageContext {
  return "userId" in value;
}

function buildOccurredAt(now: Date): string {
  return now.toISOString();
}

function buildPlanningEntry(sourceThread: string, parentIssueId: string | undefined, generatedChildIssueIds: string[], planningReason: "single-issue" | "complex-request" | "research-first", ownerResolution: "mapped" | "fallback", nowIso: string) {
  return {
    sourceThread,
    parentIssueId,
    generatedChildIssueIds,
    planningReason,
    ownerResolution,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

function buildStatusSourceComment(message: ManagerCommitMessageContext | ManagerCommitSystemContext, heading: string): string {
  return [
    heading,
    `- channelId: ${message.channelId}`,
    `- rootThreadTs: ${message.rootThreadTs}`,
    `- sourceMessageTs: ${message.messageTs}`,
    "",
    message.text.trim(),
  ].join("\n");
}

function buildFollowupResolutionLike(proposal: z.infer<typeof resolveFollowupProposalSchema>): FollowupResolutionResult {
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

export function extractIntentReport(toolCalls: ManagerAgentToolCall[]): ManagerIntentReport | undefined {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const details = toolCalls[index]?.details as { intentReport?: unknown } | undefined;
    const intentReport = details?.intentReport;
    if (!intentReport || typeof intentReport !== "object") continue;
    const parsed = z.object({
      intent: z.enum([
        "conversation",
        "query",
        "create_work",
        "update_progress",
        "update_completed",
        "update_blocked",
        "followup_resolution",
        "review",
        "heartbeat",
        "scheduler",
      ]),
      queryKind: z.enum([
        "list-active",
        "list-today",
        "what-should-i-do",
        "inspect-work",
        "search-existing",
        "recommend-next-step",
      ]).optional(),
      queryScope: z.enum(["self", "team", "thread-context"]).optional(),
      confidence: z.number().min(0).max(1).optional(),
      summary: z.string().optional(),
    }).safeParse(intentReport);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

export function extractManagerCommandProposals(toolCalls: ManagerAgentToolCall[]): {
  proposals: ManagerCommandProposal[];
  invalidProposalCount: number;
} {
  const proposals: ManagerCommandProposal[] = [];
  let invalidProposalCount = 0;

  for (const toolCall of toolCalls) {
    const details = toolCall.details as { proposal?: unknown } | undefined;
    if (!details?.proposal) continue;
    const parsed = managerCommandProposalSchema.safeParse(details.proposal);
    if (parsed.success) {
      proposals.push(parsed.data);
    } else {
      invalidProposalCount += 1;
    }
  }

  return { proposals, invalidProposalCount };
}

async function commitCreateIssueProposal(
  args: CommitManagerCommandArgs,
  proposal: z.infer<typeof createIssueProposalSchema>,
): Promise<ManagerCommittedCommand | ManagerProposalRejection> {
  const ownerMap = await args.repositories.ownerMap.load();
  const planningLedger = await args.repositories.planning.load();
  const occurredAt = buildOccurredAt(args.now);
  const threadKey = buildWorkgraphThreadKey(args.message.channelId, args.message.rootThreadTs);
  const fingerprint = fingerprintText(args.message.text);
  const existingThreadIntake = await findExistingThreadIntakeByFingerprint(
    args.repositories.workgraph,
    threadKey,
    fingerprint,
  );

  if (existingThreadIntake) {
    return {
      proposal,
      reason: "duplicate intake already recorded for this thread",
    };
  }

  const duplicates = await searchLinearIssues(
    {
      query: proposal.issue.title.slice(0, 32),
      limit: 5,
    },
    args.env,
  );
  if (duplicates.length > 0) {
    await recordIntakeLinkedExisting(args.repositories.workgraph, {
      occurredAt,
      source: {
        channelId: args.message.channelId,
        rootThreadTs: args.message.rootThreadTs,
        messageTs: args.message.messageTs,
      },
      messageFingerprint: fingerprint,
      linkedIssueIds: duplicates.map((issue) => issue.identifier),
      lastResolvedIssueId: duplicates[0]?.identifier,
      originalText: args.message.text,
    });
    return {
      commandType: proposal.commandType,
      issueIds: duplicates.map((issue) => issue.identifier),
      summary: formatExistingIssueReply(duplicates),
    };
  }

  const owner = proposal.issue.assignee
    ? undefined
    : chooseOwner(proposal.issue.title, ownerMap);
  const issue = await createManagedLinearIssue(
    {
      ...proposal.issue,
      assignee: proposal.issue.assignee ?? owner?.entry.linearAssignee,
    },
    args.env,
  );
  await addLinearComment(issue.identifier, formatSourceComment(args.message, proposal.planningReason), args.env);

  const nextPlanning = [
    ...planningLedger,
    buildPlanningEntry(
      threadKey,
      undefined,
      [issue.identifier],
      proposal.planningReason,
      owner?.resolution === "fallback" ? "fallback" : "mapped",
      occurredAt,
    ),
  ];
  await args.repositories.planning.save(nextPlanning);
  await recordPlanningOutcome(args.repositories.workgraph, {
    occurredAt,
    source: {
      channelId: args.message.channelId,
      rootThreadTs: args.message.rootThreadTs,
      messageTs: args.message.messageTs,
    },
    messageFingerprint: fingerprint,
    parentIssueId: undefined,
    childIssues: [buildPlanningChildRecord(issue, "execution", {
      dueDate: proposal.issue.dueDate,
      assignee: proposal.issue.assignee ?? owner?.entry.linearAssignee,
    })],
    planningReason: proposal.planningReason,
    ownerResolution: owner?.resolution === "fallback" ? "fallback" : "mapped",
    lastResolvedIssueId: issue.identifier,
    originalText: args.message.text,
  });

  return {
    commandType: proposal.commandType,
    issueIds: [issue.identifier],
    summary: formatAutonomousCreateReply(undefined, [issue], "single-issue", owner?.resolution === "fallback"),
  };
}

async function commitCreateIssueBatchProposal(
  args: CommitManagerCommandArgs,
  proposal: z.infer<typeof createIssueBatchProposalSchema>,
): Promise<ManagerCommittedCommand | ManagerProposalRejection> {
  if (
    proposal.children.length === 1
    && normalizeTitle(proposal.parent.title) === normalizeTitle(proposal.children[0]?.title)
  ) {
    return commitCreateIssueProposal(args, {
      commandType: "create_issue",
      planningReason: "single-issue",
      issue: {
        title: proposal.children[0]!.title,
        description: proposal.children[0]!.description,
        dueDate: proposal.children[0]!.dueDate,
        assignee: proposal.children[0]!.assignee,
        priority: proposal.children[0]!.priority,
        state: proposal.children[0]!.state,
      },
      reasonSummary: proposal.reasonSummary,
      evidenceSummary: proposal.evidenceSummary,
      dedupeKeyCandidate: proposal.dedupeKeyCandidate,
    });
  }
  const ownerMap = await args.repositories.ownerMap.load();
  const planningLedger = await args.repositories.planning.load();
  const occurredAt = buildOccurredAt(args.now);
  const threadKey = buildWorkgraphThreadKey(args.message.channelId, args.message.rootThreadTs);
  const fingerprint = fingerprintText(args.message.text);
  const existingThreadIntake = await findExistingThreadIntakeByFingerprint(
    args.repositories.workgraph,
    threadKey,
    fingerprint,
  );

  if (existingThreadIntake) {
    return {
      proposal,
      reason: "duplicate intake already recorded for this thread",
    };
  }

  const parentOwner = proposal.parent.assignee
    ? undefined
    : chooseOwner(proposal.parent.title, ownerMap);
  const usedFallback = new Set<string>();
  if (parentOwner?.resolution === "fallback") {
    usedFallback.add(parentOwner.entry.id);
  }

  const batch = await createManagedLinearIssueBatch(
    {
      parent: {
        ...proposal.parent,
        assignee: proposal.parent.assignee ?? parentOwner?.entry.linearAssignee,
      },
      children: proposal.children.map((child) => {
        const childOwner = child.assignee
          ? undefined
          : chooseOwner(child.title, ownerMap);
        if (childOwner?.resolution === "fallback") {
          usedFallback.add(childOwner.entry.id);
        }
        return {
          ...child,
          assignee: child.assignee ?? childOwner?.entry.linearAssignee,
        };
      }),
    },
    args.env,
  );

  const parent = batch.parent;
  const children = compactLinearIssues(batch.children);
  await addLinearComment(parent.identifier, formatSourceComment(args.message, proposal.planningReason), args.env);
  for (const child of children) {
    await addLinearComment(child.identifier, formatSourceComment(args.message, proposal.planningReason), args.env);
  }
  if (children.length > 1) {
    for (let index = 1; index < children.length; index += 1) {
      await addLinearRelation(children[index - 1]!.identifier, "blocks", children[index]!.identifier, args.env);
    }
  }

  const nextPlanning = [
    ...planningLedger,
    buildPlanningEntry(
      threadKey,
      parent.identifier,
      children.map((issue) => issue.identifier),
      proposal.planningReason,
      usedFallback.size > 0 ? "fallback" : "mapped",
      occurredAt,
    ),
  ];
  await args.repositories.planning.save(nextPlanning);
  await recordPlanningOutcome(args.repositories.workgraph, {
    occurredAt,
    source: {
      channelId: args.message.channelId,
      rootThreadTs: args.message.rootThreadTs,
      messageTs: args.message.messageTs,
    },
    messageFingerprint: fingerprint,
    parentIssue: {
      issueId: parent.identifier,
      title: parent.title,
      dueDate: proposal.parent.dueDate,
      assignee: proposal.parent.assignee ?? parentOwner?.entry.linearAssignee,
    },
    parentIssueId: parent.identifier,
    childIssues: children.map((issue, index) => buildPlanningChildRecord(
      issue,
      proposal.children[index]?.kind ?? "execution",
      {
        dueDate: proposal.children[index]?.dueDate,
        assignee: proposal.children[index]?.assignee,
      },
    )),
    planningReason: proposal.planningReason,
    ownerResolution: usedFallback.size > 0 ? "fallback" : "mapped",
    lastResolvedIssueId: children[0]?.identifier,
    originalText: args.message.text,
  });

  return {
    commandType: proposal.commandType,
    issueIds: [parent.identifier, ...children.map((issue) => issue.identifier)],
    summary: formatAutonomousCreateReply(parent, children, proposal.planningReason, usedFallback.size > 0),
  };
}

async function commitUpdateIssueStatusProposal(
  args: CommitManagerCommandArgs,
  proposal: z.infer<typeof updateIssueStatusProposalSchema>,
): Promise<ManagerCommittedCommand | ManagerProposalRejection> {
  const followups = await args.repositories.followups.load();
  const occurredAt = buildOccurredAt(args.now);
  const message = args.message;
  const updatedIssues: LinearIssue[] = [];
  const blockedStateByIssueId = new Map<string, boolean>();

  if (proposal.signal === "progress") {
    await addLinearProgressComment(
      proposal.issueId,
      proposal.commentBody ?? buildStatusSourceComment(message, "## Progress source"),
      args.env,
    );
    updatedIssues.push(await getLinearIssue(proposal.issueId, args.env));
  } else if (proposal.signal === "completed") {
    updatedIssues.push(await updateLinearIssueState(proposal.issueId, proposal.state ?? "completed", args.env));
    await addLinearComment(
      proposal.issueId,
      proposal.commentBody ?? buildStatusSourceComment(message, "## Completion source"),
      args.env,
    );
  } else {
    const blocked = await markLinearIssueBlocked(
      proposal.issueId,
      proposal.commentBody ?? buildStatusSourceComment(message, "## Blocked source"),
      args.env,
    );
    updatedIssues.push(blocked.issue);
    blockedStateByIssueId.set(proposal.issueId, blocked.blockedStateApplied);
  }

  const nextFollowups = updateFollowupsWithIssueResponse(
    followups,
    updatedIssues,
    proposal.signal,
    message.text,
    args.now,
  );
  await args.repositories.followups.save(nextFollowups);
  await recordIssueSignals(args.repositories.workgraph, {
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
    })),
  });
  await recordFollowupTransitions(args.repositories.workgraph, followups, nextFollowups, {
    occurredAt,
    source: {
      channelId: message.channelId,
      rootThreadTs: message.rootThreadTs,
      messageTs: message.messageTs,
    },
  });

  return {
    commandType: proposal.commandType,
    issueIds: updatedIssues.map((issue) => issue.identifier),
    summary: formatStatusReply(proposal.signal, updatedIssues),
  };
}

async function commitAssignIssueProposal(
  args: CommitManagerCommandArgs,
  proposal: z.infer<typeof assignIssueProposalSchema>,
): Promise<ManagerCommittedCommand> {
  const issue = await assignLinearIssue(proposal.issueId, proposal.assignee, args.env);
  return {
    commandType: proposal.commandType,
    issueIds: [issue.identifier],
    summary: `${issue.identifier} の担当を ${proposal.assignee} に更新しました。`,
  };
}

async function commitAddCommentProposal(
  args: CommitManagerCommandArgs,
  proposal: z.infer<typeof addCommentProposalSchema>,
): Promise<ManagerCommittedCommand> {
  await addLinearComment(proposal.issueId, proposal.body, args.env);
  return {
    commandType: proposal.commandType,
    issueIds: [proposal.issueId],
    summary: `${proposal.issueId} にコメントを追加しました。`,
  };
}

async function commitAddRelationProposal(
  args: CommitManagerCommandArgs,
  proposal: z.infer<typeof addRelationProposalSchema>,
): Promise<ManagerCommittedCommand> {
  await addLinearRelation(proposal.issueId, proposal.relationType, proposal.relatedIssueId, args.env);
  return {
    commandType: proposal.commandType,
    issueIds: [proposal.issueId, proposal.relatedIssueId],
    summary: `${proposal.issueId} と ${proposal.relatedIssueId} の依存関係を更新しました。`,
  };
}

async function commitResolveFollowupProposal(
  args: CommitManagerCommandArgs,
  proposal: z.infer<typeof resolveFollowupProposalSchema>,
): Promise<ManagerCommittedCommand | ManagerProposalRejection> {
  const followups = await args.repositories.followups.load();
  const current = followups.find((entry) => entry.issueId === proposal.issueId && entry.status === "awaiting-response");
  if (!current) {
    return {
      proposal,
      reason: "no awaiting follow-up found",
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

async function commitReviewFollowupProposal(
  args: CommitManagerCommandArgs,
  proposal: z.infer<typeof reviewFollowupProposalSchema>,
): Promise<ManagerCommittedCommand> {
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

export async function commitManagerCommandProposals(args: CommitManagerCommandArgs): Promise<ManagerCommitResult> {
  const deduped = new Map<string, ManagerCommandProposal>();
  for (const proposal of args.proposals) {
    deduped.set(dedupeProposalKey(proposal), proposal);
  }

  const committed: ManagerCommittedCommand[] = [];
  const rejected: ManagerProposalRejection[] = [];

  for (const proposal of deduped.values()) {
    const result = proposal.commandType === "create_issue"
      ? await commitCreateIssueProposal(args, proposal)
      : proposal.commandType === "create_issue_batch"
        ? await commitCreateIssueBatchProposal(args, proposal)
        : proposal.commandType === "update_issue_status"
          ? await commitUpdateIssueStatusProposal(args, proposal)
          : proposal.commandType === "assign_issue"
            ? await commitAssignIssueProposal(args, proposal)
            : proposal.commandType === "add_comment"
              ? await commitAddCommentProposal(args, proposal)
              : proposal.commandType === "add_relation"
                ? await commitAddRelationProposal(args, proposal)
                : proposal.commandType === "resolve_followup"
                  ? await commitResolveFollowupProposal(args, proposal)
                  : await commitReviewFollowupProposal(args, proposal);

    if ("reason" in result) {
      rejected.push(result);
    } else {
      committed.push(result);
    }
  }

  return {
    committed,
    rejected,
    replySummaries: committed.map((entry) => entry.summary),
  };
}
