import { Type } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
  findLinearDuplicateCandidates,
  type LinearDuplicateCandidate,
} from "../linear-duplicate-candidates.js";
import {
  resolveLinearDuplicateCandidates,
  type ResolvedLinearDuplicateCandidates,
} from "../linear-duplicate-resolution.js";
import type { LinearCommandEnv } from "../linear.js";
import type { ManagerAgentToolHelpers } from "./linear-read-tool-shared.js";

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

export function createLinearDuplicateReadTools(
  env: LinearCommandEnv,
  helpers?: ManagerAgentToolHelpers,
): ToolDefinition[] {
  return [
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
  ];
}
