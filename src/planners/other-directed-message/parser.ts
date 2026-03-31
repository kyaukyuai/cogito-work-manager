import {
  otherDirectedMessageReplySchema,
  type OtherDirectedMessageResult,
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

export function parseOtherDirectedMessageReply(
  reply: string,
  allowedOwnerEntryIds: string[] = [],
): OtherDirectedMessageResult {
  const jsonText = extractJsonObject(reply);
  if (!jsonText) {
    throw new Error("Other-directed message reply did not contain a JSON object");
  }

  const parsed = otherDirectedMessageReplySchema.parse(JSON.parse(jsonText));
  if (
    parsed.selectedOwnerEntryId
    && !allowedOwnerEntryIds.includes(parsed.selectedOwnerEntryId)
  ) {
    throw new Error(`selectedOwnerEntryId must be one of the provided owner candidates: ${parsed.selectedOwnerEntryId}`);
  }

  return {
    classification: parsed.classification,
    confidence: parsed.confidence,
    selectedOwnerEntryId: parsed.selectedOwnerEntryId,
    reasoningSummary: parsed.reasoningSummary,
  };
}
