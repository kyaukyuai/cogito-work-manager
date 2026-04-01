import { z } from "zod";

const issueIdentifierSchema = z.string().trim().regex(/^AIC-\d+$/);
const unmatchedTopicSchema = z.string().trim().min(1);

export const partialFollowupResolutionReportSchema = z.object({
  matchedIssueIds: z.array(issueIdentifierSchema).min(1),
  unmatchedTopics: z.array(unmatchedTopicSchema).min(1),
  summary: z.string().trim().min(1).optional(),
}).superRefine((value, ctx) => {
  const seenIssueIds = new Set<string>();
  const duplicateIssueIds = new Set<string>();
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

  const seenTopics = new Set<string>();
  const duplicateTopics = new Set<string>();
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

export type PartialFollowupResolutionReport = z.infer<typeof partialFollowupResolutionReportSchema>;
