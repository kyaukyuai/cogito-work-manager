import type { ResearchSynthesisInput, ResearchSynthesisResult } from "./contract.js";
import { parseResearchSynthesisReply } from "./parser.js";
import { buildResearchSynthesisPrompt } from "./prompt.js";
import { appendWorkspacePersonalizationToSystemPrompt } from "../../lib/prompt-personalization.js";

export type ResearchSynthesisReplyExecutor = (
  prompt: string,
  systemPrompt: string,
  sessionSuffix: string,
) => Promise<string>;

const RESEARCH_SYNTHESIS_SYSTEM_PROMPT = [
  "You are a research synthesis helper for a Slack-first execution manager.",
  "Reply with valid JSON only.",
  'The JSON schema is {"findings": string[], "uncertainties": string[], "nextActions": [{"title": string, "purpose": string, "ownerHint"?: string, "confidence": number}]}.',
  "Keep output concise, grounded in the provided evidence, and in Japanese.",
  "nextActions must be concrete executable task candidates, not vague summaries.",
  "Use confidence between 0 and 1.",
].join("\n");

export async function runResearchSynthesisTurnWithExecutor(
  executeReply: ResearchSynthesisReplyExecutor,
  input: ResearchSynthesisInput,
): Promise<ResearchSynthesisResult> {
  const reply = await executeReply(
    buildResearchSynthesisPrompt(input),
    appendWorkspacePersonalizationToSystemPrompt(RESEARCH_SYNTHESIS_SYSTEM_PROMPT, input),
    input.taskKey ?? `${input.channelId}-${input.rootThreadTs}-research-synthesis`,
  );

  return parseResearchSynthesisReply(reply);
}
