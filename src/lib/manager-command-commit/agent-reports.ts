import {
  managerCommandProposalSchema,
  managerIntentReportSchema,
  pendingClarificationDecisionSchema,
  taskExecutionDecisionSchema,
  type ManagerAgentToolCall,
  type ManagerCommandProposal,
  type ManagerIntentReport,
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
