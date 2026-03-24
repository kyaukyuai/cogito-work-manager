import { personalizationExtractionSchema, type PersonalizationExtractionResult } from "./contract.js";

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

export function parsePersonalizationExtractionReply(reply: string): PersonalizationExtractionResult {
  const jsonText = extractJsonObject(reply);
  if (!jsonText) {
    throw new Error("Personalization extraction reply did not contain a JSON object");
  }
  return personalizationExtractionSchema.parse(JSON.parse(jsonText));
}
