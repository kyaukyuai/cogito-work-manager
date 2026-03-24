import type { PersonalizationExtractionInput, PersonalizationExtractionResult } from "./contract.js";
import { parsePersonalizationExtractionReply } from "./parser.js";
import { buildPersonalizationExtractionPrompt } from "./prompt.js";
import { appendWorkspacePersonalizationToSystemPrompt } from "../../lib/prompt-personalization.js";

export type PersonalizationExtractionExecutor = (
  prompt: string,
  systemPrompt: string,
  sessionSuffix: string,
) => Promise<string>;

const PERSONALIZATION_EXTRACTION_SYSTEM_PROMPT = [
  "You maintain runtime personalization for a Japanese execution manager.",
  "Reply with valid JSON only.",
  "Extract only stable, reusable operator-specific rules or memory.",
  "Do not treat one-off task status, momentary plans, parser/schema rules, or repo development rules as personalization.",
  "When in doubt, return ignore.",
].join("\n");

export async function runPersonalizationExtractionTurnWithExecutor(
  executeReply: PersonalizationExtractionExecutor,
  input: PersonalizationExtractionInput,
): Promise<PersonalizationExtractionResult> {
  const reply = await executeReply(
    buildPersonalizationExtractionPrompt(input),
    appendWorkspacePersonalizationToSystemPrompt(PERSONALIZATION_EXTRACTION_SYSTEM_PROMPT, input),
    input.taskKey ?? `personalization-${input.turnKind}-${input.currentDate}`,
  );

  return parsePersonalizationExtractionReply(reply);
}
