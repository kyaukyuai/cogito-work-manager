import {
  partialFollowupUnmatchedReplySchema,
  type PartialFollowupUnmatchedResult,
} from "./contract.js";

function extractJsonObject(text: string): string | undefined {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i) ?? text.match(/```\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1);
  }

  return undefined;
}

export function parsePartialFollowupUnmatchedReply(
  reply: string,
  allowedIssueIds: string[] = [],
): PartialFollowupUnmatchedResult {
  const jsonText = extractJsonObject(reply);
  if (!jsonText) {
    throw new Error("Partial follow-up unmatched reply did not contain a JSON object");
  }

  const parsed = partialFollowupUnmatchedReplySchema.parse(JSON.parse(jsonText));
  for (const issueId of parsed.matchedIssueIds) {
    if (!allowedIssueIds.includes(issueId)) {
      throw new Error(`matchedIssueIds must be chosen from committedIssueIds: ${issueId}`);
    }
  }

  return {
    matchedIssueIds: parsed.matchedIssueIds,
    unmatchedTopics: parsed.unmatchedTopics,
    reasoningSummary: parsed.reasoningSummary,
  };
}
