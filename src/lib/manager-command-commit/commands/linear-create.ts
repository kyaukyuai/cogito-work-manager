import {
  addLinearComment,
  addLinearRelation,
  assignLinearIssue,
  createManagedLinearIssue,
  createManagedLinearIssueBatch,
  getLinearIssue,
  searchLinearIssues,
  updateManagedLinearIssue,
  type LinearIssue,
} from "../../linear.js";
import {
  compactLinearIssues,
  formatAutonomousCreateReply,
  formatExistingIssueReply,
  formatIssueReference,
  formatSourceComment,
} from "../../../orchestrators/intake/formatting.js";
import {
  buildPlanningChildRecord,
  recordIntakeLinkedExisting,
  recordPlanningOutcome,
} from "../../../state/workgraph/recorder.js";
import { buildWorkgraphThreadKey } from "../../../state/workgraph/events.js";
import {
  findExistingThreadIntakeByFingerprint,
  getThreadPlanningContext,
  type ExistingThreadIntakeContext,
} from "../../../state/workgraph/queries.js";
import type {
  CreateIssueBatchProposal,
  CreateIssueProposal,
  LinkExistingIssueProposal,
  ManagerCommandHandlerResult,
} from "../contracts.js";
import type { CommitManagerCommandArgs } from "../contracts.js";
import { buildOccurredAt } from "../common.js";

export function normalizeTitle(title: string | undefined): string {
  return (title ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[。！!？?]+$/g, "")
    .toLowerCase();
}

export function fingerprintText(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[。！!？?]+$/g, "")
    .toLowerCase()
    .replace(/(linear|issue|イシュー|ticket|チケット|todo|タスク|登録|追加|作成|作って|しておいて|お願い|お願いします)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface LinearBatchCreateFailureLike {
  message: string;
  createdIdentifiers?: string[];
  createdCount?: number;
  failedStep?: {
    stage?: string;
    index?: number;
    total?: number;
    title?: string;
  };
  retryHint?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLinearBatchCreateFailure(error: unknown): error is LinearBatchCreateFailureLike {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & Record<string, unknown>;
  return Array.isArray(candidate.createdIdentifiers)
    || typeof candidate.retryHint === "string"
    || isRecord(candidate.failedStep);
}

function formatLinearBatchCreateFailureReason(error: LinearBatchCreateFailureLike): string {
  const parts = ["一括起票の途中で失敗しました。"];

  if (Array.isArray(error.createdIdentifiers) && error.createdIdentifiers.length > 0) {
    parts.push(`作成済み issue: ${error.createdIdentifiers.join(", ")}。`);
  } else if (typeof error.createdCount === "number" && error.createdCount > 0) {
    parts.push(`作成済み issue: ${error.createdCount}件。`);
  }

  if (error.failedStep) {
    const location: string[] = [];
    if (error.failedStep.stage) location.push(error.failedStep.stage);
    if (typeof error.failedStep.index === "number" && typeof error.failedStep.total === "number") {
      location.push(`${error.failedStep.index}/${error.failedStep.total}`);
    }
    if (error.failedStep.title) location.push(`「${error.failedStep.title}」`);
    if (location.length > 0) {
      parts.push(`失敗箇所: ${location.join(" ")}。`);
    }
  }

  if (error.retryHint?.trim()) {
    parts.push("再試行時は作成済み issue を除いて残りだけを起票してください。");
  } else if (error.message.trim()) {
    parts.push(`${error.message.trim().replace(/[。.]$/u, "")}。`);
  }

  return parts.join(" ");
}

type SlackIssueReference = Pick<LinearIssue, "identifier" | "title"> & { url?: string | null };

function toSlackIssueReference(
  issue:
    | Pick<LinearIssue, "identifier" | "title" | "url">
    | { issueId: string; title?: string },
): SlackIssueReference {
  return {
    identifier: "identifier" in issue ? issue.identifier : issue.issueId,
    title: issue.title ?? ("identifier" in issue ? issue.identifier : issue.issueId),
    url: "url" in issue ? issue.url : undefined,
  };
}

async function loadThreadParentIssueReference(
  args: CommitManagerCommandArgs,
  threadKey: string,
): Promise<SlackIssueReference | undefined> {
  const planningContext = await getThreadPlanningContext(args.repositories.workgraph, threadKey);
  return planningContext?.parentIssue ? toSlackIssueReference(planningContext.parentIssue) : undefined;
}

function pickReusableDuplicate(
  duplicates: LinearIssue[],
  preferredParentIssueId?: string,
): LinearIssue | undefined {
  const candidates = preferredParentIssueId
    ? duplicates.filter((issue) => issue.identifier !== preferredParentIssueId)
    : duplicates;
  if (candidates.length === 0) return undefined;

  if (preferredParentIssueId) {
    const alreadyAttached = candidates.filter((issue) => issue.parent?.identifier === preferredParentIssueId);
    if (alreadyAttached.length === 1) {
      return alreadyAttached[0];
    }
    if (alreadyAttached.length > 1) {
      return undefined;
    }
  }

  return candidates.length === 1 ? candidates[0] : undefined;
}

function resolveEffectiveParentIssueId(
  proposal: CreateIssueProposal,
  threadParentIssue: SlackIssueReference | undefined,
): string | undefined {
  const explicitParentIssueId = proposal.issue.parent?.trim();
  if (explicitParentIssueId) {
    return explicitParentIssueId;
  }
  return proposal.threadParentHandling === "attach" ? threadParentIssue?.identifier : undefined;
}

function buildPlanningEntry(
  sourceThread: string,
  parentIssueId: string | undefined,
  generatedChildIssueIds: string[],
  planningReason: "single-issue" | "complex-request" | "research-first",
  ownerResolution: "mapped" | "fallback",
  nowIso: string,
) {
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

function buildManagerCommitOwnerResolution(): "mapped" {
  return "mapped";
}

function isClosedLinearIssue(issue: LinearIssue): boolean {
  const stateName = issue.state?.name?.trim().toLowerCase();
  return Boolean(issue.completedAt)
    || issue.state?.type === "completed"
    || issue.state?.type === "canceled"
    || stateName === "done"
    || stateName === "completed"
    || stateName === "canceled"
    || stateName === "cancelled";
}

function buildPlainIssueLabel(issue: Pick<LinearIssue, "identifier" | "title">): string {
  return `${issue.identifier}（${issue.title}）`;
}

async function getExistingThreadIntakeAtTurnStart(
  args: CommitManagerCommandArgs,
  threadKey: string,
  fingerprint: string,
): Promise<ExistingThreadIntakeContext | undefined> {
  if (args.existingThreadIntakeAtTurnStart !== undefined) {
    if (
      args.existingThreadIntakeAtTurnStart
      && args.existingThreadIntakeAtTurnStart.threadKey === threadKey
      && args.existingThreadIntakeAtTurnStart.messageFingerprint === fingerprint
    ) {
      return args.existingThreadIntakeAtTurnStart;
    }
    return undefined;
  }
  return findExistingThreadIntakeByFingerprint(args.repositories.workgraph, threadKey, fingerprint);
}

export async function commitCreateIssueProposal(
  args: CommitManagerCommandArgs,
  proposal: CreateIssueProposal,
): Promise<ManagerCommandHandlerResult> {
  const planningLedger = await args.repositories.planning.load();
  const occurredAt = buildOccurredAt(args.now);
  const threadKey = buildWorkgraphThreadKey(args.message.channelId, args.message.rootThreadTs);
  const fingerprint = fingerprintText(args.message.text);
  const threadParentIssue = proposal.planningReason === "single-issue"
    ? await loadThreadParentIssueReference(args, threadKey)
    : undefined;
  const effectiveParentIssueId = resolveEffectiveParentIssueId(proposal, threadParentIssue);
  if (proposal.threadParentHandling === "attach" && !effectiveParentIssueId) {
    return {
      proposal,
      reason: "親 issue に紐づける提案でしたが、この thread から親 issue を特定できませんでした。親 issue ID を明示してください。",
    };
  }
  if (proposal.duplicateHandling === "reuse-and-attach-parent" && !effectiveParentIssueId) {
    return {
      proposal,
      reason: "既存 issue を親 issue に紐づけ直す提案でしたが、親 issue を特定できませんでした。親 issue ID を明示してください。",
    };
  }
  const existingThreadIntake = await getExistingThreadIntakeAtTurnStart(args, threadKey, fingerprint);

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
    const duplicateHandling = proposal.duplicateHandling;
    if (duplicateHandling !== "create-new") {
      const reusableDuplicate = duplicateHandling === "reuse-existing"
        ? pickReusableDuplicate(duplicates)
        : pickReusableDuplicate(duplicates, effectiveParentIssueId);
      const shouldAttachToParent = duplicateHandling === "reuse-and-attach-parent";

      if (duplicateHandling === "clarify") {
        return {
          proposal,
          reason: "近い既存 issue が見つかったため、新規起票にするか既存 issue を使うか確認したいです。対象 issue ID か、`新規で作成` と返してください。",
        };
      }

      if (reusableDuplicate) {
        const attachedToParent = Boolean(
          shouldAttachToParent
          && effectiveParentIssueId
          && reusableDuplicate.identifier !== effectiveParentIssueId
          && reusableDuplicate.parent?.identifier !== effectiveParentIssueId,
        );
        let reusedIssue = attachedToParent
          ? await updateManagedLinearIssue(
              {
                issueId: reusableDuplicate.identifier,
                parent: effectiveParentIssueId,
                assignee: proposal.issue.assigneeMode === "assign" ? proposal.issue.assignee : undefined,
              },
              args.env,
            )
          : reusableDuplicate;
        if (!attachedToParent && proposal.issue.assigneeMode === "assign" && proposal.issue.assignee) {
          reusedIssue = await assignLinearIssue(reusedIssue.identifier, proposal.issue.assignee, args.env);
        }
        await recordIntakeLinkedExisting(args.repositories.workgraph, {
          occurredAt,
          source: {
            channelId: args.message.channelId,
            rootThreadTs: args.message.rootThreadTs,
            messageTs: args.message.messageTs,
          },
          messageFingerprint: fingerprint,
          linkedIssueIds: [reusedIssue.identifier],
          lastResolvedIssueId: reusedIssue.identifier,
          originalText: args.message.text,
        });
        return {
          commandType: proposal.commandType,
          issueIds: [reusedIssue.identifier],
          summary: formatExistingIssueReply(
            [reusedIssue],
            threadParentIssue && shouldAttachToParent
              ? {
                  parent: threadParentIssue,
                  attachedToParent,
                }
              : undefined,
          ),
        };
      }

      if (duplicateHandling === "reuse-existing") {
        return {
          proposal,
          reason: "既存 issue を使う提案でしたが、対象を 1 件に絞れませんでした。対象 issue ID を明記してください。",
        };
      }

      if (duplicateHandling === "reuse-and-attach-parent") {
        return {
          proposal,
          reason: "既存 issue を親 issue に紐づけ直す提案でしたが、対象を 1 件に絞れませんでした。対象 issue ID を明記してください。",
        };
      }
    }

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

  const issue = await createManagedLinearIssue(
    {
      title: proposal.issue.title,
      description: proposal.issue.description,
      state: proposal.issue.state,
      dueDate: proposal.issue.dueDate,
      project: proposal.issue.project,
      assignee: proposal.issue.assignee,
      parent: effectiveParentIssueId,
      priority: proposal.issue.priority,
    },
    args.env,
  );
  await addLinearComment(issue.identifier, formatSourceComment(args.message, proposal.planningReason), args.env);

  const nextPlanning = [
    ...planningLedger,
    buildPlanningEntry(
      threadKey,
      effectiveParentIssueId,
      [issue.identifier],
      proposal.planningReason,
      buildManagerCommitOwnerResolution(),
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
    parentIssueId: effectiveParentIssueId,
    childIssues: [buildPlanningChildRecord(issue, "execution", {
      dueDate: proposal.issue.dueDate,
      assignee: proposal.issue.assignee,
    })],
    planningReason: proposal.planningReason,
    ownerResolution: buildManagerCommitOwnerResolution(),
    lastResolvedIssueId: issue.identifier,
    originalText: args.message.text,
  });

  return {
    commandType: proposal.commandType,
    issueIds: [issue.identifier],
    summary: formatAutonomousCreateReply(
      threadParentIssue,
      [issue],
      "single-issue",
      false,
      {
        attachedToExistingParent: Boolean(threadParentIssue),
        includeFollowupThreadInstruction: false,
      },
    ),
    publicReply: `${buildPlainIssueLabel(issue)} を作成しました。`,
  };
}

export async function commitCreateIssueBatchProposal(
  args: CommitManagerCommandArgs,
  proposal: CreateIssueBatchProposal,
): Promise<ManagerCommandHandlerResult> {
  if (
    proposal.children.length === 1
    && normalizeTitle(proposal.parent.title) === normalizeTitle(proposal.children[0]?.title)
  ) {
    return commitCreateIssueProposal(args, {
      commandType: "create_issue",
      planningReason: "single-issue",
      threadParentHandling: "ignore",
      duplicateHandling: "create-new",
      issue: {
        title: proposal.children[0]!.title,
        description: proposal.children[0]!.description,
        dueDate: proposal.children[0]!.dueDate,
        project: proposal.parent.project,
        assignee: proposal.children[0]!.assignee,
        assigneeMode: proposal.children[0]!.assigneeMode,
        priority: proposal.children[0]!.priority,
        state: proposal.children[0]!.state,
      },
      reasonSummary: proposal.reasonSummary,
      evidenceSummary: proposal.evidenceSummary,
      dedupeKeyCandidate: proposal.dedupeKeyCandidate,
    });
  }
  const planningLedger = await args.repositories.planning.load();
  const occurredAt = buildOccurredAt(args.now);
  const threadKey = buildWorkgraphThreadKey(args.message.channelId, args.message.rootThreadTs);
  const fingerprint = fingerprintText(args.message.text);
  const existingThreadIntake = await getExistingThreadIntakeAtTurnStart(args, threadKey, fingerprint);

  if (existingThreadIntake) {
    return {
      proposal,
      reason: "duplicate intake already recorded for this thread",
    };
  }

  let batch;
  try {
    batch = await createManagedLinearIssueBatch(
      {
        parent: {
          title: proposal.parent.title,
          description: proposal.parent.description,
          state: proposal.parent.state,
          dueDate: proposal.parent.dueDate,
          project: proposal.parent.project,
          assignee: proposal.parent.assignee,
          parent: proposal.parent.parent,
          priority: proposal.parent.priority,
        },
        children: proposal.children.map((child) => ({
          title: child.title,
          description: child.description,
          state: child.state,
          dueDate: child.dueDate,
          project: proposal.parent.project,
          assignee: child.assignee,
          parent: child.parent,
          priority: child.priority,
        })),
      },
      args.env,
    );
  } catch (error) {
    if (isLinearBatchCreateFailure(error)) {
      return {
        proposal,
        reason: formatLinearBatchCreateFailureReason(error),
      };
    }
    throw error;
  }

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
      buildManagerCommitOwnerResolution(),
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
      assignee: proposal.parent.assignee,
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
    ownerResolution: buildManagerCommitOwnerResolution(),
    lastResolvedIssueId: children[0]?.identifier,
    originalText: args.message.text,
  });

  return {
    commandType: proposal.commandType,
    issueIds: [parent.identifier, ...children.map((issue) => issue.identifier)],
    summary: formatAutonomousCreateReply(
      parent,
      children,
      proposal.planningReason,
      false,
      {
        includeFollowupThreadInstruction: false,
      },
    ),
    publicReply: `${buildPlainIssueLabel(parent)} と子 issue ${children.length}件を作成しました。`,
  };
}

export async function commitLinkExistingIssueProposal(
  args: CommitManagerCommandArgs,
  proposal: LinkExistingIssueProposal,
): Promise<ManagerCommandHandlerResult> {
  const occurredAt = buildOccurredAt(args.now);
  const threadKey = buildWorkgraphThreadKey(args.message.channelId, args.message.rootThreadTs);
  const fingerprint = fingerprintText(args.message.text);
  const existingThreadIntake = await getExistingThreadIntakeAtTurnStart(args, threadKey, fingerprint);

  if (existingThreadIntake) {
    return {
      proposal,
      reason: "duplicate intake already recorded for this thread",
    };
  }

  const issue = await getLinearIssue(proposal.issueId, args.env);
  if (isClosedLinearIssue(issue)) {
    return {
      proposal,
      reason: `${issue.identifier} は完了済みまたは Canceled のため、既存タスクとして再利用できません。新規 issue を作成するか、別の issue ID を指定してください。`,
    };
  }

  await recordIntakeLinkedExisting(args.repositories.workgraph, {
    occurredAt,
    source: {
      channelId: args.message.channelId,
      rootThreadTs: args.message.rootThreadTs,
      messageTs: args.message.messageTs,
    },
    messageFingerprint: fingerprint,
    linkedIssueIds: [issue.identifier],
    lastResolvedIssueId: issue.identifier,
    originalText: args.message.text,
  });

  return {
    commandType: proposal.commandType,
    issueIds: [issue.identifier],
    summary: `既存 task として ${formatIssueReference(issue)} を使います。`,
    publicReply: `${buildPlainIssueLabel(issue)}は既存タスクを使います。`,
  };
}
