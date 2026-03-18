import type { FollowupResolutionResult } from "./contract.js";

function clampConfidence(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, entryValue]) => [key, typeof entryValue === "string" ? entryValue.trim() : ""] as const)
    .filter(([, entryValue]) => entryValue.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

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

function normalizeFollowupResolutionResult(value: unknown): FollowupResolutionResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.answered !== "boolean") return undefined;

  return {
    answered: record.answered,
    answerKind: typeof record.answerKind === "string" && record.answerKind.trim() ? record.answerKind.trim() : undefined,
    confidence: clampConfidence(record.confidence, record.answered ? 0.7 : 0.3),
    extractedFields: normalizeStringRecord(record.extractedFields),
    reasoningSummary: typeof record.reasoningSummary === "string" && record.reasoningSummary.trim()
      ? record.reasoningSummary.trim()
      : undefined,
  };
}

export function parseFollowupResolutionReply(reply: string): FollowupResolutionResult {
  const jsonText = extractJsonObject(reply);
  if (jsonText) {
    try {
      const parsed = normalizeFollowupResolutionResult(JSON.parse(jsonText));
      if (parsed) return parsed;
    } catch {
      // Fall through to the conservative unresolved result below.
    }
  }

  return {
    answered: false,
    confidence: 0,
    reasoningSummary: "follow-up resolution reply could not be parsed",
  };
}
