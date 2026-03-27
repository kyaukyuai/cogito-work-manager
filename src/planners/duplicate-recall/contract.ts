import { z } from "zod";
import type { LinearDuplicateCandidate } from "../../lib/linear-duplicate-candidates.js";

const duplicateRecallAssessmentStatusSchema = z.enum(["exact", "fuzzy", "no_match"]);
const duplicateRecallRecommendedActionSchema = z.enum(["link_existing", "clarify", "create_new"]);

export const duplicateRecallCandidateSchema = z.object({
  identifier: z.string().trim().min(1),
  title: z.string().trim().min(1),
  url: z.string().trim().min(1).nullable().optional(),
  state: z.string().trim().min(1).nullable().optional(),
  stateType: z.string().trim().min(1).nullable().optional(),
  updatedAt: z.string().trim().min(1).nullable().optional(),
  normalizedTitle: z.string().trim().min(1),
  matchedQueries: z.array(z.string().trim().min(1)).default([]),
  matchedTokenCount: z.number().int().min(0),
});

export const duplicateRecallReplySchema = z.object({
  assessmentStatus: duplicateRecallAssessmentStatusSchema,
  recommendedAction: duplicateRecallRecommendedActionSchema,
  selectedIssueId: z.string().trim().min(1).optional(),
  reasonSummary: z.string().trim().min(1),
  missingSlots: z.array(z.string().trim().min(1)).max(6).default([]),
  extraQueries: z.array(z.string().trim().min(1).max(60)).max(4).default([]),
}).superRefine((value, ctx) => {
  if (value.assessmentStatus === "exact" && value.recommendedAction !== "link_existing") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "exact assessment must use link_existing",
      path: ["recommendedAction"],
    });
  }
  if (value.assessmentStatus === "fuzzy" && value.recommendedAction !== "clarify") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "fuzzy assessment must use clarify",
      path: ["recommendedAction"],
    });
  }
  if (value.assessmentStatus === "no_match" && value.recommendedAction !== "create_new") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "no_match assessment must use create_new",
      path: ["recommendedAction"],
    });
  }
  if (value.recommendedAction === "link_existing" && !value.selectedIssueId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "selectedIssueId is required when recommendedAction=link_existing",
      path: ["selectedIssueId"],
    });
  }
  if (value.recommendedAction !== "link_existing" && value.selectedIssueId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "selectedIssueId is allowed only when recommendedAction=link_existing",
      path: ["selectedIssueId"],
    });
  }
});

export interface DuplicateRecallInput {
  requestText: string;
  initialCandidates: LinearDuplicateCandidate[];
  workspaceAgents?: string;
  workspaceMemory?: string;
  taskKey?: string;
}

export interface DuplicateRecallResult {
  assessmentStatus: "exact" | "fuzzy" | "no_match";
  recommendedAction: "link_existing" | "clarify" | "create_new";
  selectedIssueId?: string;
  reasonSummary: string;
  missingSlots: string[];
  extraQueries: string[];
}

export type DuplicateRecallCandidate = LinearDuplicateCandidate;

