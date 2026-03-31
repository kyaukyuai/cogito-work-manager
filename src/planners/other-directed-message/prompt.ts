import type { OtherDirectedMessageInput } from "./contract.js";

function formatOwnerCandidates(input: OtherDirectedMessageInput): string[] {
  if (input.ownerCandidates.length === 0) {
    return ["- (none)"];
  }

  return input.ownerCandidates.map((candidate) => [
    `- entryId: ${candidate.entryId}`,
    `  label: ${candidate.label}`,
    `  matchSource: ${candidate.matchSource}`,
    `  slackUserId: ${candidate.slackUserId ?? "(none)"}`,
    `  matchedSignalFamilies: ${candidate.matchedSignalFamilies.join(", ") || "(none)"}`,
  ].join("\n"));
}

export function buildOtherDirectedMessagePrompt(input: OtherDirectedMessageInput): string {
  return [
    "Classify whether the latest Slack message is mainly directed to another human, to Cogito, or still unclear.",
    "Reply with valid JSON only.",
    'Use exactly this schema: {"classification":"to_other_person"|"to_cogito"|"unclear","confidence":number,"selectedOwnerEntryId?":string,"reasoningSummary":string}',
    "If the message is ambiguous, return classification=unclear.",
    "Do not guess to_cogito when the message might still be intended for another person; use unclear instead.",
    "Explicit send/post-on-my-behalf requests should be classified as to_cogito, but those should usually have been filtered before this classifier.",
    "Plain task requests, questions to the assistant, and normal conversation with Cogito should be classified as to_cogito.",
    "Use selectedOwnerEntryId only when one provided owner candidate clearly matches the addressed person.",
    "selectedOwnerEntryId must be omitted when there is no clear candidate match or when classification is not to_other_person.",
    "",
    "Latest Slack message:",
    input.messageText,
    "",
    `Extracted signal families: ${input.signalFamilies.join(", ") || "(none)"}`,
    "",
    "Owner-map candidates:",
    ...formatOwnerCandidates(input),
  ].join("\n");
}
