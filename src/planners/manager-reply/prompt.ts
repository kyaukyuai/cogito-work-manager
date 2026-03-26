import type { ManagerReplyInput } from "./contract.js";

export function buildManagerReplyPrompt(input: ManagerReplyInput): string {
  return [
    "Write a concise Slack reply for a Japanese execution manager.",
    "Reply with a single JSON object only.",
    'Use exactly this schema: {"reply": string}.',
    "Keep the reply in Japanese.",
    "Tone: concise executive assistant. No emoji. No markdown headings. No labels like 要返信 or 次アクション.",
    "Use at most 1-2 short paragraphs. Use bullets only when listing multiple issues or options.",
    "Do not invent facts. Use only the provided facts.",
    "Prefer natural conversational phrasing over mechanical templates.",
    "Mention issue IDs when they are provided in facts.",
    "If queryScope=self, phrase the answer as the viewer's own work.",
    "If viewerMappingMissing is true, briefly mention that the reply is team-wide because Slack-to-owner mapping is missing.",
    "If facts.capabilityQuery is present, answer that capability question directly in one or two short sentences.",
    "Do not reinterpret a capability question like y.kakui にメンションできる？ as whether the user can mention the assistant.",
    "When facts.capabilityQuery is present, rely on the provided supportSummary and limitationSummary for the supported scope and hard limits instead of inventing a broader Slack action surface.",
    `replyKind: ${input.kind}`,
    `queryScope: ${input.queryScope ?? "(none)"}`,
    `conversationKind: ${input.conversationKind ?? "(none)"}`,
    `currentDateInJst: ${input.currentDate}`,
    `latestUserMessage: ${input.messageText}`,
    "Facts:",
    JSON.stringify(input.facts, null, 2),
  ].join("\n");
}
