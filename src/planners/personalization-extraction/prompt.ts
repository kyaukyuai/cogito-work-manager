import type { PersonalizationExtractionInput } from "./contract.js";

export function buildPersonalizationExtractionPrompt(input: PersonalizationExtractionInput): string {
  const issueLines = input.issueContext
    ? [
        `- issueId: ${input.issueContext.issueId ?? "(none)"}`,
        `- issueIdentifier: ${input.issueContext.issueIdentifier ?? "(none)"}`,
      ]
    : ["- (none)"];
  const workspaceAgentsLines = input.workspaceAgents
    ? ["Current runtime AGENTS:", input.workspaceAgents]
    : ["Current runtime AGENTS:", "(none)"];
  const workspaceMemoryLines = input.workspaceMemory
    ? ["Current workspace MEMORY:", input.workspaceMemory]
    : ["Current workspace MEMORY:", "(none)"];

  return [
    "Extract stable runtime personalization candidates from the latest turn.",
    "Reply with a single JSON object only.",
    'Use exactly this schema: {"observations":[{"kind":"operating_rule"|"preference_or_fact"|"ignore","source":"explicit"|"inferred","category":"workflow"|"reply-style"|"priority"|"terminology"|"people-and-projects"|"preferences"|"context","summary":string,"canonicalText":string,"confidence":number}]}',
    "Only extract durable operator-specific knowledge.",
    "Do not extract temporary task status, due dates, current assignees, parser/schema rules, supported actions, or repo development rules.",
    "operating_rule is for stable ways of working or strong reply/workflow rules that belong in runtime AGENTS.",
    "preference_or_fact is for terminology, background facts, people/project context, or durable preferences that belong in MEMORY.",
    "If there is nothing worth learning, return observations with a single ignore item.",
    "Broad auto-inference is allowed, but inferred items must be conservative and high-confidence.",
    "Prefer concise canonicalText written as a durable rule or fact in Japanese.",
    "Never emit operating_rule or preference_or_fact with blank canonicalText. If you cannot write a durable sentence, return ignore instead.",
    `turnKind: ${input.turnKind}`,
    `currentDateJst: ${input.currentDate}`,
    "",
    "Issue context:",
    ...issueLines,
    "",
    "Latest user/system message:",
    input.latestUserMessage || "(empty)",
    "",
    "Latest assistant reply:",
    input.latestAssistantReply || "(empty)",
    "",
    `Committed commands: ${input.committedCommands.join(", ") || "(none)"}`,
    `Rejected reasons: ${input.rejectedReasons.join(" / ") || "(none)"}`,
    "",
    ...workspaceAgentsLines,
    "",
    ...workspaceMemoryLines,
  ].join("\n");
}
