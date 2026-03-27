import {
  findLinearDuplicateCandidateQueryResults,
  getDuplicateCandidateCoreTokens,
  isExactLexicalDuplicateCandidateMatch,
  mergeDuplicateCandidateQueryResults,
  type FindLinearDuplicateCandidatesInput,
  type LinearDuplicateCandidate,
} from "./linear-duplicate-candidates.js";
import type { LinearCommandEnv } from "./linear.js";
import type { DuplicateRecallInput, DuplicateRecallResult } from "../planners/duplicate-recall/index.js";

export interface ResolveLinearDuplicateCandidatesInput extends FindLinearDuplicateCandidatesInput {
  taskKey?: string;
}

export interface ResolvedDuplicateCandidateAssessment {
  assessmentStatus: "exact" | "fuzzy" | "no_match" | "unavailable";
  recommendedAction: "link_existing" | "clarify" | "create_new";
  selectedIssueId?: string;
  reasonSummary: string;
  missingSlots: string[];
}

export interface ResolvedLinearDuplicateCandidates {
  initialCandidates: LinearDuplicateCandidate[];
  extraQueries: string[];
  finalCandidates: LinearDuplicateCandidate[];
  assessment: ResolvedDuplicateCandidateAssessment;
}

export type DuplicateRecallPlannerExecutor = (input: DuplicateRecallInput) => Promise<DuplicateRecallResult>;

export interface LinearDuplicateResolutionSummary {
  assessmentStatus: ResolvedDuplicateCandidateAssessment["assessmentStatus"];
  recommendedAction: ResolvedDuplicateCandidateAssessment["recommendedAction"];
  selectedIssueId?: string;
  reasonSummary: string;
  extraQueries: string[];
  finalCandidateIds: string[];
}

const DEFAULT_DUPLICATE_LIMIT = 5;

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isResolvedAssessmentStatus(
  value: unknown,
): value is ResolvedDuplicateCandidateAssessment["assessmentStatus"] {
  return value === "exact" || value === "fuzzy" || value === "no_match" || value === "unavailable";
}

function isResolvedRecommendedAction(
  value: unknown,
): value is ResolvedDuplicateCandidateAssessment["recommendedAction"] {
  return value === "link_existing" || value === "clarify" || value === "create_new";
}

function sanitizeExtraQueries(queries: string[]): string[] {
  return unique(
    queries
      .map((query) => query.replace(/\s+/g, " ").trim())
      .filter(Boolean),
  ).slice(0, 4);
}

function buildSessionTaskKey(base: string | undefined, suffix: string): string {
  const normalizedBase = (base ?? "duplicate-recall").replace(/\s+/g, " ").trim();
  return `${normalizedBase}-${suffix}`;
}

export function summarizeResolvedLinearDuplicateCandidates(
  value: unknown,
): LinearDuplicateResolutionSummary | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as {
    extraQueries?: unknown;
    finalCandidates?: unknown;
    assessment?: unknown;
  };
  const assessment = record.assessment as {
    assessmentStatus?: unknown;
    recommendedAction?: unknown;
    selectedIssueId?: unknown;
    reasonSummary?: unknown;
  } | undefined;

  if (!assessment) {
    return undefined;
  }
  if (!isResolvedAssessmentStatus(assessment.assessmentStatus) || !isResolvedRecommendedAction(assessment.recommendedAction)) {
    return undefined;
  }
  if (typeof assessment.reasonSummary !== "string" || !assessment.reasonSummary.trim()) {
    return undefined;
  }

  const finalCandidateIds = Array.isArray(record.finalCandidates)
    ? unique(record.finalCandidates
      .map((candidate) => (candidate && typeof candidate === "object" ? (candidate as { identifier?: unknown }).identifier : undefined))
      .filter((identifier): identifier is string => typeof identifier === "string")
      .map((identifier) => identifier.trim())
      .filter(Boolean))
    : [];

  return {
    assessmentStatus: assessment.assessmentStatus,
    recommendedAction: assessment.recommendedAction,
    selectedIssueId: typeof assessment.selectedIssueId === "string" && assessment.selectedIssueId.trim()
      ? assessment.selectedIssueId.trim()
      : undefined,
    reasonSummary: assessment.reasonSummary.trim(),
    extraQueries: unique(asStringArray(record.extraQueries)),
    finalCandidateIds,
  };
}

function buildLexicalOnlyAssessment(requestText: string, candidates: LinearDuplicateCandidate[]): ResolvedDuplicateCandidateAssessment {
  if (candidates.length === 0) {
    return {
      assessmentStatus: "no_match",
      recommendedAction: "create_new",
      reasonSummary: "duplicate 候補が見つからないため、新規作成寄りです。",
      missingSlots: [],
    };
  }

  const requestTokens = getDuplicateCandidateCoreTokens(requestText);
  const topCandidate = candidates[0];
  const topCandidateTokens = getDuplicateCandidateCoreTokens(topCandidate.title);
  const missingSlots = topCandidateTokens.filter((token) => !requestTokens.includes(token)).slice(0, 4);
  return {
    assessmentStatus: "fuzzy",
    recommendedAction: "clarify",
    reasonSummary: "近い duplicate 候補はありますが、安全に既存 issue を再利用できるとは断定できません。",
    missingSlots,
  };
}

function buildPlannerUnavailableAssessment(
  requestText: string,
  candidates: LinearDuplicateCandidate[],
): ResolvedDuplicateCandidateAssessment {
  const lexicalOnly = buildLexicalOnlyAssessment(requestText, candidates);
  return {
    ...lexicalOnly,
    assessmentStatus: "unavailable",
    reasonSummary: "LLM 補助 duplicate recall を利用できなかったため、lexical 候補だけを返します。",
  };
}

function normalizePlannerAssessment(
  assessment: DuplicateRecallResult,
  candidates: LinearDuplicateCandidate[],
): ResolvedDuplicateCandidateAssessment {
  const candidateIds = new Set(candidates.map((candidate) => candidate.identifier));
  if (assessment.recommendedAction === "link_existing") {
    if (assessment.selectedIssueId && candidateIds.has(assessment.selectedIssueId)) {
      return {
        assessmentStatus: "exact",
        recommendedAction: "link_existing",
        selectedIssueId: assessment.selectedIssueId,
        reasonSummary: assessment.reasonSummary,
        missingSlots: assessment.missingSlots,
      };
    }
    return {
      assessmentStatus: "unavailable",
      recommendedAction: candidates.length > 0 ? "clarify" : "create_new",
      reasonSummary: "LLM が選んだ既存 issue を candidate set で確認できなかったため、そのままは再利用しません。",
      missingSlots: assessment.missingSlots,
    };
  }

  return {
    assessmentStatus: assessment.assessmentStatus,
    recommendedAction: assessment.recommendedAction,
    reasonSummary: assessment.reasonSummary,
    missingSlots: assessment.missingSlots,
  };
}

export async function resolveLinearDuplicateCandidates(
  input: ResolveLinearDuplicateCandidatesInput,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
  deps?: { runDuplicateRecallTurn?: DuplicateRecallPlannerExecutor },
): Promise<ResolvedLinearDuplicateCandidates> {
  const limit = input.limit ?? DEFAULT_DUPLICATE_LIMIT;
  const initialQueryResults = await findLinearDuplicateCandidateQueryResults(input, env, signal);
  const initialCandidates = mergeDuplicateCandidateQueryResults({
    requestText: input.text,
    queryResults: initialQueryResults,
    limit,
  });

  if (initialCandidates.length === 1 && isExactLexicalDuplicateCandidateMatch(input.text, initialCandidates[0])) {
    return {
      initialCandidates,
      extraQueries: [],
      finalCandidates: initialCandidates,
      assessment: {
        assessmentStatus: "exact",
        recommendedAction: "link_existing",
        selectedIssueId: initialCandidates[0].identifier,
        reasonSummary: "deterministic duplicate recall で安全な既存 issue が 1 件に絞れました。",
        missingSlots: [],
      },
    };
  }

  const planner = deps?.runDuplicateRecallTurn;
  if (!planner) {
    return {
      initialCandidates,
      extraQueries: [],
      finalCandidates: initialCandidates,
      assessment: buildLexicalOnlyAssessment(input.text, initialCandidates),
    };
  }

  try {
    const firstAssessment = await planner({
      requestText: input.text,
      initialCandidates,
      taskKey: buildSessionTaskKey(input.taskKey, "first"),
    });
    const extraQueries = sanitizeExtraQueries(firstAssessment.extraQueries);

    if (extraQueries.length === 0) {
      return {
        initialCandidates,
        extraQueries,
        finalCandidates: initialCandidates,
        assessment: normalizePlannerAssessment(firstAssessment, initialCandidates),
      };
    }

    const extraQueryResults = await findLinearDuplicateCandidateQueryResults({
      text: input.text,
      limit,
      queriesOverride: extraQueries,
    }, env, signal);
    const finalCandidates = mergeDuplicateCandidateQueryResults({
      requestText: input.text,
      queryResults: [...initialQueryResults, ...extraQueryResults],
      limit,
    });
    const finalAssessment = await planner({
      requestText: input.text,
      initialCandidates: finalCandidates,
      taskKey: buildSessionTaskKey(input.taskKey, "final"),
    });
    return {
      initialCandidates,
      extraQueries,
      finalCandidates,
      assessment: normalizePlannerAssessment(finalAssessment, finalCandidates),
    };
  } catch {
    return {
      initialCandidates,
      extraQueries: [],
      finalCandidates: initialCandidates,
      assessment: buildPlannerUnavailableAssessment(input.text, initialCandidates),
    };
  }
}
