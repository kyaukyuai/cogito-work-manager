import type { ResearchNextAction, ResearchSynthesisResult } from "./contract.js";

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .slice(0, 8);
}

function clampConfidence(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function normalizeResearchNextActions(value: unknown): ResearchNextAction[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      if (typeof item === "string") {
        const title = item.trim();
        return title
          ? {
              title,
              purpose: "",
              confidence: 0.5,
            } satisfies ResearchNextAction
          : undefined;
      }
      if (!item || typeof item !== "object") return undefined;

      const record = item as Record<string, unknown>;
      const title = typeof record.title === "string" ? record.title.trim() : "";
      if (!title) return undefined;

      return {
        title,
        purpose: typeof record.purpose === "string" ? record.purpose.trim() : "",
        ownerHint: typeof record.ownerHint === "string" && record.ownerHint.trim() ? record.ownerHint.trim() : undefined,
        confidence: clampConfidence(record.confidence, 0.5),
      } satisfies ResearchNextAction;
    })
    .filter((item): item is ResearchNextAction => Boolean(item))
    .slice(0, 8);
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

function normalizeResearchSynthesisResult(value: unknown): ResearchSynthesisResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const findings = normalizeStringList(record.findings);
  const uncertainties = normalizeStringList(record.uncertainties);
  const nextActions = normalizeResearchNextActions(record.nextActions);

  if (findings.length === 0 && uncertainties.length === 0 && nextActions.length === 0) {
    return undefined;
  }

  return {
    findings,
    uncertainties,
    nextActions,
  };
}

export function parseResearchSynthesisReply(reply: string): ResearchSynthesisResult {
  const jsonText = extractJsonObject(reply);
  if (jsonText) {
    try {
      const parsed = normalizeResearchSynthesisResult(JSON.parse(jsonText));
      if (parsed) return parsed;
    } catch {
      // Fall back to line-based parsing below.
    }
  }

  const lines = reply
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*・•]\s*/, "").trim());

  const nextActions = lines
    .filter((line) => /(確認|修正|対応|実装|調査|整理|洗い出し|作成|更新|共有|再現|検証|比較)/.test(line))
    .slice(0, 5)
    .map((title) => ({
      title,
      purpose: "",
      confidence: 0.4,
    }));

  return {
    findings: lines.slice(0, 3),
    uncertainties: [],
    nextActions,
  };
}
