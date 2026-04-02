import type {
  ManagerIntentReport,
  PendingClarificationDecisionReport,
} from "./manager-command-commit.js";
import {
  isPendingManagerClarificationStatusQuestion,
  savePendingManagerClarification,
  type PendingManagerClarification,
} from "./pending-manager-clarification.js";
import type { ThreadPaths } from "./thread-workspace.js";

export type PendingClarificationMutableIntent =
  | "run_task"
  | "create_work"
  | "create_schedule"
  | "run_schedule"
  | "update_progress"
  | "update_completed"
  | "update_blocked"
  | "update_schedule"
  | "delete_schedule"
  | "followup_resolution"
  | "post_slack_message";

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

export function originalMessageForPendingClarification(
  pendingClarification: PendingManagerClarification | undefined,
  decision: PendingClarificationDecisionReport["decision"] | undefined,
  messageText: string,
): string {
  if (decision === "continue_pending" && pendingClarification) {
    return pendingClarification.originalUserMessage;
  }
  return messageText;
}

export function validatePendingClarificationDecision(args: {
  messageText: string;
  pendingClarification?: PendingManagerClarification;
  intent?: ManagerIntentReport["intent"];
  queryKind?: ManagerIntentReport["queryKind"];
  pendingDecision?: PendingClarificationDecisionReport;
}): void {
  if (!args.pendingClarification) {
    return;
  }
  if (!isPendingManagerClarificationStatusQuestion(args.messageText)) {
    return;
  }
  if (args.pendingDecision?.decision !== "status_question") {
    throw new Error("manager agent pending clarification status question misclassified");
  }
  if (args.pendingDecision.persistence !== "keep") {
    throw new Error("manager agent pending clarification status question missing keep persistence");
  }
  if (args.intent === "query" && args.queryKind === "list-active") {
    throw new Error("manager agent pending clarification status question misclassified as list-active query");
  }
}

export async function persistPendingManagerClarification(args: {
  paths: ThreadPaths;
  intent: PendingClarificationMutableIntent;
  originalUserMessage: string;
  lastUserMessage: string;
  clarificationReply: string;
  missingDecisionSummary?: string;
  threadParentIssueId?: string;
  relatedIssueIds?: string[];
  now: Date;
}): Promise<void> {
  await savePendingManagerClarification(args.paths, {
    intent: args.intent,
    originalUserMessage: args.originalUserMessage,
    lastUserMessage: args.lastUserMessage,
    clarificationReply: args.clarificationReply,
    missingDecisionSummary: args.missingDecisionSummary,
    threadParentIssueId: args.threadParentIssueId,
    relatedIssueIds: unique(args.relatedIssueIds ?? []),
    recordedAt: args.now.toISOString(),
  });
}
