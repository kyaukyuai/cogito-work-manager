import type { ThreadQueryContinuation } from "../../lib/query-continuation.js";

const PROJECT_GROUPED_QUERY_REPLY_SUMMARY_PREFIX = "[project-grouped-exact]";
const PROJECT_GROUPED_FULL_REPLY_LIMIT = 12;
const PROJECT_GROUPED_PER_PROJECT_LIMIT = 3;
const PROJECT_GROUPED_EXPLICIT_PATTERN = /(?:project|プロジェクト)\s*(?:ごと|別)/i;
const PROJECT_GROUPED_TASK_LIST_PATTERN = /(?:タスク|issue|イシュー|ticket|チケット|一覧)/i;
const PROJECT_GROUPED_CONTINUATION_PATTERN = /(?:他には|ほかには|他のタスク|ほかのタスク|残り|続き|さらに)/;

export interface ProjectGroupedTaskIssueFact {
  identifier: string;
  title: string;
  project?: {
    id?: string;
    name?: string;
    slugId?: string;
  };
  stateName?: string;
  dueRelativeLabel?: string;
  priorityLabel?: string;
}

export interface ProjectGroupedTaskReplyRenderResult {
  reply: string;
  issueIds: string[];
  shownIssueIds: string[];
  remainingIssueIds: string[];
  totalItemCount: number;
  replySummary: string;
}

interface ProjectGroupedTaskGroup {
  projectName?: string;
  displayName: string;
  issues: ProjectGroupedTaskIssueFact[];
}

function normalizeMessageText(text: string): string {
  return text
    .trim()
    .replace(/^<@[^>]+>\s*/, "")
    .replace(/\s+/g, " ");
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function isProjectGroupedQueryContinuationContext(lastQueryContext?: ThreadQueryContinuation): boolean {
  return lastQueryContext?.kind === "list-active"
    && typeof lastQueryContext.replySummary === "string"
    && lastQueryContext.replySummary.startsWith(PROJECT_GROUPED_QUERY_REPLY_SUMMARY_PREFIX);
}

export function isExplicitProjectGroupedTaskListQuery(messageText: string): boolean {
  const normalized = normalizeMessageText(messageText);
  return PROJECT_GROUPED_EXPLICIT_PATTERN.test(normalized)
    && PROJECT_GROUPED_TASK_LIST_PATTERN.test(normalized);
}

export function isProjectGroupedTaskListQuery(args: {
  messageText: string;
  lastQueryContext?: ThreadQueryContinuation;
}): boolean {
  if (isExplicitProjectGroupedTaskListQuery(args.messageText)) {
    return true;
  }
  return isProjectGroupedQueryContinuationContext(args.lastQueryContext)
    && PROJECT_GROUPED_CONTINUATION_PATTERN.test(normalizeMessageText(args.messageText));
}

export function normalizeProjectGroupedTaskIssueFacts(
  value: unknown,
): ProjectGroupedTaskIssueFact[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value.flatMap((entry): ProjectGroupedTaskIssueFact[] => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const record = entry as Record<string, unknown>;
    if (typeof record.identifier !== "string" || record.identifier.trim().length === 0) {
      return [];
    }
    if (typeof record.title !== "string" || record.title.trim().length === 0) {
      return [];
    }

    const projectRecord = record.project && typeof record.project === "object"
      ? record.project as Record<string, unknown>
      : undefined;
    const projectName = typeof projectRecord?.name === "string" && projectRecord.name.trim().length > 0
      ? projectRecord.name.trim()
      : undefined;

    return [{
      identifier: record.identifier.trim(),
      title: record.title.trim(),
      project: projectRecord
        ? {
            id: typeof projectRecord.id === "string" && projectRecord.id.trim().length > 0
              ? projectRecord.id.trim()
              : undefined,
            name: projectName,
            slugId: typeof projectRecord.slugId === "string" && projectRecord.slugId.trim().length > 0
              ? projectRecord.slugId.trim()
              : undefined,
          }
        : undefined,
      stateName: typeof record.stateName === "string" && record.stateName.trim().length > 0
        ? record.stateName.trim()
        : undefined,
      dueRelativeLabel: typeof record.dueRelativeLabel === "string" && record.dueRelativeLabel.trim().length > 0
        ? record.dueRelativeLabel.trim()
        : undefined,
      priorityLabel: typeof record.priorityLabel === "string" && record.priorityLabel.trim().length > 0
        ? record.priorityLabel.trim()
        : undefined,
    }];
  });

  return normalized.length > 0 ? normalized : [];
}

function buildProjectGroupedTaskDisplayName(projectName?: string): string {
  return projectName?.trim() ? projectName.trim() : "プロジェクト未設定";
}

function compareProjectGroupOrder(left: ProjectGroupedTaskGroup, right: ProjectGroupedTaskGroup): number {
  const leftNamed = Boolean(left.projectName);
  const rightNamed = Boolean(right.projectName);
  if (leftNamed && !rightNamed) return -1;
  if (!leftNamed && rightNamed) return 1;
  if (!leftNamed && !rightNamed) return 0;
  return left.displayName.localeCompare(right.displayName, "ja");
}

function groupIssuesByProject(
  issues: ProjectGroupedTaskIssueFact[],
): ProjectGroupedTaskGroup[] {
  const groups = new Map<string, ProjectGroupedTaskGroup>();

  for (const issue of issues) {
    const projectName = issue.project?.name?.trim() || "";
    const key = projectName || "(none)";
    const existing = groups.get(key);
    if (existing) {
      existing.issues.push(issue);
      continue;
    }
    groups.set(key, {
      projectName: projectName || undefined,
      displayName: buildProjectGroupedTaskDisplayName(projectName || undefined),
      issues: [issue],
    });
  }

  return Array.from(groups.values()).sort(compareProjectGroupOrder);
}

function formatProjectGroupedIssueLine(issue: ProjectGroupedTaskIssueFact): string {
  const labels: string[] = [];
  if (issue.stateName && !/^(?:backlog|todo)$/i.test(issue.stateName)) {
    labels.push(issue.stateName);
  }
  if (issue.dueRelativeLabel) {
    labels.push(issue.dueRelativeLabel);
  } else if (issue.priorityLabel && issue.priorityLabel !== "No priority") {
    labels.push(issue.priorityLabel);
  }

  const summary = `${issue.identifier} ${issue.title}`;
  return labels.length > 0 ? `${summary}（${labels.join("・")}）` : summary;
}

export function buildProjectGroupedTaskReply(args: {
  messageText: string;
  issues: ProjectGroupedTaskIssueFact[];
  lastQueryContext?: ThreadQueryContinuation;
}): ProjectGroupedTaskReplyRenderResult {
  const continuation = isProjectGroupedQueryContinuationContext(args.lastQueryContext)
    && PROJECT_GROUPED_CONTINUATION_PATTERN.test(normalizeMessageText(args.messageText));
  const previousShownIssueIds = continuation ? args.lastQueryContext?.shownIssueIds ?? [] : [];
  const continuationRemainingIds = continuation ? args.lastQueryContext?.remainingIssueIds ?? [] : [];
  const relevantIssues = continuation
    ? args.issues.filter((issue) => continuationRemainingIds.includes(issue.identifier))
    : args.issues;
  const totalItemCount = continuation
    ? args.lastQueryContext?.totalItemCount ?? relevantIssues.length
    : relevantIssues.length;

  if (relevantIssues.length === 0) {
    return {
      reply: continuation
        ? "他に表示できる task はありません。"
        : "いま active な task は見当たりません。",
      issueIds: [],
      shownIssueIds: continuation ? previousShownIssueIds : [],
      remainingIssueIds: [],
      totalItemCount,
      replySummary: `${PROJECT_GROUPED_QUERY_REPLY_SUMMARY_PREFIX} no remaining project-grouped issues`,
    };
  }

  const compactMode = relevantIssues.length > PROJECT_GROUPED_FULL_REPLY_LIMIT;
  const groups = groupIssuesByProject(relevantIssues);
  const shownIssueIds: string[] = [];
  const lines: string[] = ["プロジェクトごとにまとめます。", ""];

  groups.forEach((group, groupIndex) => {
    lines.push(`${group.displayName}（${group.issues.length}件）`);
    const visibleIssues = compactMode ? group.issues.slice(0, PROJECT_GROUPED_PER_PROJECT_LIMIT) : group.issues;
    const hiddenCount = group.issues.length - visibleIssues.length;

    for (const issue of visibleIssues) {
      shownIssueIds.push(issue.identifier);
      lines.push(`- ${formatProjectGroupedIssueLine(issue)}`);
    }

    if (hiddenCount > 0) {
      lines.push(`- 他${hiddenCount}件`);
    }

    if (groupIndex < groups.length - 1) {
      lines.push("");
    }
  });

  const accumulatedShownIssueIds = continuation
    ? unique([...previousShownIssueIds, ...shownIssueIds])
    : shownIssueIds;
  const normalizedRemainingIssueIds = unique(
    relevantIssues
      .map((issue) => issue.identifier)
      .filter((issueId) => !shownIssueIds.includes(issueId)),
  );
  const currentIssueIds = shownIssueIds;

  return {
    reply: lines.join("\n"),
    issueIds: relevantIssues.map((issue) => issue.identifier),
    shownIssueIds: accumulatedShownIssueIds,
    remainingIssueIds: normalizedRemainingIssueIds,
    totalItemCount,
    replySummary: continuation
      ? `${PROJECT_GROUPED_QUERY_REPLY_SUMMARY_PREFIX} continued exact project-grouped task list`
      : `${PROJECT_GROUPED_QUERY_REPLY_SUMMARY_PREFIX} exact project-grouped task list`,
  };
}
