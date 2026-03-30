import { buildWorkgraphThreadKey } from "../../state/workgraph/events.js";
import { findExistingThreadIntakeByFingerprint } from "../../state/workgraph/queries.js";
import { dedupeProposalKey, unique } from "./common.js";
import {
  managerCommandProposalSchema,
  type CommitManagerCommandArgs,
  type ManagerCommandHandlerResult,
  type ManagerCommandProposal,
  type ManagerCommitResult,
  type PostSlackMessageProposal,
  type ReplaceWorkspaceTextFileProposal,
  type UpdateOwnerMapProposal,
} from "./contracts.js";
import {
  commitCreateIssueBatchProposal,
  commitCreateIssueProposal,
  commitLinkExistingIssueProposal,
  commitAddCommentProposal,
  commitAddRelationProposal,
  commitAssignIssueProposal,
  commitSetIssueParentProposal,
  commitUpdateIssueStatusProposal,
  fingerprintText,
} from "./commands/linear.js";
import {
  commitCreateNotionAgendaProposal,
  commitUpdateNotionPageProposal,
  commitArchiveNotionPageProposal,
} from "./commands/notion.js";
import {
  buildOwnerMapPreviewReply,
  buildOwnerMapPreviewSummaryLine,
  commitReplaceWorkspaceTextFileProposal,
  commitUpdateOwnerMapProposal,
  commitUpdateWorkspaceMemoryProposal,
  getWorkspaceConfigTarget,
  validateUpdateOwnerMapProposal,
} from "./commands/workspace.js";
import {
  commitCreateSchedulerJobProposal,
  commitDeleteSchedulerJobProposal,
  commitRunSchedulerJobNowProposal,
  commitUpdateBuiltinScheduleProposal,
  commitUpdateSchedulerJobProposal,
} from "./commands/scheduler.js";
import {
  commitResolveFollowupProposal,
  commitReviewFollowupProposal,
} from "./commands/followups.js";
import { commitPostSlackMessageProposal } from "./commands/slack.js";

type CommandType = ManagerCommandProposal["commandType"];
type CommandHandlerMap = {
  [K in CommandType]: (
    args: CommitManagerCommandArgs,
    proposal: Extract<ManagerCommandProposal, { commandType: K }>,
  ) => Promise<ManagerCommandHandlerResult>;
};

const commandHandlers = {
  create_issue: commitCreateIssueProposal,
  create_issue_batch: commitCreateIssueBatchProposal,
  link_existing_issue: commitLinkExistingIssueProposal,
  update_issue_status: commitUpdateIssueStatusProposal,
  assign_issue: commitAssignIssueProposal,
  add_comment: commitAddCommentProposal,
  add_relation: commitAddRelationProposal,
  set_issue_parent: commitSetIssueParentProposal,
  create_notion_agenda: commitCreateNotionAgendaProposal,
  update_notion_page: commitUpdateNotionPageProposal,
  archive_notion_page: commitArchiveNotionPageProposal,
  update_workspace_memory: commitUpdateWorkspaceMemoryProposal,
  replace_workspace_text_file: commitReplaceWorkspaceTextFileProposal,
  update_owner_map: commitUpdateOwnerMapProposal,
  resolve_followup: commitResolveFollowupProposal,
  review_followup: commitReviewFollowupProposal,
  create_scheduler_job: commitCreateSchedulerJobProposal,
  update_scheduler_job: commitUpdateSchedulerJobProposal,
  delete_scheduler_job: commitDeleteSchedulerJobProposal,
  update_builtin_schedule: commitUpdateBuiltinScheduleProposal,
  run_scheduler_job_now: commitRunSchedulerJobNowProposal,
  post_slack_message: commitPostSlackMessageProposal,
} satisfies CommandHandlerMap;

function isPostSlackMessageProposal(proposal: ManagerCommandProposal): proposal is PostSlackMessageProposal {
  return proposal.commandType === "post_slack_message";
}

function isReplaceWorkspaceTextFileProposal(
  proposal: ManagerCommandProposal,
): proposal is ReplaceWorkspaceTextFileProposal {
  return proposal.commandType === "replace_workspace_text_file";
}

function isUpdateOwnerMapProposal(proposal: ManagerCommandProposal): proposal is UpdateOwnerMapProposal {
  return proposal.commandType === "update_owner_map";
}

function buildMissingDecisionFieldsReason(proposal: ManagerCommandProposal): string | undefined {
  const parsedProposal = managerCommandProposalSchema.safeParse(proposal);
  if (parsedProposal.success) {
    return undefined;
  }
  const missingDecisionFields = parsedProposal.error.issues
    .map((issue) => issue.path.join("."))
    .filter(Boolean)
    .join(", ");
  return missingDecisionFields
    ? `判断に必要な項目が不足しているため確定できませんでした。不足項目: ${missingDecisionFields}`
    : "判断に必要な項目が不足しているため確定できませんでした。";
}

async function dispatchValidatedProposal(
  args: CommitManagerCommandArgs,
  proposal: ManagerCommandProposal,
): Promise<ManagerCommandHandlerResult> {
  const handler = commandHandlers[proposal.commandType] as (
    handlerArgs: CommitManagerCommandArgs,
    handlerProposal: typeof proposal,
  ) => Promise<ManagerCommandHandlerResult>;
  return handler(args, proposal);
}

function formatProposalExecutionFailure(proposal: ManagerCommandProposal, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const targetIssueId = "issueId" in proposal ? proposal.issueId : undefined;
  switch (proposal.commandType) {
    case "update_issue_status":
      return `${targetIssueId ?? "issue"} の状態更新を完了できませんでした: ${message}`;
    case "add_comment":
      return `${targetIssueId ?? "issue"} へのコメント追加を完了できませんでした: ${message}`;
    default:
      return `${proposal.commandType} の実行を完了できませんでした: ${message}`;
  }
}

export async function commitManagerCommandProposals(args: CommitManagerCommandArgs): Promise<ManagerCommitResult> {
  const deduped = new Map<string, ManagerCommandProposal>();
  for (const proposal of args.proposals) {
    deduped.set(dedupeProposalKey(proposal), proposal);
  }
  const dedupedProposals = Array.from(deduped.values());

  const needsIntakeDedupeCheck = dedupedProposals.some((proposal) => (
    proposal.commandType === "create_issue"
    || proposal.commandType === "create_issue_batch"
    || proposal.commandType === "link_existing_issue"
  ));
  const commitArgs = needsIntakeDedupeCheck && !args.existingThreadIntakeAtTurnStart
    ? {
        ...args,
        existingThreadIntakeAtTurnStart: await findExistingThreadIntakeByFingerprint(
          args.repositories.workgraph,
          buildWorkgraphThreadKey(args.message.channelId, args.message.rootThreadTs),
          fingerprintText(args.message.text),
        ) ?? null,
      }
    : args;

  const committed: ManagerCommitResult["committed"] = [];
  const rejected: ManagerCommitResult["rejected"] = [];
  const rejectedKeys = new Set<string>();

  const postSlackMessageProposals = dedupedProposals.filter(isPostSlackMessageProposal);
  if (postSlackMessageProposals.length > 0 && dedupedProposals.length !== 1) {
    for (const proposal of dedupedProposals) {
      rejected.push({
        proposal,
        reason: "Slack のメンション付き投稿は 1 turn で 1 件ずつに分けてください。",
      });
      rejectedKeys.add(dedupeProposalKey(proposal));
    }
  }

  const workspaceConfigProposals = dedupedProposals.filter((proposal) => getWorkspaceConfigTarget(proposal) !== undefined);
  const workspaceConfigTargets = unique(workspaceConfigProposals.map((proposal) => getWorkspaceConfigTarget(proposal)));
  if (workspaceConfigTargets.length > 1) {
    for (const proposal of workspaceConfigProposals) {
      rejected.push({
        proposal,
        reason: "workspace config の変更は 1 turn で 1 target ずつに分けてください。",
      });
      rejectedKeys.add(dedupeProposalKey(proposal));
    }
  }

  const replaceWorkspaceTextFileProposals = workspaceConfigProposals.filter(isReplaceWorkspaceTextFileProposal);
  if (replaceWorkspaceTextFileProposals.length > 1) {
    for (const proposal of replaceWorkspaceTextFileProposals) {
      if (rejectedKeys.has(dedupeProposalKey(proposal))) continue;
      rejected.push({
        proposal,
        reason: "AGENDA_TEMPLATE.md と HEARTBEAT.md の更新は 1 turn で 1 proposal のみにしてください。",
      });
      rejectedKeys.add(dedupeProposalKey(proposal));
    }
  }

  const ownerMapProposals = dedupedProposals.filter(isUpdateOwnerMapProposal);
  if (ownerMapProposals.length > 0 && dedupedProposals.some((proposal) => proposal.commandType !== "update_owner_map")) {
    for (const proposal of ownerMapProposals) {
      if (rejectedKeys.has(dedupeProposalKey(proposal))) continue;
      rejected.push({
        proposal,
        reason: "owner-map の変更は専用 turn に分けてください。",
      });
      rejectedKeys.add(dedupeProposalKey(proposal));
    }
  }

  const remainingProposals = dedupedProposals.filter((proposal) => !rejectedKeys.has(dedupeProposalKey(proposal)));
  const pendingOwnerMapProposals = remainingProposals.filter(isUpdateOwnerMapProposal);
  const validPendingOwnerMapProposals: UpdateOwnerMapProposal[] = [];
  for (const proposal of pendingOwnerMapProposals) {
    const validationError = validateUpdateOwnerMapProposal(proposal);
    if (validationError) {
      rejected.push({
        proposal,
        reason: validationError,
      });
      rejectedKeys.add(dedupeProposalKey(proposal));
    } else {
      validPendingOwnerMapProposals.push(proposal);
    }
  }

  const executableProposals = remainingProposals.filter((proposal) => !rejectedKeys.has(dedupeProposalKey(proposal)));
  if (validPendingOwnerMapProposals.length > 0 && (args.ownerMapConfirmationMode ?? "preview") !== "confirm") {
    return {
      committed,
      rejected,
      replySummaries: committed.map((entry) => entry.summary),
      pendingConfirmation: {
        kind: "owner-map",
        proposals: validPendingOwnerMapProposals,
        previewSummaryLines: validPendingOwnerMapProposals.map(buildOwnerMapPreviewSummaryLine),
        previewReply: buildOwnerMapPreviewReply(validPendingOwnerMapProposals),
      },
    };
  }

  for (const proposal of executableProposals) {
    const validationError = buildMissingDecisionFieldsReason(proposal);
    if (validationError) {
      rejected.push({
        proposal,
        reason: validationError,
      });
      continue;
    }

    try {
      const result = await dispatchValidatedProposal(commitArgs, proposal);
      if ("reason" in result) {
        rejected.push(result);
      } else {
        committed.push(result);
      }
    } catch (error) {
      rejected.push({
        proposal,
        reason: formatProposalExecutionFailure(proposal, error),
      });
    }
  }

  return {
    committed,
    rejected,
    replySummaries: committed.map((entry) => entry.summary),
  };
}
