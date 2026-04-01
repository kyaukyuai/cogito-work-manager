import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThreadPaths } from "./thread-workspace.js";
import type {
  ManagerCommandProposal,
  ManagerCommittedCommand,
  ManagerIntentReport,
  ManagerProposalRejection,
  PendingClarificationDecisionReport,
  TaskExecutionDecisionReport,
} from "./manager-command-commit.js";
import type { LinearDuplicateResolutionSummary } from "./linear-duplicate-resolution.js";

export type LastManagerReplyPath = "agent" | "reply-planner" | "fallback";
export type LastManagerConversationKind = "greeting" | "smalltalk" | "other";

export interface LastManagerDuplicateResolution extends LinearDuplicateResolutionSummary {}

export interface LastManagerProposalSummary {
  commandType: ManagerCommandProposal["commandType"];
  targetSummary?: string;
  detailSummary?: string;
  reasonSummary?: string;
}

export interface LastManagerCommittedCommandSummary {
  commandType: ManagerCommittedCommand["commandType"];
  issueIds: string[];
  summary: string;
  publicReply?: string;
  postCommitWarnings?: string[];
  postCommitStatus?: ManagerCommittedCommand["postCommitStatus"];
}

export interface LastManagerRejectedProposalSummary extends LastManagerProposalSummary {
  reason: string;
}

export interface LastManagerAgentTurn {
  recordedAt: string;
  replyPath?: LastManagerReplyPath;
  intent?: ManagerIntentReport["intent"];
  conversationKind?: LastManagerConversationKind;
  queryKind?: ManagerIntentReport["queryKind"];
  queryScope?: ManagerIntentReport["queryScope"];
  confidence?: number;
  summary?: string;
  currentDateTimeJst?: string;
  pendingClarificationDecision?: PendingClarificationDecisionReport["decision"];
  pendingClarificationPersistence?: PendingClarificationDecisionReport["persistence"];
  pendingClarificationDecisionSummary?: string;
  taskExecutionDecision?: TaskExecutionDecisionReport["decision"];
  taskExecutionTargetIssueId?: string;
  taskExecutionTargetIssueIdentifier?: string;
  taskExecutionSummary?: string;
  toolCalls?: string[];
  proposalCount?: number;
  invalidProposalCount?: number;
  proposals?: LastManagerProposalSummary[];
  committedCommands?: LastManagerCommittedCommandSummary[];
  commitWarnings?: string[];
  postCommitStatus?: ManagerCommittedCommand["postCommitStatus"];
  rejectedProposals?: LastManagerRejectedProposalSummary[];
  duplicateResolutions?: LastManagerDuplicateResolution[];
  partialFollowupUnmatchedTopics?: string[];
  missingQuerySnapshot?: boolean;
  technicalFailure?: string;
}

function buildLastManagerAgentTurnPath(paths: ThreadPaths): string {
  return join(paths.scratchDir, "last-manager-agent-turn.json");
}

function isManagerCommandType(value: unknown): value is ManagerCommandProposal["commandType"] {
  return value === "create_issue"
    || value === "create_issue_batch"
    || value === "create_project"
    || value === "update_project"
    || value === "link_existing_issue"
    || value === "update_issue_status"
    || value === "update_issue_priority"
    || value === "assign_issue"
    || value === "add_comment"
    || value === "add_relation"
    || value === "set_issue_parent"
    || value === "create_notion_agenda"
    || value === "update_notion_page"
    || value === "archive_notion_page"
    || value === "update_workspace_memory"
    || value === "replace_workspace_text_file"
    || value === "update_owner_map"
    || value === "resolve_followup"
    || value === "review_followup"
    || value === "create_scheduler_job"
    || value === "update_scheduler_job"
    || value === "delete_scheduler_job"
    || value === "update_builtin_schedule"
    || value === "run_scheduler_job_now"
    || value === "post_slack_message";
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

function truncateSingleLine(value: string, maxLength = 140): string {
  const singleLine = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLength - 1).trimEnd()}…`;
}

function buildProposalTargetSummary(proposal: ManagerCommandProposal): string | undefined {
  switch (proposal.commandType) {
    case "create_issue":
      return proposal.issue.title;
    case "create_issue_batch":
      return proposal.parent.title;
    case "create_project":
      return proposal.name;
    case "update_project":
      return proposal.projectId;
    case "link_existing_issue":
    case "update_issue_status":
    case "update_issue_priority":
    case "assign_issue":
    case "add_comment":
    case "set_issue_parent":
      return proposal.issueId;
    case "add_relation":
      return `${proposal.issueId} -> ${proposal.relatedIssueId}`;
    default:
      return undefined;
  }
}

function buildProposalDetailSummary(proposal: ManagerCommandProposal): string | undefined {
  switch (proposal.commandType) {
    case "create_issue": {
      const parts = [
        proposal.issue.assigneeMode === "assign" ? `assignee=${proposal.issue.assignee}` : "assignee=unassigned",
        proposal.issue.dueDate ? `due=${proposal.issue.dueDate}` : undefined,
        proposal.issue.parent ? `parent=${proposal.issue.parent}` : undefined,
        proposal.issue.state ? `state=${proposal.issue.state}` : undefined,
      ].filter(Boolean);
      return parts.length > 0 ? parts.join(" ") : undefined;
    }
    case "create_issue_batch":
      return `children=${proposal.children.length} planningReason=${proposal.planningReason}`;
    case "create_project": {
      const parts = [
        proposal.teamKeys?.length ? `teams=${proposal.teamKeys.join(",")}` : undefined,
        proposal.status ? `status=${proposal.status}` : undefined,
        proposal.lead ? `lead=${proposal.lead}` : undefined,
        proposal.targetDate ? `target=${proposal.targetDate}` : undefined,
      ].filter(Boolean);
      return parts.length > 0 ? parts.join(" ") : undefined;
    }
    case "update_project": {
      const parts = [
        proposal.name ? `name=${proposal.name}` : undefined,
        proposal.teamKeys?.length ? `teams=${proposal.teamKeys.join(",")}` : undefined,
        proposal.status ? `status=${proposal.status}` : undefined,
        proposal.lead ? `lead=${proposal.lead}` : undefined,
        proposal.targetDate ? `target=${proposal.targetDate}` : undefined,
      ].filter(Boolean);
      return parts.length > 0 ? parts.join(" ") : undefined;
    }
    case "update_issue_status": {
      const parts = [
        `signal=${proposal.signal}`,
        proposal.state ? `state=${proposal.state}` : undefined,
        proposal.dueDate ? `due=${proposal.dueDate}` : undefined,
        proposal.commentBody ? `comment=${truncateSingleLine(proposal.commentBody, 100)}` : undefined,
      ].filter(Boolean);
      return parts.join(" ");
    }
    case "update_issue_priority": {
      const parts = [
        `priority=${proposal.priority}`,
        proposal.commentBody ? `comment=${truncateSingleLine(proposal.commentBody, 100)}` : undefined,
      ].filter(Boolean);
      return parts.join(" ");
    }
    case "assign_issue":
      return `assignee=${proposal.assignee}`;
    case "add_comment":
      return truncateSingleLine(proposal.body, 100);
    case "add_relation":
      return `relation=${proposal.relationType}`;
    case "set_issue_parent":
      return `parent=${proposal.parentIssueId}`;
    default:
      return undefined;
  }
}

function parseProposalSummaries(value: unknown): LastManagerProposalSummary[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const proposals = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    if (!isManagerCommandType(record.commandType)) {
      return [];
    }
    return [{
      commandType: record.commandType,
      targetSummary: typeof record.targetSummary === "string" ? record.targetSummary : undefined,
      detailSummary: typeof record.detailSummary === "string" ? record.detailSummary : undefined,
      reasonSummary: typeof record.reasonSummary === "string" ? record.reasonSummary : undefined,
    } satisfies LastManagerProposalSummary];
  });
  return proposals.length > 0 ? proposals : undefined;
}

function parseCommittedCommandSummaries(value: unknown): LastManagerCommittedCommandSummary[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const committed = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    if (!isManagerCommandType(record.commandType) || typeof record.summary !== "string") {
      return [];
    }
    return [{
      commandType: record.commandType,
      issueIds: parseStringArray(record.issueIds) ?? [],
      summary: record.summary,
      publicReply: typeof record.publicReply === "string" ? record.publicReply : undefined,
      postCommitWarnings: parseStringArray(record.postCommitWarnings),
      postCommitStatus: record.postCommitStatus === "complete" || record.postCommitStatus === "partial-local-failure"
        ? record.postCommitStatus
        : undefined,
    } satisfies LastManagerCommittedCommandSummary];
  });
  return committed.length > 0 ? committed : undefined;
}

function parseRejectedProposalSummaries(value: unknown): LastManagerRejectedProposalSummary[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const rejected = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    if (!isManagerCommandType(record.commandType) || typeof record.reason !== "string") {
      return [];
    }
    return [{
      commandType: record.commandType,
      targetSummary: typeof record.targetSummary === "string" ? record.targetSummary : undefined,
      detailSummary: typeof record.detailSummary === "string" ? record.detailSummary : undefined,
      reasonSummary: typeof record.reasonSummary === "string" ? record.reasonSummary : undefined,
      reason: record.reason,
    } satisfies LastManagerRejectedProposalSummary];
  });
  return rejected.length > 0 ? rejected : undefined;
}

function parseLastManagerDuplicateResolutions(value: unknown): LastManagerDuplicateResolution[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const duplicateResolutions = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const assessmentStatus = record.assessmentStatus;
    const recommendedAction = record.recommendedAction;
    const reasonSummary = record.reasonSummary;
    if (
      (assessmentStatus !== "exact" && assessmentStatus !== "fuzzy" && assessmentStatus !== "no_match" && assessmentStatus !== "unavailable")
      || (recommendedAction !== "link_existing" && recommendedAction !== "clarify" && recommendedAction !== "create_new")
      || typeof reasonSummary !== "string"
      || !reasonSummary.trim()
    ) {
      return [];
    }

    return [{
      assessmentStatus,
      recommendedAction,
      selectedIssueId: typeof record.selectedIssueId === "string" && record.selectedIssueId.trim()
        ? record.selectedIssueId.trim()
        : undefined,
      reasonSummary: reasonSummary.trim(),
      extraQueries: Array.isArray(record.extraQueries)
        ? record.extraQueries
          .filter((query): query is string => typeof query === "string")
          .map((query) => query.trim())
          .filter(Boolean)
        : [],
      finalCandidateIds: Array.isArray(record.finalCandidateIds)
        ? record.finalCandidateIds
          .filter((identifier): identifier is string => typeof identifier === "string")
          .map((identifier) => identifier.trim())
          .filter(Boolean)
        : [],
    } satisfies LastManagerDuplicateResolution];
  });

  return duplicateResolutions.length > 0 ? duplicateResolutions : undefined;
}

export async function loadLastManagerAgentTurn(
  paths: ThreadPaths,
): Promise<LastManagerAgentTurn | undefined> {
  try {
    const raw = await readFile(buildLastManagerAgentTurnPath(paths), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.recordedAt !== "string") {
      return undefined;
    }
    return {
      recordedAt: parsed.recordedAt,
      replyPath: parsed.replyPath === "agent" || parsed.replyPath === "reply-planner" || parsed.replyPath === "fallback"
        ? parsed.replyPath
        : undefined,
      intent: typeof parsed.intent === "string" ? parsed.intent as ManagerIntentReport["intent"] : undefined,
      conversationKind:
        parsed.conversationKind === "greeting" || parsed.conversationKind === "smalltalk" || parsed.conversationKind === "other"
          ? parsed.conversationKind
          : undefined,
      queryKind: typeof parsed.queryKind === "string" ? parsed.queryKind as ManagerIntentReport["queryKind"] : undefined,
      queryScope: typeof parsed.queryScope === "string" ? parsed.queryScope as ManagerIntentReport["queryScope"] : undefined,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : undefined,
      summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
      currentDateTimeJst: typeof parsed.currentDateTimeJst === "string" ? parsed.currentDateTimeJst : undefined,
      pendingClarificationDecision: typeof parsed.pendingClarificationDecision === "string"
        ? parsed.pendingClarificationDecision as PendingClarificationDecisionReport["decision"]
        : undefined,
      pendingClarificationPersistence: typeof parsed.pendingClarificationPersistence === "string"
        ? parsed.pendingClarificationPersistence as PendingClarificationDecisionReport["persistence"]
        : undefined,
      pendingClarificationDecisionSummary: typeof parsed.pendingClarificationDecisionSummary === "string"
        ? parsed.pendingClarificationDecisionSummary
        : undefined,
      taskExecutionDecision: typeof parsed.taskExecutionDecision === "string"
        ? parsed.taskExecutionDecision as TaskExecutionDecisionReport["decision"]
        : undefined,
      taskExecutionTargetIssueId: typeof parsed.taskExecutionTargetIssueId === "string"
        ? parsed.taskExecutionTargetIssueId
        : undefined,
      taskExecutionTargetIssueIdentifier: typeof parsed.taskExecutionTargetIssueIdentifier === "string"
        ? parsed.taskExecutionTargetIssueIdentifier
        : undefined,
      taskExecutionSummary: typeof parsed.taskExecutionSummary === "string"
        ? parsed.taskExecutionSummary
        : undefined,
      toolCalls: parseStringArray(parsed.toolCalls),
      proposalCount: typeof parsed.proposalCount === "number" ? parsed.proposalCount : undefined,
      invalidProposalCount: typeof parsed.invalidProposalCount === "number" ? parsed.invalidProposalCount : undefined,
      proposals: parseProposalSummaries(parsed.proposals),
      committedCommands: parseCommittedCommandSummaries(parsed.committedCommands),
      commitWarnings: parseStringArray(parsed.commitWarnings),
      postCommitStatus: parsed.postCommitStatus === "complete" || parsed.postCommitStatus === "partial-local-failure"
        ? parsed.postCommitStatus
        : undefined,
      rejectedProposals: parseRejectedProposalSummaries(parsed.rejectedProposals),
      duplicateResolutions: parseLastManagerDuplicateResolutions(parsed.duplicateResolutions),
      partialFollowupUnmatchedTopics: parseStringArray(parsed.partialFollowupUnmatchedTopics),
      missingQuerySnapshot: parsed.missingQuerySnapshot === true,
      technicalFailure: typeof parsed.technicalFailure === "string" ? parsed.technicalFailure : undefined,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function saveLastManagerAgentTurn(
  paths: ThreadPaths,
  turn: LastManagerAgentTurn,
): Promise<void> {
  await writeFile(buildLastManagerAgentTurnPath(paths), `${JSON.stringify(turn, null, 2)}\n`, "utf8");
}

export async function clearLastManagerAgentTurn(paths: ThreadPaths): Promise<void> {
  try {
    await rm(buildLastManagerAgentTurnPath(paths), { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export function summarizeManagerProposal(proposal: ManagerCommandProposal): LastManagerProposalSummary {
  return {
    commandType: proposal.commandType,
    targetSummary: buildProposalTargetSummary(proposal),
    detailSummary: buildProposalDetailSummary(proposal),
    reasonSummary: proposal.reasonSummary,
  };
}

export function summarizeManagerCommittedCommand(command: ManagerCommittedCommand): LastManagerCommittedCommandSummary {
  return {
    commandType: command.commandType,
    issueIds: [...command.issueIds],
    summary: command.summary,
    publicReply: command.publicReply,
    postCommitWarnings: command.postCommitWarnings ? [...command.postCommitWarnings] : undefined,
    postCommitStatus: command.postCommitStatus,
  };
}

export function summarizeManagerProposalRejection(
  rejection: ManagerProposalRejection,
): LastManagerRejectedProposalSummary {
  return {
    ...summarizeManagerProposal(rejection.proposal),
    reason: rejection.reason,
  };
}
