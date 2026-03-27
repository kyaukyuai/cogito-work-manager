import type { DuplicateRecallInput } from "./contract.js";

function formatCandidates(input: DuplicateRecallInput): string {
  if (input.initialCandidates.length === 0) {
    return "- (none)";
  }

  return input.initialCandidates
    .slice(0, 6)
    .map((candidate) => [
      `- ${candidate.identifier}: ${candidate.title}`,
      `  - matchedQueries: ${candidate.matchedQueries.join(" | ") || "(none)"}`,
      `  - matchedTokenCount: ${candidate.matchedTokenCount}`,
      `  - state: ${candidate.state ?? "(none)"}`,
      `  - updatedAt: ${candidate.updatedAt ?? "(none)"}`,
    ].join("\n"))
    .join("\n");
}

export function buildDuplicateRecallPrompt(input: DuplicateRecallInput): string {
  return [
    "Assess whether the request should reuse an existing Linear issue, ask for clarification, or create new work.",
    "Reply with a single JSON object only.",
    'Use exactly this schema: {"assessmentStatus":"exact"|"fuzzy"|"no_match","recommendedAction":"link_existing"|"clarify"|"create_new","selectedIssueId"?:string,"reasonSummary":string,"missingSlots":string[],"extraQueries":string[]}.',
    "Keep reasonSummary concise and in Japanese.",
    "Return assessmentStatus=exact only when one existing issue is clearly the same work and safe to reuse now.",
    "If actor, target person, destination channel, invited person, or another key slot differs or is missing, return assessmentStatus=fuzzy and recommendedAction=clarify.",
    "If the current candidates do not point to the same work, return assessmentStatus=no_match and recommendedAction=create_new.",
    "Use selectedIssueId only when recommendedAction=link_existing.",
    "extraQueries may contain up to 4 short lexical search strings for Linear duplicate lookup.",
    "Use extraQueries when current candidates are empty or too weak to decide. Keep them short and search-oriented, not explanatory sentences.",
    "Do not invent issue IDs.",
    "Do not recommend link_existing for a broad parent-like issue when the request appears to be a narrower child task. In that case prefer clarify.",
    "",
    `Request text: ${input.requestText}`,
    "",
    "Current duplicate candidates:",
    formatCandidates(input),
  ].join("\n");
}

