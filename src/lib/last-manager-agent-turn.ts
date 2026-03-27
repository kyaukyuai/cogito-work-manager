import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThreadPaths } from "./thread-workspace.js";
import type { ManagerIntentReport, PendingClarificationDecisionReport, TaskExecutionDecisionReport } from "./manager-command-commit.js";
import type { LinearDuplicateResolutionSummary } from "./linear-duplicate-resolution.js";

export type LastManagerReplyPath = "agent" | "reply-planner" | "fallback";
export type LastManagerConversationKind = "greeting" | "smalltalk" | "other";

export interface LastManagerDuplicateResolution extends LinearDuplicateResolutionSummary {}

export interface LastManagerAgentTurn {
  recordedAt: string;
  replyPath?: LastManagerReplyPath;
  intent?: ManagerIntentReport["intent"];
  conversationKind?: LastManagerConversationKind;
  queryKind?: ManagerIntentReport["queryKind"];
  queryScope?: ManagerIntentReport["queryScope"];
  confidence?: number;
  summary?: string;
  currentDateTimeJst?: string;
  pendingClarificationDecision?: PendingClarificationDecisionReport["decision"];
  pendingClarificationPersistence?: PendingClarificationDecisionReport["persistence"];
  pendingClarificationDecisionSummary?: string;
  taskExecutionDecision?: TaskExecutionDecisionReport["decision"];
  taskExecutionTargetIssueId?: string;
  taskExecutionTargetIssueIdentifier?: string;
  taskExecutionSummary?: string;
  duplicateResolutions?: LastManagerDuplicateResolution[];
  missingQuerySnapshot?: boolean;
  technicalFailure?: string;
}

function buildLastManagerAgentTurnPath(paths: ThreadPaths): string {
  return join(paths.scratchDir, "last-manager-agent-turn.json");
}

function parseLastManagerDuplicateResolutions(value: unknown): LastManagerDuplicateResolution[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const duplicateResolutions = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const assessmentStatus = record.assessmentStatus;
    const recommendedAction = record.recommendedAction;
    const reasonSummary = record.reasonSummary;
    if (
      (assessmentStatus !== "exact" && assessmentStatus !== "fuzzy" && assessmentStatus !== "no_match" && assessmentStatus !== "unavailable")
      || (recommendedAction !== "link_existing" && recommendedAction !== "clarify" && recommendedAction !== "create_new")
      || typeof reasonSummary !== "string"
      || !reasonSummary.trim()
    ) {
      return [];
    }

    return [{
      assessmentStatus,
      recommendedAction,
      selectedIssueId: typeof record.selectedIssueId === "string" && record.selectedIssueId.trim()
        ? record.selectedIssueId.trim()
        : undefined,
      reasonSummary: reasonSummary.trim(),
      extraQueries: Array.isArray(record.extraQueries)
        ? record.extraQueries
          .filter((query): query is string => typeof query === "string")
          .map((query) => query.trim())
          .filter(Boolean)
        : [],
      finalCandidateIds: Array.isArray(record.finalCandidateIds)
        ? record.finalCandidateIds
          .filter((identifier): identifier is string => typeof identifier === "string")
          .map((identifier) => identifier.trim())
          .filter(Boolean)
        : [],
    } satisfies LastManagerDuplicateResolution];
  });

  return duplicateResolutions.length > 0 ? duplicateResolutions : undefined;
}

export async function loadLastManagerAgentTurn(
  paths: ThreadPaths,
): Promise<LastManagerAgentTurn | undefined> {
  try {
    const raw = await readFile(buildLastManagerAgentTurnPath(paths), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.recordedAt !== "string") {
      return undefined;
    }
    return {
      recordedAt: parsed.recordedAt,
      replyPath: parsed.replyPath === "agent" || parsed.replyPath === "reply-planner" || parsed.replyPath === "fallback"
        ? parsed.replyPath
        : undefined,
      intent: typeof parsed.intent === "string" ? parsed.intent as ManagerIntentReport["intent"] : undefined,
      conversationKind:
        parsed.conversationKind === "greeting" || parsed.conversationKind === "smalltalk" || parsed.conversationKind === "other"
          ? parsed.conversationKind
          : undefined,
      queryKind: typeof parsed.queryKind === "string" ? parsed.queryKind as ManagerIntentReport["queryKind"] : undefined,
      queryScope: typeof parsed.queryScope === "string" ? parsed.queryScope as ManagerIntentReport["queryScope"] : undefined,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : undefined,
      summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
      currentDateTimeJst: typeof parsed.currentDateTimeJst === "string" ? parsed.currentDateTimeJst : undefined,
      pendingClarificationDecision: typeof parsed.pendingClarificationDecision === "string"
        ? parsed.pendingClarificationDecision as PendingClarificationDecisionReport["decision"]
        : undefined,
      pendingClarificationPersistence: typeof parsed.pendingClarificationPersistence === "string"
        ? parsed.pendingClarificationPersistence as PendingClarificationDecisionReport["persistence"]
        : undefined,
      pendingClarificationDecisionSummary: typeof parsed.pendingClarificationDecisionSummary === "string"
        ? parsed.pendingClarificationDecisionSummary
        : undefined,
      taskExecutionDecision: typeof parsed.taskExecutionDecision === "string"
        ? parsed.taskExecutionDecision as TaskExecutionDecisionReport["decision"]
        : undefined,
      taskExecutionTargetIssueId: typeof parsed.taskExecutionTargetIssueId === "string"
        ? parsed.taskExecutionTargetIssueId
        : undefined,
      taskExecutionTargetIssueIdentifier: typeof parsed.taskExecutionTargetIssueIdentifier === "string"
        ? parsed.taskExecutionTargetIssueIdentifier
        : undefined,
      taskExecutionSummary: typeof parsed.taskExecutionSummary === "string"
        ? parsed.taskExecutionSummary
        : undefined,
      duplicateResolutions: parseLastManagerDuplicateResolutions(parsed.duplicateResolutions),
      missingQuerySnapshot: parsed.missingQuerySnapshot === true,
      technicalFailure: typeof parsed.technicalFailure === "string" ? parsed.technicalFailure : undefined,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function saveLastManagerAgentTurn(
  paths: ThreadPaths,
  turn: LastManagerAgentTurn,
): Promise<void> {
  await writeFile(buildLastManagerAgentTurnPath(paths), `${JSON.stringify(turn, null, 2)}\n`, "utf8");
}

export async function clearLastManagerAgentTurn(paths: ThreadPaths): Promise<void> {
  try {
    await rm(buildLastManagerAgentTurnPath(paths), { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}
