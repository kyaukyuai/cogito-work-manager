import { duplicateRecallReplySchema, type DuplicateRecallResult } from "./contract.js";

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

export function parseDuplicateRecallReply(reply: string): DuplicateRecallResult {
  const jsonText = extractJsonObject(reply);
  if (!jsonText) {
    throw new Error("Duplicate recall reply did not contain a JSON object");
  }

  const parsed = duplicateRecallReplySchema.parse(JSON.parse(jsonText));
  return {
    assessmentStatus: parsed.assessmentStatus,
    recommendedAction: parsed.recommendedAction,
    selectedIssueId: parsed.selectedIssueId,
    reasonSummary: parsed.reasonSummary,
    missingSlots: parsed.missingSlots,
    extraQueries: parsed.extraQueries,
  };
}

