import type { PartialFollowupUnmatchedInput } from "./contract.js";

function formatReferencedIssues(input: PartialFollowupUnmatchedInput): string[] {
  if (input.referencedIssues.length === 0) {
    return ["- (none)"];
  }

  return input.referencedIssues.map((issue) => [
    `- issueId: ${issue.issueId}`,
    `  titleHint: ${issue.titleHint ?? "(none)"}`,
    `  role: ${issue.role ?? "(none)"}`,
  ].join("\n"));
}

export function buildPartialFollowupUnmatchedPrompt(input: PartialFollowupUnmatchedInput): string {
  return [
    "Analyze the latest Slack follow-up message after at least one issue update already committed.",
    "Reply with valid JSON only.",
    'Use exactly this schema: {"matchedIssueIds":string[],"unmatchedTopics":string[],"reasoningSummary":string}',
    "matchedIssueIds must be chosen only from the committedIssueIds provided below.",
    "unmatchedTopics should contain only concrete subtopics in the latest message that do not clearly map to any existing referenced issue in this Slack thread.",
    "If a separate noun phrase or workstream is not clearly covered by a referenced issue title/titleHint, include it in unmatchedTopics instead of silently folding it into a matched issue.",
    "If every meaningful subtopic is already covered by the committed issues or referenced issues, return unmatchedTopics as an empty array.",
    "Do not invent issue IDs or unmatched topics that are not grounded in the latest message.",
    "",
    "Latest Slack follow-up message:",
    input.messageText,
    "",
    `Committed issue IDs: ${input.committedIssueIds.join(", ") || "(none)"}`,
    "",
    "Referenced issues in this Slack thread:",
    ...formatReferencedIssues(input),
  ].join("\n");
}
