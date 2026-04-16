import {
  managerPendingConfirmationKindSchema,
  managerCommandProposalSchema,
  managerIntentReportSchema,
  managerPendingConfirmationRequestPersistenceSchema,
  pendingClarificationDecisionSchema,
  taskExecutionDecisionSchema,
  type ManagerAgentIssueEvidence,
  type ManagerAgentToolCall,
  type ManagerCommandProposal,
  type ManagerIntentReport,
  type ManagerPendingConfirmationRequest,
  type PendingClarificationDecisionReport,
  type TaskExecutionDecisionReport,
} from "./contracts.js";
import {
  summarizeResolvedLinearDuplicateCandidates,
  type LinearDuplicateResolutionSummary,
} from "../linear-duplicate-resolution.js";
import {
  systemThreadContextReportSchema,
  type SystemThreadContextReport,
} from "../system-thread-context.js";
import {
  partialFollowupResolutionReportSchema,
  type PartialFollowupResolutionReport,
} from "../partial-followup-resolution.js";

function isIssueIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z][A-Z0-9]+-\d+$/.test(value.trim());
}

export function extractIntentReport(toolCalls: ManagerAgentToolCall[]): ManagerIntentReport | undefined {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const details = toolCalls[index]?.details as { intentReport?: unknown } | undefined;
    const parsed = managerIntentReportSchema.safeParse(details?.intentReport);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return undefined;
}

export function extractPendingClarificationDecision(
  toolCalls: ManagerAgentToolCall[],
): PendingClarificationDecisionReport | undefined {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const toolCall = toolCalls[index];
    if (toolCall?.toolName !== "report_pending_clarification_decision") {
      continue;
    }
    const details = toolCall.details as { pendingClarificationDecision?: unknown } | undefined;
    const parsed = pendingClarificationDecisionSchema.safeParse(details?.pendingClarificationDecision);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return undefined;
}

export function extractTaskExecutionDecision(
  toolCalls: ManagerAgentToolCall[],
): TaskExecutionDecisionReport | undefined {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const toolCall = toolCalls[index];
    if (toolCall?.toolName !== "report_task_execution_decision") {
      continue;
    }
    const details = toolCall.details as { taskExecutionDecision?: unknown } | undefined;
    const parsed = taskExecutionDecisionSchema.safeParse(details?.taskExecutionDecision);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return undefined;
}

export function extractSystemThreadContextReport(
  toolCalls: ManagerAgentToolCall[],
): SystemThreadContextReport | undefined {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const toolCall = toolCalls[index];
    if (toolCall?.toolName !== "report_system_thread_context") {
      continue;
    }
    const details = toolCall.details as { systemThreadContextReport?: unknown } | undefined;
    const parsed = systemThreadContextReportSchema.safeParse(details?.systemThreadContextReport);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return undefined;
}

export function extractPartialFollowupResolutionReport(
  toolCalls: ManagerAgentToolCall[],
): PartialFollowupResolutionReport | undefined {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const toolCall = toolCalls[index];
    if (toolCall?.toolName !== "report_partial_followup_resolution") {
      continue;
    }
    const details = toolCall.details as { partialFollowupResolutionReport?: unknown } | undefined;
    const parsed = partialFollowupResolutionReportSchema.safeParse(details?.partialFollowupResolutionReport);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return undefined;
}

export function extractDuplicateResolutionSummaries(
  toolCalls: ManagerAgentToolCall[],
): LinearDuplicateResolutionSummary[] {
  return toolCalls.flatMap((toolCall) => {
    if (toolCall?.toolName !== "linear_resolve_duplicate_candidates") {
      return [];
    }
    const summary = summarizeResolvedLinearDuplicateCandidates(toolCall.details);
    return summary ? [summary] : [];
  });
}

export function extractAgentIssueEvidence(toolCalls: ManagerAgentToolCall[]): ManagerAgentIssueEvidence[] {
  const evidence = new Map<string, ManagerAgentIssueEvidence>();

  for (const toolCall of toolCalls) {
    if (toolCall?.toolName === "linear_get_issue_facts") {
      const details = toolCall.details as { identifier?: unknown; title?: unknown } | undefined;
      if (isIssueIdentifier(details?.identifier)) {
        const issueId = details.identifier.trim();
        evidence.set(issueId, {
          issueId,
          source: "linear_get_issue_facts",
          summary: typeof details?.title === "string" && details.title.trim()
            ? details.title.trim()
            : undefined,
        });
      }
      continue;
    }

    if (toolCall?.toolName === "linear_resolve_duplicate_candidates") {
      const summary = summarizeResolvedLinearDuplicateCandidates(toolCall.details);
      if (summary?.assessmentStatus === "exact" && summary.selectedIssueId) {
        evidence.set(summary.selectedIssueId, {
          issueId: summary.selectedIssueId,
          source: "duplicate_exact_reuse",
          summary: summary.reasonSummary,
        });
      }
    }
  }

  return Array.from(evidence.values());
}

export function extractPendingConfirmationRequest(
  toolCalls: ManagerAgentToolCall[],
): ManagerPendingConfirmationRequest | undefined {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const toolCall = toolCalls[index];
    if (toolCall?.toolName !== "request_manager_confirmation") {
      continue;
    }
    const details = toolCall.details as { pendingConfirmationRequest?: unknown } | undefined;
    const parsed = managerPendingConfirmationKindSchema.safeParse(
      (details?.pendingConfirmationRequest as { kind?: unknown } | undefined)?.kind,
    );
    const parsedPersistence = managerPendingConfirmationRequestPersistenceSchema.safeParse(
      (details?.pendingConfirmationRequest as { persistence?: unknown } | undefined)?.persistence,
    );
    const request = details?.pendingConfirmationRequest as {
      previewReply?: unknown;
      previewSummaryLines?: unknown;
      proposals?: unknown;
    } | undefined;
    const proposals = Array.isArray(request?.proposals)
      ? request.proposals.flatMap((proposal) => {
        const parsedProposal = managerCommandProposalSchema.safeParse(proposal);
        return parsedProposal.success ? [parsedProposal.data] : [];
      })
      : [];

    if (
      parsed.success
      && parsed.data === "mutation"
      && parsedPersistence.success
      && typeof request?.previewReply === "string"
      && request.previewReply.trim()
      && Array.isArray(request.previewSummaryLines)
      && request.previewSummaryLines.every((line) => typeof line === "string")
      && proposals.length > 0
    ) {
      return {
        kind: parsed.data,
        proposals,
        previewReply: request.previewReply.trim(),
        previewSummaryLines: request.previewSummaryLines
          .map((line) => line.trim())
          .filter(Boolean),
        persistence: parsedPersistence.data,
      };
    }
  }
  return undefined;
}

export function extractManagerCommandProposals(toolCalls: ManagerAgentToolCall[]): {
  proposals: ManagerCommandProposal[];
  invalidProposalCount: number;
} {
  const proposals: ManagerCommandProposal[] = [];
  let invalidProposalCount = 0;

  for (const toolCall of toolCalls) {
    const details = toolCall.details as { proposal?: unknown } | undefined;
    if (!details?.proposal) continue;
    const parsed = managerCommandProposalSchema.safeParse(details.proposal);
    if (parsed.success) {
      proposals.push(parsed.data);
    } else {
      invalidProposalCount += 1;
    }
  }

  return { proposals, invalidProposalCount };
}
