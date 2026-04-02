import { Type } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { createProposalTool } from "./proposal-tool-factory.js";

export function createFollowupProposalTools(): ToolDefinition[] {
  return [
    createProposalTool({
      name: "propose_followup_resolution",
      label: "Propose Followup Resolution",
      description: "Propose resolving an outstanding follow-up. This does not execute the mutation.",
      promptSnippet: "Use this when a thread reply answers a follow-up request.",
      commandType: "resolve_followup",
      parameters: Type.Object({
        issueId: Type.String({ description: "Issue identifier like AIC-123." }),
        answered: Type.Boolean({ description: "Whether the follow-up is sufficiently answered." }),
        confidence: Type.Number({ description: "Confidence between 0 and 1." }),
        answerKind: Type.Optional(Type.String({ description: "Short answer kind label." })),
        requestKind: Type.Optional(Type.String({ description: "status | blocked-details | owner | due-date" })),
        responseText: Type.String({ description: "User response text." }),
        acceptableAnswerHint: Type.Optional(Type.String({ description: "Preferred answer format hint." })),
        extractedFields: Type.Optional(Type.Object({}, { additionalProperties: Type.String() })),
        reasonSummary: Type.String({ description: "Short reason for this proposal." }),
        evidenceSummary: Type.Optional(Type.String({ description: "Short evidence summary." })),
        dedupeKeyCandidate: Type.Optional(Type.String({ description: "Stable dedupe key when you can infer one." })),
      }),
    }),
    createProposalTool({
      name: "propose_review_followup",
      label: "Propose Review Followup",
      description: "Propose a proactive follow-up request for review or heartbeat. This does not execute the mutation.",
      promptSnippet: "Use this when a review should ask for one concrete follow-up.",
      commandType: "review_followup",
      parameters: Type.Object({
        issueId: Type.String({ description: "Issue identifier like AIC-123." }),
        issueTitle: Type.String({ description: "Issue title." }),
        riskCategory: Type.String({ description: "Primary risk category." }),
        requestKind: Type.String({ description: "status | blocked-details | owner | due-date" }),
        request: Type.String({ description: "Follow-up request text." }),
        acceptableAnswerHint: Type.Optional(Type.String({ description: "Preferred answer format." })),
        assigneeDisplayName: Type.Optional(Type.String({ description: "Assignee display name." })),
        slackUserId: Type.Optional(Type.String({ description: "Slack user ID if known." })),
        source: Type.Optional(Type.Object({
          channelId: Type.String({ description: "Source channel ID." }),
          rootThreadTs: Type.String({ description: "Source thread timestamp." }),
          sourceMessageTs: Type.String({ description: "Source message timestamp." }),
        })),
        reasonSummary: Type.String({ description: "Short reason for this proposal." }),
        evidenceSummary: Type.Optional(Type.String({ description: "Short evidence summary." })),
        dedupeKeyCandidate: Type.Optional(Type.String({ description: "Stable dedupe key when you can infer one." })),
      }),
    }),
  ];
}
