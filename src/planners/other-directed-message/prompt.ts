import type { OtherDirectedMessageInput } from "./contract.js";

function formatRecentThreadEntries(input: OtherDirectedMessageInput): string[] {
  if (input.recentThreadEntries.length === 0) {
    return ["- (none)"];
  }

  return input.recentThreadEntries.map((entry, index) => [
    `- entry ${index + 1}`,
    `  userId: ${entry.userId ?? "(unknown)"}`,
    `  text: ${entry.text}`,
  ].join("\n"));
}

function formatOwnerEntries(input: OtherDirectedMessageInput): string[] {
  if (input.ownerEntries.length === 0) {
    return ["- (none)"];
  }

  return input.ownerEntries.map((entry) => [
    `- entryId: ${entry.entryId}`,
    `  linearAssignee: ${entry.linearAssignee}`,
    `  slackUserId: ${entry.slackUserId ?? "(none)"}`,
    `  keywords: ${entry.keywords.join(", ") || "(none)"}`,
  ].join("\n"));
}

export function buildOtherDirectedMessagePrompt(input: OtherDirectedMessageInput): string {
  return [
    "Classify whether the latest Slack message is mainly directed to another human, to Cogito, or still unclear.",
    "Reply with valid JSON only.",
    'Use exactly this schema: {"classification":"to_other_person"|"to_cogito"|"unclear","confidence":number,"selectedOwnerEntryId?":string,"reasoningSummary":string}',
    "If the message is ambiguous, return classification=unclear.",
    "If the message could reasonably be meant for another person, prefer unclear over guessing to_cogito.",
    "Explicit send/post-on-my-behalf requests should be classified as to_cogito.",
    "Plain task requests, questions to the assistant, and normal conversation with Cogito should be classified as to_cogito.",
    "If the message is directed to another person but you cannot safely map that person to one provided owner entry, return classification=to_other_person and omit selectedOwnerEntryId.",
    "Use selectedOwnerEntryId only when one provided owner entry clearly matches the addressed person.",
    "selectedOwnerEntryId must be omitted when there is no clear owner match or when classification is not to_other_person.",
    "",
    `Assistant name: ${input.assistantName}`,
    "",
    "Latest Slack message:",
    input.messageText,
    "",
    "Recent thread context (excluding the latest message):",
    ...formatRecentThreadEntries(input),
    "",
    "Owner-map entries:",
    ...formatOwnerEntries(input),
  ].join("\n");
}
