import type { ManagerReplyInput, ManagerReplyResult } from "./contract.js";
import { parseManagerReplyReply } from "./parser.js";
import { buildManagerReplyPrompt } from "./prompt.js";
import { appendWorkspacePersonalizationToSystemPrompt } from "../../lib/prompt-personalization.js";

export type ManagerReplyExecutor = (
  prompt: string,
  systemPrompt: string,
  sessionSuffix: string,
) => Promise<string>;

const MANAGER_REPLY_SYSTEM_PROMPT = [
  "You are a Slack reply writer for a Japanese execution manager.",
  "Reply with valid JSON only.",
  "Write concise, natural Japanese that sounds like a capable assistant.",
  "Do not add facts that were not provided.",
].join("\n");

export async function runManagerReplyTurnWithExecutor(
  executeReply: ManagerReplyExecutor,
  input: ManagerReplyInput,
): Promise<ManagerReplyResult> {
  const reply = await executeReply(
    buildManagerReplyPrompt(input),
    appendWorkspacePersonalizationToSystemPrompt(MANAGER_REPLY_SYSTEM_PROMPT, input),
    input.taskKey ?? `${input.kind}-manager-reply`,
  );

  return parseManagerReplyReply(reply);
}
