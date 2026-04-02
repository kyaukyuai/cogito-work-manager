import { Type } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AppConfig } from "../config.js";
import {
  findLinearDuplicateCandidates,
  type LinearDuplicateCandidate,
} from "../linear-duplicate-candidates.js";
import {
  resolveLinearDuplicateCandidates,
  type DuplicateRecallPlannerExecutor,
  type ResolvedLinearDuplicateCandidates,
} from "../linear-duplicate-resolution.js";
import {
  getLinearIssue,
  getLinearProject,
  listLinearProjects,
  listOpenLinearIssues,
  listLinearTeamMembers,
  searchLinearIssues,
  type LinearIssue,
  type LinearCommandEnv,
  type LinearProject,
} from "../linear.js";

export interface ManagerAgentToolHelpers {
  runDuplicateRecallTurn?: DuplicateRecallPlannerExecutor;
}

function buildLinearEnv(config: AppConfig): LinearCommandEnv {
  return {
    ...process.env,
    LINEAR_API_KEY: config.linearApiKey,
    LINEAR_WORKSPACE: config.linearWorkspace,
    LINEAR_TEAM_KEY: config.linearTeamKey,
  };
}

function formatJsonDetails(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function formatIssue(issue: { identifier: string; title: string; url?: string | null }): string {
  return issue.url ? `${issue.identifier} ${issue.title}\n${issue.url}` : `${issue.identifier} ${issue.title}`;
}

function formatDuplicateCandidate(candidate: LinearDuplicateCandidate): string {
  return [
    formatIssue(candidate),
    `matchedQueries: ${candidate.matchedQueries.join(" | ")}`,
    `matchedTokenCount: ${candidate.matchedTokenCount}`,
    candidate.state ? `state: ${candidate.state}` : undefined,
    candidate.updatedAt ? `updatedAt: ${candidate.updatedAt}` : undefined,
  ].filter(Boolean).join("\n");
}

function formatResolvedDuplicateAssessment(details: ResolvedLinearDuplicateCandidates): string {
  const summaryLines = [
    "Duplicate resolution:",
    `- assessmentStatus: ${details.assessment.assessmentStatus}`,
    `- recommendedAction: ${details.assessment.recommendedAction}`,
    details.assessment.selectedIssueId ? `- selectedIssueId: ${details.assessment.selectedIssueId}` : undefined,
    `- reasonSummary: ${details.assessment.reasonSummary}`,
    details.extraQueries.length > 0 ? `- extraQueries: ${details.extraQueries.join(" | ")}` : undefined,
    details.assessment.missingSlots.length > 0 ? `- missingSlots: ${details.assessment.missingSlots.join(" | ")}` : undefined,
  ].filter(Boolean);
  const candidateLines = details.finalCandidates.length > 0
    ? [
        "Final candidates:",
        ...details.finalCandidates.map((candidate) => `- ${formatDuplicateCandidate(candidate).replace(/\n/g, "\n  ")}`),
      ]
    : ["Final candidates:", "- (none)"];
  return [...summaryLines, ...candidateLines].join("\n");
}

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

function buildProjectFacts(project: LinearProject): Record<string, unknown> {
  return {
    id: project.id,
    slugId: project.slugId ?? undefined,
    name: project.name,
    url: project.url ?? undefined,
    description: project.description ?? undefined,
    status: project.status ?? undefined,
    statusName: project.status?.name ?? undefined,
    statusType: project.status?.type ?? undefined,
    lead: project.lead ?? undefined,
    creator: project.creator ?? undefined,
    teams: project.teams ?? [],
    priority: project.priority ?? undefined,
    health: project.health ?? undefined,
    startDate: project.startDate ?? undefined,
    targetDate: project.targetDate ?? undefined,
    startedAt: project.startedAt ?? undefined,
    completedAt: project.completedAt ?? undefined,
    canceledAt: project.canceledAt ?? undefined,
    createdAt: project.createdAt ?? undefined,
    updatedAt: project.updatedAt ?? undefined,
    issueSummary: project.issueSummary ?? undefined,
    lastUpdate: project.lastUpdate ?? undefined,
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

export function createLinearReadTools(
  config: AppConfig,
  helpers?: ManagerAgentToolHelpers,
): ToolDefinition[] {
  const env = buildLinearEnv(config);

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
      async execute(_toolCallId, _params, signal) {
        const issues = await listOpenLinearIssues(env, signal);
        const limit = (_params as { limit?: number } | undefined)?.limit ?? 50;
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
        return {
          content: [{ type: "text", text: formatJsonDetails(buildIssueFacts(issue)) }],
          details: buildIssueFacts(issue),
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
    {
      name: "linear_list_project_facts",
      label: "Linear List Project Facts",
      description: "List Linear projects as raw facts for project queries and update planning.",
      promptSnippet: "Use this when the user asks to list, inspect, or find Linear projects before creating or updating one.",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "Optional project name or text filter." })),
        status: Type.Optional(Type.String({ description: "Optional project status filter." })),
        team: Type.Optional(Type.String({ description: "Optional team key filter." })),
        allTeams: Type.Optional(Type.Boolean({ description: "When true, search projects across all teams." })),
        limit: Type.Optional(Type.Number({ description: "Maximum number of projects to return." })),
      }),
      async execute(_toolCallId, params, signal) {
        const projects = await listLinearProjects(params as {
          query?: string;
          status?: string;
          team?: string;
          allTeams?: boolean;
          limit?: number;
        }, env, signal);
        const facts = projects.map((project) => buildProjectFacts(project));
        return {
          content: [{ type: "text", text: facts.length > 0 ? formatJsonDetails(facts) : "No matching project facts found." }],
          details: facts,
        };
      },
    },
    {
      name: "linear_get_project_facts",
      label: "Linear Get Project Facts",
      description: "Load one Linear project and return raw facts including status, teams, dates, lead, and issue summary.",
      promptSnippet: "Use this before proposing a project update or when the user asks for one specific Linear project.",
      parameters: Type.Object({
        projectIdOrSlug: Type.String({ description: "Project id or slug." }),
      }),
      async execute(_toolCallId, params, signal) {
        const project = await getLinearProject((params as { projectIdOrSlug: string }).projectIdOrSlug, env, signal);
        const facts = buildProjectFacts(project);
        return {
          content: [{ type: "text", text: formatJsonDetails(facts) }],
          details: facts,
        };
      },
    },
    {
      name: "linear_find_duplicate_candidates",
      label: "Linear Find Duplicate Candidates",
      description: "Search likely duplicate active issues for one requested work item using deterministic query variants.",
      promptSnippet: "Use this before create_work when deciding whether one requested item should create new work, reuse an existing issue, or ask for clarification.",
      parameters: Type.Object({
        text: Type.String({ description: "One requested work item title or short description." }),
        limit: Type.Optional(Type.Number({ description: "Maximum number of candidates to return." })),
      }),
      async execute(_toolCallId, params, signal) {
        const candidates = await findLinearDuplicateCandidates(
          params as { text: string; limit?: number },
          env,
          signal,
        );
        return {
          content: [{
            type: "text",
            text: candidates.length > 0
              ? ["Duplicate candidates:", ...candidates.map((candidate) => `- ${formatDuplicateCandidate(candidate).replace(/\n/g, "\n  ")}`)].join("\n")
              : "No duplicate candidates found.",
          }],
          details: candidates,
        };
      },
    },
    {
      name: "linear_resolve_duplicate_candidates",
      label: "Linear Resolve Duplicate Candidates",
      description: "Resolve one requested work item into exact duplicate reuse, fuzzy clarification, or create-new using lexical recall first and optional LLM duplicate assessment second.",
      promptSnippet: "Use this first for create_work duplicate checks. It returns lexical candidates plus a structured recommendation to link, clarify, or create new.",
      parameters: Type.Object({
        text: Type.String({ description: "One requested work item title or short description." }),
        limit: Type.Optional(Type.Number({ description: "Maximum number of candidates to return." })),
      }),
      async execute(toolCallId, params, signal) {
        const resolved = await resolveLinearDuplicateCandidates(
          {
            ...(params as { text: string; limit?: number }),
            taskKey: `duplicate-recall-${toolCallId}`,
          },
          env,
          signal,
          { runDuplicateRecallTurn: helpers?.runDuplicateRecallTurn },
        );
        return {
          content: [{ type: "text", text: formatResolvedDuplicateAssessment(resolved) }],
          details: resolved,
        };
      },
    },
    {
      name: "linear_list_team_members",
      label: "Linear List Team Members",
      description: "List active team members to reason about assignees.",
      promptSnippet: "Use this when proposing assignment or checking who owns a task.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, signal) {
        const members = await listLinearTeamMembers(env, signal);
        return {
          content: [{ type: "text", text: members.length > 0 ? formatJsonDetails(members) : "No active team members found." }],
          details: members,
        };
      },
    },
  ];
}
