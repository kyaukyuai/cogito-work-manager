import type { MessageRouterInput, MessageRouterResult } from "./contract.js";
import { parseMessageRouterReply } from "./parser.js";
import { buildMessageRouterPrompt } from "./prompt.js";

export type MessageRouterReplyExecutor = (
  prompt: string,
  systemPrompt: string,
  sessionSuffix: string,
) => Promise<string>;

const MESSAGE_ROUTER_SYSTEM_PROMPT = [
  "You are a message router for a Slack-first execution manager.",
  "Reply with valid JSON only.",
  "Choose the single best routing action for the latest Slack message.",
  "Be robust to ellipsis, continuation, and natural Japanese conversation.",
  "Prefer query over create_work when the user is asking to see, inspect, search, or prioritize existing work.",
].join("\n");

export async function runMessageRouterTurnWithExecutor(
  executeReply: MessageRouterReplyExecutor,
  input: MessageRouterInput,
): Promise<MessageRouterResult> {
  const reply = await executeReply(
    buildMessageRouterPrompt(input),
    MESSAGE_ROUTER_SYSTEM_PROMPT,
    input.taskKey ?? `${input.channelId}-${input.rootThreadTs}-message-router`,
  );

  return parseMessageRouterReply(reply);
}
