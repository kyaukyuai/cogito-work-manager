import type { ResearchSynthesisInput } from "./contract.js";

function currentDateInJst(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function buildResearchSynthesisPrompt(input: ResearchSynthesisInput): string {
  return [
    "Summarize the following collected research evidence for a Slack-first execution manager.",
    "Reply with a single JSON object only.",
    'Use exactly this schema: {"findings": string[], "uncertainties": string[], "nextActions": [{"title": string, "purpose": string, "ownerHint"?: string, "confidence": number}]}.',
    "Keep all strings in Japanese.",
    "findings should be concrete observations grounded in the provided evidence.",
    "uncertainties should capture what is still unclear or needs confirmation.",
    "nextActions should contain only concrete executable task candidates, not questions.",
    "Only include nextActions when they are specific enough to become Linear child issues.",
    "Each nextActions item must include a concise title, a short purpose, and a confidence between 0 and 1.",
    "Do not repeat raw evidence verbatim when a short synthesis is enough.",
    "",
    "Research request context:",
    `- channelId: ${input.channelId}`,
    `- rootThreadTs: ${input.rootThreadTs}`,
    `- taskTitle: ${input.taskTitle}`,
    `- currentDateJst: ${currentDateInJst()}`,
    "",
    "Source message:",
    input.sourceMessage || "(none)",
    "",
    "Slack thread context:",
    input.slackThreadSummary || "- none",
    "",
    "Recent channel context:",
    input.recentChannelSummary || "- none",
    "",
    "Related Linear issues:",
    input.relatedIssuesSummary || "- none",
    "",
    "Web evidence:",
    input.webSummary || "- none",
  ].join("\n");
}
