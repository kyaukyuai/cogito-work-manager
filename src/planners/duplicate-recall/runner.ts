import { appendWorkspacePersonalizationToSystemPrompt } from "../../lib/prompt-personalization.js";
import type { DuplicateRecallInput, DuplicateRecallResult } from "./contract.js";
import { parseDuplicateRecallReply } from "./parser.js";
import { buildDuplicateRecallPrompt } from "./prompt.js";

export type DuplicateRecallReplyExecutor = (
  prompt: string,
  systemPrompt: string,
  sessionSuffix: string,
) => Promise<string>;

const DUPLICATE_RECALL_SYSTEM_PROMPT = [
  "You are a duplicate-recall assessor for a Slack-first execution manager.",
  "Reply with valid JSON only.",
  "You do not create or mutate issues.",
  "Be conservative about existing-issue reuse.",
  "When key slots differ or remain implicit, prefer clarification over reuse.",
].join("\n");

export async function runDuplicateRecallTurnWithExecutor(
  executeReply: DuplicateRecallReplyExecutor,
  input: DuplicateRecallInput,
): Promise<DuplicateRecallResult> {
  const reply = await executeReply(
    buildDuplicateRecallPrompt(input),
    appendWorkspacePersonalizationToSystemPrompt(DUPLICATE_RECALL_SYSTEM_PROMPT, input),
    input.taskKey ?? "duplicate-recall",
  );

  return parseDuplicateRecallReply(reply);
}

