import type {
  ManagerCommittedCommand,
  ManagerIntentReport,
} from "../../lib/manager-command-commit.js";
import {
  clearThreadQueryContinuation,
  saveThreadQueryContinuation,
  type ThreadQueryContinuation,
  type ThreadQueryKind,
  type ThreadQueryReferenceItem,
  type ThreadQueryScope,
} from "../../lib/query-continuation.js";
import {
  clearThreadNotionPageTarget,
  extractSingleNotionPageTargetFromReferenceItems,
  loadThreadNotionPageTarget,
  saveThreadNotionPageTarget,
} from "../../lib/thread-notion-page-target.js";
import type { ThreadPaths } from "../../lib/thread-workspace.js";
import {
  buildProjectGroupedTaskReply,
  isProjectGroupedTaskListQuery,
  normalizeProjectGroupedTaskIssueFacts,
} from "./project-grouped-task-list.js";

export interface ThreadQueryContinuationSnapshotInput {
  issueIds?: string[];
  shownIssueIds?: string[];
  remainingIssueIds?: string[];
  totalItemCount?: number;
  replySummary?: string;
  scope?: ThreadQueryScope;
  referenceItems?: ThreadQueryReferenceItem[];
}

export interface CompleteThreadQueryContinuationSnapshotInput {
  issueIds: string[];
  shownIssueIds: string[];
  remainingIssueIds: string[];
  totalItemCount: number;
  replySummary: string;
  scope: ThreadQueryScope;
  referenceItems?: ThreadQueryReferenceItem[];
}

interface ManagerToolCallLike {
  toolName: string;
  details?: unknown;
  isError?: boolean;
}

function extractActiveIssueFactsResult(toolCalls: ManagerToolCallLike[]): unknown {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const toolCall = toolCalls[index];
    if (toolCall?.toolName !== "linear_list_active_issue_facts" || toolCall.isError) {
      continue;
    }
    return toolCall.details;
  }
  return undefined;
}

export function buildProjectGroupedTaskListReplyOverride(args: {
  intent?: ManagerIntentReport["intent"];
  queryKind?: ManagerIntentReport["queryKind"];
  messageText: string;
  lastQueryContext?: ThreadQueryContinuation;
  toolCalls: ManagerToolCallLike[];
}): {
  reply: string;
  snapshot?: CompleteThreadQueryContinuationSnapshotInput;
} | undefined {
  if (args.intent !== "query" || args.queryKind !== "list-active") {
    return undefined;
  }
  if (!isProjectGroupedTaskListQuery({
    messageText: args.messageText,
    lastQueryContext: args.lastQueryContext,
  })) {
    return undefined;
  }

  const normalizedIssues = normalizeProjectGroupedTaskIssueFacts(
    extractActiveIssueFactsResult(args.toolCalls),
  );
  if (!normalizedIssues) {
    return {
      reply: "プロジェクトごとの一覧を正確に組み立てられませんでした。もう一度お試しください。",
    };
  }

  const rendered = buildProjectGroupedTaskReply({
    messageText: args.messageText,
    issues: normalizedIssues,
    lastQueryContext: args.lastQueryContext,
  });
  return {
    reply: rendered.reply,
    snapshot: {
      issueIds: rendered.issueIds,
      shownIssueIds: rendered.shownIssueIds,
      remainingIssueIds: rendered.remainingIssueIds,
      totalItemCount: rendered.totalItemCount,
      replySummary: rendered.replySummary,
      scope: args.lastQueryContext && !isProjectGroupedTaskListQuery({
        messageText: args.messageText,
        lastQueryContext: undefined,
      })
        ? "thread-context"
        : "team",
    },
  };
}

function normalizeQuerySnapshotIssueIds(values: unknown): string[] {
  return Array.isArray(values)
    ? Array.from(new Set(values.filter((value): value is string => typeof value === "string")))
    : [];
}

function normalizeQuerySnapshotReferenceItems(values: unknown): ThreadQueryReferenceItem[] | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }

  const normalized = values.flatMap((entry): ThreadQueryReferenceItem[] => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.trim().length === 0) {
      return [];
    }

    return [{
      id: record.id.trim(),
      title: typeof record.title === "string" && record.title.trim()
        ? record.title.trim()
        : undefined,
      url: typeof record.url === "string"
        ? record.url
        : record.url === null
          ? null
          : undefined,
      source: typeof record.source === "string" && record.source.trim()
        ? record.source.trim()
        : undefined,
    }];
  });

  if (normalized.length === 0) {
    return [];
  }

  const deduped = new Map<string, ThreadQueryReferenceItem>();
  for (const item of normalized) {
    deduped.set(item.id, item);
  }
  return Array.from(deduped.values());
}

export function extractQuerySnapshot(
  toolCalls: Array<{ toolName: string; details?: unknown }>,
): ThreadQueryContinuationSnapshotInput | undefined {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const toolCall = toolCalls[index];
    if (toolCall?.toolName !== "report_query_snapshot") {
      continue;
    }
    const details = toolCall.details as { querySnapshot?: Record<string, unknown> } | undefined;
    const snapshot = details?.querySnapshot;
    if (!snapshot) {
      continue;
    }
    const issueIds = normalizeQuerySnapshotIssueIds(snapshot.issueIds);
    const shownIssueIds = normalizeQuerySnapshotIssueIds(snapshot.shownIssueIds);
    const remainingIssueIds = normalizeQuerySnapshotIssueIds(snapshot.remainingIssueIds);
    const totalItemCount = typeof snapshot.totalItemCount === "number" && Number.isFinite(snapshot.totalItemCount) && snapshot.totalItemCount >= 0
      ? Math.trunc(snapshot.totalItemCount)
      : undefined;
    const replySummary = typeof snapshot.replySummary === "string" && snapshot.replySummary.trim()
      ? snapshot.replySummary.trim()
      : undefined;
    const scope = snapshot.scope === "self" || snapshot.scope === "team" || snapshot.scope === "thread-context"
      ? snapshot.scope
      : undefined;
    const referenceItems = normalizeQuerySnapshotReferenceItems(snapshot.referenceItems);
    return {
      issueIds,
      shownIssueIds,
      remainingIssueIds,
      totalItemCount,
      replySummary,
      scope,
      referenceItems,
    };
  }
  return undefined;
}

export function hasCompleteQuerySnapshot(
  snapshot: ThreadQueryContinuationSnapshotInput | undefined,
): snapshot is CompleteThreadQueryContinuationSnapshotInput {
  return Array.isArray(snapshot?.issueIds)
    && Array.isArray(snapshot?.shownIssueIds)
    && Array.isArray(snapshot?.remainingIssueIds)
    && typeof snapshot?.totalItemCount === "number"
    && Number.isFinite(snapshot.totalItemCount)
    && typeof snapshot?.replySummary === "string"
    && snapshot.replySummary.trim().length > 0
    && (snapshot?.scope === "self" || snapshot?.scope === "team" || snapshot?.scope === "thread-context");
}

function buildThreadQueryContinuation(args: {
  queryKind?: ThreadQueryKind;
  messageText: string;
  recordedAt: Date;
  snapshot: CompleteThreadQueryContinuationSnapshotInput;
}): ThreadQueryContinuation | undefined {
  if (!args.queryKind) {
    return undefined;
  }

  const userMessage = args.messageText.trim();
  return {
    kind: args.queryKind,
    scope: args.snapshot.scope,
    userMessage,
    replySummary: args.snapshot.replySummary,
    issueIds: args.snapshot.issueIds,
    shownIssueIds: args.snapshot.shownIssueIds,
    remainingIssueIds: args.snapshot.remainingIssueIds,
    totalItemCount: args.snapshot.totalItemCount,
    referenceItems: args.snapshot.referenceItems,
    recordedAt: args.recordedAt.toISOString(),
  };
}

export async function persistQueryContinuationForAction(args: {
  paths: ThreadPaths;
  action: "query" | "conversation" | "mutation";
  queryKind?: ThreadQueryKind;
  messageText: string;
  now: Date;
  snapshot?: ThreadQueryContinuationSnapshotInput;
}): Promise<void> {
  if (args.action === "query" && hasCompleteQuerySnapshot(args.snapshot)) {
    const continuation = buildThreadQueryContinuation({
      queryKind: args.queryKind,
      messageText: args.messageText,
      recordedAt: args.now,
      snapshot: args.snapshot,
    });
    if (continuation) {
      await saveThreadQueryContinuation(args.paths, continuation);
    }
    return;
  }

  if (args.action === "mutation") {
    await clearThreadQueryContinuation(args.paths);
  }
}

export async function persistThreadNotionPageTargetForQuery(args: {
  paths: ThreadPaths;
  snapshot?: CompleteThreadQueryContinuationSnapshotInput;
  now: Date;
}): Promise<void> {
  const target = extractSingleNotionPageTargetFromReferenceItems(
    args.snapshot?.referenceItems,
    args.now.toISOString(),
  );
  if (target) {
    await saveThreadNotionPageTarget(args.paths, target);
  }
}

export async function applyCommittedThreadNotionPageTarget(args: {
  paths: ThreadPaths;
  committed: ManagerCommittedCommand[];
  now: Date;
}): Promise<void> {
  let currentTarget = await loadThreadNotionPageTarget(args.paths).catch(() => undefined);

  for (const entry of args.committed) {
    const effect = entry.notionPageTargetEffect;
    if (!effect) {
      continue;
    }

    if (effect.action === "clear") {
      if (currentTarget?.pageId === effect.pageId) {
        currentTarget = undefined;
      }
      continue;
    }

    currentTarget = {
      pageId: effect.pageId,
      title: effect.title,
      url: effect.url,
      recordedAt: args.now.toISOString(),
    };
  }

  if (currentTarget) {
    await saveThreadNotionPageTarget(args.paths, currentTarget);
  } else {
    await clearThreadNotionPageTarget(args.paths);
  }
}
