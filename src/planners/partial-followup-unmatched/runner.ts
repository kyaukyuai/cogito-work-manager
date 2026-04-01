import { appendWorkspacePersonalizationToSystemPrompt } from "../../lib/prompt-personalization.js";
import type { PartialFollowupUnmatchedInput, PartialFollowupUnmatchedResult } from "./contract.js";
import { parsePartialFollowupUnmatchedReply } from "./parser.js";
import { buildPartialFollowupUnmatchedPrompt } from "./prompt.js";

export type PartialFollowupUnmatchedReplyExecutor = (
  prompt: string,
  systemPrompt: string,
  sessionSuffix: string,
) => Promise<string>;

const PARTIAL_FOLLOWUP_UNMATCHED_SYSTEM_PROMPT = [
  "You are a classifier for partial-success Slack follow-up replies in a Slack-first execution manager.",
  "Reply with valid JSON only.",
  "Identify only whether the latest follow-up message contains remaining concrete subtopics with no existing issue in the current thread context.",
  "Be conservative and prefer an empty unmatchedTopics array over inventing unmatched work.",
  "Do not invent issue IDs outside the committed issue IDs provided.",
].join("\n");

export async function runPartialFollowupUnmatchedTurnWithExecutor(
  executeReply: PartialFollowupUnmatchedReplyExecutor,
  input: PartialFollowupUnmatchedInput,
): Promise<PartialFollowupUnmatchedResult> {
  const reply = await executeReply(
    buildPartialFollowupUnmatchedPrompt(input),
    appendWorkspacePersonalizationToSystemPrompt(PARTIAL_FOLLOWUP_UNMATCHED_SYSTEM_PROMPT, input),
    input.taskKey ?? "partial-followup-unmatched",
  );

  return parsePartialFollowupUnmatchedReply(reply, input.committedIssueIds);
}
