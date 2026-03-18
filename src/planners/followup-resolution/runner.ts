import type { FollowupResolutionInput, FollowupResolutionResult } from "./contract.js";
import { parseFollowupResolutionReply } from "./parser.js";
import { buildFollowupResolutionPrompt } from "./prompt.js";

export type FollowupResolutionReplyExecutor = (
  prompt: string,
  systemPrompt: string,
  sessionSuffix: string,
) => Promise<string>;

const FOLLOWUP_RESOLUTION_SYSTEM_PROMPT = [
  "You are a follow-up resolution helper for a Slack-first execution manager.",
  "Reply with valid JSON only.",
  "Decide whether the Slack reply actually answers the requested follow-up.",
  "Be strict: mentioning progress without satisfying the request must stay unanswered.",
].join("\n");

export async function runFollowupResolutionTurnWithExecutor(
  executeReply: FollowupResolutionReplyExecutor,
  input: FollowupResolutionInput,
): Promise<FollowupResolutionResult> {
  const reply = await executeReply(
    buildFollowupResolutionPrompt(input),
    FOLLOWUP_RESOLUTION_SYSTEM_PROMPT,
    input.taskKey ?? `${input.issueId}-followup-resolution`,
  );

  return parseFollowupResolutionReply(reply);
}
