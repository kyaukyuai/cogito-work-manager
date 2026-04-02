import { Type } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { LinearCommandEnv } from "../../gateways/linear/command-runner.js";
import { getLinearProject, listLinearProjects } from "../../gateways/linear/projects.js";
import type { LinearProject } from "../../gateways/linear/types.js";
import { formatJsonDetails } from "./linear-read-tool-shared.js";

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

export function createLinearProjectReadTools(env: LinearCommandEnv): ToolDefinition[] {
  return [
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
  ];
}
