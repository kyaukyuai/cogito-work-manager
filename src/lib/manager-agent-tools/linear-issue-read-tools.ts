import { Type } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
  getLinearIssue,
  listOpenLinearIssues,
  searchLinearIssues,
  type LinearCommandEnv,
  type LinearIssue,
} from "../linear.js";
import { formatJsonDetails } from "./linear-read-tool-shared.js";

function businessDaysSince(leftIso: string | null | undefined, right = new Date()): number | undefined {
  if (!leftIso) return undefined;
  const start = new Date(leftIso);
  if (Number.isNaN(start.getTime())) return undefined;
  const current = new Date(start);
  current.setHours(0, 0, 0, 0);
  const end = new Date(right);
  end.setHours(0, 0, 0, 0);
  if (current >= end) return 0;

  let days = 0;
  while (current < end) {
    current.setDate(current.getDate() + 1);
    const day = current.getDay();
    if (day !== 0 && day !== 6) {
      days += 1;
    }
  }
  return days;
}

function toJstDayKey(date: Date): string {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function parseDayKey(value: string | null | undefined): Date | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split("-").map((part) => Number(part));
  if (!year || !month || !day) return undefined;
  return new Date(Date.UTC(year, month - 1, day));
}

function dueRelativeInfo(
  dueDate: string | null | undefined,
  right = new Date(),
): { daysUntilDue?: number; dueRelativeLabel?: string } {
  const due = parseDayKey(dueDate);
  const today = parseDayKey(toJstDayKey(right));
  if (!due || !today) {
    return {};
  }
  const diffDays = Math.round((due.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
  if (diffDays < 0) {
    return {
      daysUntilDue: diffDays,
      dueRelativeLabel: `${Math.abs(diffDays)}日超過`,
    };
  }
  if (diffDays === 0) {
    return {
      daysUntilDue: 0,
      dueRelativeLabel: "今日",
    };
  }
  if (diffDays === 1) {
    return {
      daysUntilDue: 1,
      dueRelativeLabel: "明日",
    };
  }
  return {
    daysUntilDue: diffDays,
    dueRelativeLabel: `${diffDays}日後`,
  };
}

function overdueDays(dueDate: string | null | undefined, right = new Date()): number | undefined {
  if (!dueDate) return undefined;
  const due = new Date(`${dueDate}T00:00:00Z`);
  if (Number.isNaN(due.getTime())) return undefined;
  const today = new Date(Date.UTC(right.getUTCFullYear(), right.getUTCMonth(), right.getUTCDate()));
  const diffMs = today.getTime() - due.getTime();
  if (diffMs <= 0) return 0;
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

function isOpenLinearState(state: LinearIssue["state"] | null | undefined): boolean {
  const type = state?.type?.toLowerCase();
  const name = state?.name?.toLowerCase();
  return type !== "done" && type !== "completed" && type !== "canceled"
    && name !== "done" && name !== "completed" && name !== "canceled";
}

function buildIssueFacts(issue: LinearIssue): Record<string, unknown> {
  const blockedState = issue.state?.name?.toLowerCase() === "blocked";
  const blockedByDependency = (issue.inverseRelations ?? []).some((relation) => relation.type === "blocked-by");
  const recentBlockedUpdate = issue.latestActionKind === "blocked";
  const relativeDue = dueRelativeInfo(issue.dueDate);
  return {
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url ?? undefined,
    description: issue.description ?? undefined,
    state: issue.state ?? undefined,
    stateName: issue.state?.name ?? undefined,
    stateType: issue.state?.type ?? undefined,
    completedAt: issue.completedAt ?? undefined,
    isOpen: isOpenLinearState(issue.state),
    dueDate: issue.dueDate ?? undefined,
    priority: issue.priority ?? undefined,
    priorityLabel: issue.priorityLabel ?? undefined,
    cycle: issue.cycle ?? undefined,
    updatedAt: issue.updatedAt ?? undefined,
    assignee: issue.assignee ?? undefined,
    project: issue.project ?? undefined,
    parent: issue.parent ?? undefined,
    children: issue.children ?? [],
    relations: issue.relations ?? [],
    inverseRelations: issue.inverseRelations ?? [],
    latestActionKind: issue.latestActionKind ?? undefined,
    latestActionAt: issue.latestActionAt ?? undefined,
    overdueDays: overdueDays(issue.dueDate),
    daysUntilDue: relativeDue.daysUntilDue,
    dueRelativeLabel: relativeDue.dueRelativeLabel,
    staleBusinessDays: businessDaysSince(issue.updatedAt),
    commentCount: issue.comments?.length ?? 0,
    comments: issue.comments?.slice(0, 10).map((comment) => ({
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt ?? undefined,
      user: comment.user ?? undefined,
    })) ?? [],
    ownerMissing: !issue.assignee,
    dueMissing: !issue.dueDate,
    blockedSignals: {
      blockedState,
      blockedByDependency,
      recentBlockedUpdate,
    },
  };
}

async function buildReviewIssueFacts(
  issue: LinearIssue,
  env: LinearCommandEnv,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const base = buildIssueFacts(issue);
  const childIds = (issue.children ?? []).map((child) => child.identifier).filter(Boolean);
  if (childIds.length === 0) {
    return {
      ...base,
      openChildren: [],
      closedChildren: [],
    };
  }

  const children = (await Promise.all(
    childIds.map(async (issueId) => {
      try {
        const child = await getLinearIssue(issueId, env, signal);
        return buildIssueFacts(child);
      } catch {
        return {
          identifier: issueId,
          title: (issue.children ?? []).find((child) => child.identifier === issueId)?.title,
        };
      }
    }),
  ));

  return {
    ...base,
    children,
    openChildren: children.filter((child) => child.isOpen !== false),
    closedChildren: children.filter((child) => child.isOpen === false),
  };
}

function formatIssue(issue: { identifier: string; title: string; url?: string | null }): string {
  return issue.url ? `${issue.identifier} ${issue.title}\n${issue.url}` : `${issue.identifier} ${issue.title}`;
}

export function createLinearIssueReadTools(env: LinearCommandEnv): ToolDefinition[] {
  return [
    {
      name: "linear_list_active_issue_facts",
      label: "Linear List Active Issue Facts",
      description: "List active Linear issues as raw facts for query, prioritization, and next-step reasoning.",
      promptSnippet: "Use this for task lists and broad active-work queries. The returned facts include exact project membership when assigned, so group by issue.project instead of inferring from project summary counts.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Maximum number of issues to fetch." })),
      }),
      async execute(_toolCallId, params, signal) {
        const issues = await listOpenLinearIssues(env, signal);
        const limited = issues.slice(0, (params as { limit?: number }).limit ?? 20).map((issue) => buildIssueFacts(issue));
        return {
          content: [{ type: "text", text: limited.length > 0 ? formatJsonDetails(limited) : "No active issue facts found." }],
          details: limited,
        };
      },
    },
    {
      name: "linear_list_review_facts",
      label: "Linear List Review Facts",
      description: "List active Linear issues with raw review-oriented facts such as overdueDays, staleBusinessDays, blockedSignals, ownerMissing, and dueMissing.",
      promptSnippet: "Use this for review, heartbeat, and next-step suggestions. Select the important issues yourself from the facts and treat openChildren as current work while keeping closedChildren only for improvement notes.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Maximum number of issues to fetch." })),
      }),
      async execute(_toolCallId, params, signal) {
        const issues = await listOpenLinearIssues(env, signal);
        const limit = (params as { limit?: number } | undefined)?.limit ?? 50;
        const facts = await Promise.all(
          issues.slice(0, limit).map((issue) => buildReviewIssueFacts(issue, env, signal)),
        );
        return {
          content: [{ type: "text", text: facts.length > 0 ? formatJsonDetails(facts) : "No review facts found." }],
          details: facts,
        };
      },
    },
    {
      name: "linear_get_issue_facts",
      label: "Linear Get Issue Facts",
      description: "Load one Linear issue and return raw facts including hierarchy, relations, comments, and review signals.",
      promptSnippet: "Use this for inspect-work and next-step reasoning. Decide the next step yourself from the returned facts.",
      parameters: Type.Object({
        issueId: Type.String({ description: "Issue identifier like AIC-123." }),
      }),
      async execute(_toolCallId, params, signal) {
        const issue = await getLinearIssue((params as { issueId: string }).issueId, env, signal, { includeComments: true });
        const facts = buildIssueFacts(issue);
        return {
          content: [{ type: "text", text: formatJsonDetails(facts) }],
          details: facts,
        };
      },
    },
    {
      name: "linear_search_issues",
      label: "Linear Search Issues",
      description: "Search existing issues to inspect duplicates or related work.",
      promptSnippet: "Use this before proposing new tracked work or when searching existing issues.",
      parameters: Type.Object({
        query: Type.String({ description: "Search text." }),
        limit: Type.Optional(Type.Number({ description: "Maximum number of results." })),
        states: Type.Optional(Type.Array(Type.String({ description: "Optional state filters." }))),
      }),
      async execute(_toolCallId, params, signal) {
        const issues = await searchLinearIssues(params as { query: string; limit?: number; states?: string[] }, env, signal);
        return {
          content: [{ type: "text", text: issues.length > 0 ? issues.map(formatIssue).join("\n\n") : "No matching issues found." }],
          details: issues,
        };
      },
    },
  ];
}
