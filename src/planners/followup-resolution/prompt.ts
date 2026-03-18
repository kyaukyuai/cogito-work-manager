import type { FollowupResolutionInput } from "./contract.js";

export function buildFollowupResolutionPrompt(input: FollowupResolutionInput): string {
  return [
    "Assess whether the Slack reply sufficiently answers an open execution-manager follow-up request.",
    "Reply with a single JSON object only.",
    'Use exactly this schema: {"answered": boolean, "answerKind": string, "confidence": number, "extractedFields": {"assignee"?: string, "dueDate"?: string, "status"?: string, "nextAction"?: string, "nextUpdate"?: string, "blockedReason"?: string, "waitingOn"?: string, "resumeCondition"?: string}, "reasoningSummary": string}.',
    "Keep reasoningSummary concise and in Japanese.",
    "Only set answered=true if the reply actually satisfies the requested follow-up.",
    "For requestKind=status, expect progress, next action, and next update timing when possible.",
    "For requestKind=blocked-details, expect blocked reason, waiting party, and resume condition.",
    "For requestKind=owner, extract exactly one assignee name if present.",
    "For requestKind=due-date, extract exactly one dueDate in YYYY-MM-DD if present.",
    `issueId: ${input.issueId}`,
    `issueTitle: ${input.issueTitle}`,
    `requestKind: ${input.requestKind}`,
    `requestText: ${input.requestText}`,
    `acceptableAnswerHint: ${input.acceptableAnswerHint ?? "(none)"}`,
    "Slack reply:",
    input.responseText,
  ].join("\n");
}
