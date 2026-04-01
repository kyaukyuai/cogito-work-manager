import { z } from "zod";

const issueIdentifierSchema = z.string().trim().regex(/^AIC-\d+$/);

export const partialFollowupUnmatchedIssueRefSchema = z.object({
  issueId: issueIdentifierSchema,
  titleHint: z.string().trim().min(1).optional(),
  role: z.enum(["primary", "related"]).optional(),
});

export const partialFollowupUnmatchedReplySchema = z.object({
  matchedIssueIds: z.array(issueIdentifierSchema).default([]),
  unmatchedTopics: z.array(z.string().trim().min(1)).default([]),
  reasoningSummary: z.string().trim().min(1),
}).superRefine((value, ctx) => {
  const duplicateIssueIds = new Set<string>();
  const seenIssueIds = new Set<string>();
  for (const issueId of value.matchedIssueIds) {
    if (seenIssueIds.has(issueId)) {
      duplicateIssueIds.add(issueId);
    }
    seenIssueIds.add(issueId);
  }
  if (duplicateIssueIds.size > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["matchedIssueIds"],
      message: `matchedIssueIds must not contain duplicates: ${Array.from(duplicateIssueIds).join(", ")}`,
    });
  }

  const duplicateTopics = new Set<string>();
  const seenTopics = new Set<string>();
  for (const topic of value.unmatchedTopics) {
    if (seenTopics.has(topic)) {
      duplicateTopics.add(topic);
    }
    seenTopics.add(topic);
  }
  if (duplicateTopics.size > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["unmatchedTopics"],
      message: `unmatchedTopics must not contain duplicates: ${Array.from(duplicateTopics).join(", ")}`,
    });
  }
});

export interface PartialFollowupUnmatchedIssueRef {
  issueId: string;
  titleHint?: string;
  role?: "primary" | "related";
}

export interface PartialFollowupUnmatchedInput {
  messageText: string;
  committedIssueIds: string[];
  referencedIssues: PartialFollowupUnmatchedIssueRef[];
  workspaceAgents?: string;
  workspaceMemory?: string;
  taskKey?: string;
}

export interface PartialFollowupUnmatchedResult {
  matchedIssueIds: string[];
  unmatchedTopics: string[];
  reasoningSummary: string;
}
