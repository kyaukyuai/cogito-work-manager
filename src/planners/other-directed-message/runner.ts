import { appendWorkspacePersonalizationToSystemPrompt } from "../../lib/prompt-personalization.js";
import type { OtherDirectedMessageInput, OtherDirectedMessageResult } from "./contract.js";
import { parseOtherDirectedMessageReply } from "./parser.js";
import { buildOtherDirectedMessagePrompt } from "./prompt.js";

export type OtherDirectedMessageReplyExecutor = (
  prompt: string,
  systemPrompt: string,
  sessionSuffix: string,
) => Promise<string>;

const OTHER_DIRECTED_MESSAGE_SYSTEM_PROMPT = [
  "You are a classifier for Slack message direction in a Slack-first execution manager.",
  "Reply with valid JSON only.",
  "Classify only whether the latest message is mainly directed to another person, to Cogito, or unclear.",
  "Prefer unclear over overconfident routing.",
  "Do not invent owner IDs that are not present in the candidate list.",
].join("\n");

export async function runOtherDirectedMessageTurnWithExecutor(
  executeReply: OtherDirectedMessageReplyExecutor,
  input: OtherDirectedMessageInput,
): Promise<OtherDirectedMessageResult> {
  const reply = await executeReply(
    buildOtherDirectedMessagePrompt(input),
    appendWorkspacePersonalizationToSystemPrompt(OTHER_DIRECTED_MESSAGE_SYSTEM_PROMPT, input),
    input.taskKey ?? "other-directed-message",
  );

  return parseOtherDirectedMessageReply(
    reply,
    input.ownerEntries.map((entry) => entry.entryId),
  );
}
