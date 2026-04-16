import { Type } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
  managerCommandProposalSchema,
  managerIntentReportSchema,
  type ManagerIntentReport,
  type ManagerPendingConfirmationRequest,
  type PendingClarificationDecisionReport,
  type TaskExecutionDecisionReport,
} from "../manager-command-commit.js";
import {
  systemThreadContextReportSchema,
  type SystemThreadContextReport,
} from "../system-thread-context.js";
import {
  partialFollowupResolutionReportSchema,
  type PartialFollowupResolutionReport,
} from "../partial-followup-resolution.js";

function createIntentReportTool(): ToolDefinition {
  return {
    name: "report_manager_intent",
    label: "Report Manager Intent",
    description: "Record the current high-level intent before or during tool usage. Use this once per turn.",
    promptSnippet: "Call this early to tell the manager what kind of turn this is.",
    parameters: Type.Object({
      intent: Type.String({ description: "conversation | query | query_schedule | run_task | create_work | create_schedule | run_schedule | update_progress | update_completed | update_blocked | update_schedule | delete_schedule | followup_resolution | update_workspace_config | post_slack_message | review | heartbeat | scheduler" }),
      queryKind: Type.Optional(Type.String({ description: "Optional query subtype: list-active | list-today | what-should-i-do | inspect-work | search-existing | recommend-next-step | reference-material." })),
      queryScope: Type.Optional(Type.String({ description: "Optional query scope self | team | thread-context." })),
      conversationKind: Type.Optional(Type.String({ description: "Required when intent=conversation: greeting | smalltalk | other." })),
      confidence: Type.Optional(Type.Number({ description: "Confidence between 0 and 1." })),
      summary: Type.Optional(Type.String({ description: "One short sentence explaining the intent." })),
    }),
    async execute(_toolCallId, params) {
      const typed = managerIntentReportSchema.parse(params) as ManagerIntentReport;
      return {
        content: [{ type: "text", text: "Intent recorded." }],
        details: { intentReport: typed },
      };
    },
  };
}

function createTaskExecutionDecisionTool(): ToolDefinition {
  return {
    name: "report_task_execution_decision",
    label: "Report Task Execution Decision",
    description: "Record whether an imperative issue-execution request should execute now or no-op, and why it is executable or not executable.",
    promptSnippet: "Use this after you inspect the target issue. The summary should explain why there is a clear executable action now, or why no executable manager action exists.",
    parameters: Type.Object({
      decision: Type.String({ description: "execute | noop" }),
      targetIssueId: Type.Optional(Type.String({ description: "Resolved target issue id when known." })),
      targetIssueIdentifier: Type.Optional(Type.String({ description: "Resolved target issue identifier like AIC-123 when known." })),
      summary: Type.Optional(Type.String({ description: "One short sentence explaining why this is executable or not executable." })),
    }),
    async execute(_toolCallId, params) {
      const typed = params as TaskExecutionDecisionReport;
      return {
        content: [{ type: "text", text: "Task execution decision recorded." }],
        details: { taskExecutionDecision: typed },
      };
    },
  };
}

function createQuerySnapshotTool(): ToolDefinition {
  return {
    name: "report_query_snapshot",
    label: "Report Query Snapshot",
    description: "Record which items were shown in a query reply and what remains available for continuation.",
    promptSnippet: "Use this once for every query reply. Include referenceItems for Notion/docs/web replies when documents, pages, or databases were surfaced.",
    parameters: Type.Object({
      issueIds: Type.Array(Type.String({ description: "Issue IDs explicitly shown in this reply." })),
      shownIssueIds: Type.Array(Type.String({ description: "All issue IDs already shown in this query chain, including this reply." })),
      remainingIssueIds: Type.Array(Type.String({ description: "Relevant issue IDs not yet shown but still candidates for a follow-up like 他には?" })),
      totalItemCount: Type.Number({ description: "Total number of relevant issues in this query result set." }),
      replySummary: Type.String({ description: "One short sentence summarizing the reply." }),
      scope: Type.String({ description: "self | team | thread-context" }),
      referenceItems: Type.Optional(Type.Array(Type.Object({
        id: Type.String({ description: "Stable identifier for the referenced document, page, or database." }),
        title: Type.Optional(Type.String({ description: "Human-readable title." })),
        url: Type.Optional(Type.String({ description: "Canonical URL when available." })),
        source: Type.Optional(Type.String({ description: "Origin such as notion, notion-database, web, slack, or docs." })),
      }))),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: "Query snapshot recorded." }],
        details: { querySnapshot: params as Record<string, unknown> },
      };
    },
  };
}

function createPendingClarificationDecisionTool(): ToolDefinition {
  return {
    name: "report_pending_clarification_decision",
    label: "Report Pending Clarification Decision",
    description: "Record whether the latest message continues a pending clarification, asks for its status, starts a new request, or clears the pending state.",
    promptSnippet: "Use this once when a pending manager clarification context exists for the thread.",
    parameters: Type.Object({
      decision: Type.String({ description: "continue_pending | status_question | new_request | clear_pending" }),
      persistence: Type.String({ description: "keep | replace | clear. Use replace when this turn should create or overwrite the pending clarification state." }),
      summary: Type.Optional(Type.String({ description: "One short sentence explaining why." })),
    }),
    async execute(_toolCallId, params) {
      const typed = params as PendingClarificationDecisionReport;
      return {
        content: [{ type: "text", text: "Pending clarification decision recorded." }],
        details: { pendingClarificationDecision: typed },
      };
    },
  };
}

function createSystemThreadContextTool(): ToolDefinition {
  return {
    name: "report_system_thread_context",
    label: "Report System Thread Context",
    description: "Record the issue context referenced by a system-generated root Slack post so later human follow-ups in the same Slack thread can inherit it safely.",
    promptSnippet: "Use this in review, heartbeat, scheduler, or webhook system turns when your root reply explicitly references one or more concrete issue IDs.",
    parameters: Type.Object({
      sourceKind: Type.String({ description: "review | heartbeat | scheduler | webhook" }),
      issueRefs: Type.Array(Type.Object({
        issueId: Type.String({ description: "Issue identifier like AIC-123." }),
        titleHint: Type.Optional(Type.String({ description: "Short title hint for the referenced issue." })),
        role: Type.Optional(Type.String({ description: "primary | related" })),
      })),
      summary: Type.Optional(Type.String({ description: "Optional short summary of the root system post focus." })),
    }),
    async execute(_toolCallId, params) {
      const typed = systemThreadContextReportSchema.parse(params) as SystemThreadContextReport;
      return {
        content: [{ type: "text", text: "System thread context recorded." }],
        details: { systemThreadContextReport: typed },
      };
    },
  };
}

function createPartialFollowupResolutionTool(): ToolDefinition {
  return {
    name: "report_partial_followup_resolution",
    label: "Report Partial Follow-up Resolution",
    description: "Record which matched issue updates should proceed and which remaining subtopics have no matching existing issue.",
    promptSnippet: "Use this once when a follow-up update partially maps to known issues but one or more remaining subtopics do not match an existing issue.",
    parameters: Type.Object({
      matchedIssueIds: Type.Array(Type.String({ description: "Matched issue identifiers like AIC-123." })),
      unmatchedTopics: Type.Array(Type.String({ description: "Subtopics in the latest message that have no matching existing issue." })),
      summary: Type.Optional(Type.String({ description: "Optional short summary of this partial follow-up resolution." })),
    }),
    async execute(_toolCallId, params) {
      const typed = partialFollowupResolutionReportSchema.parse(params) as PartialFollowupResolutionReport;
      return {
        content: [{ type: "text", text: "Partial follow-up resolution recorded." }],
        details: { partialFollowupResolutionReport: typed },
      };
    },
  };
}

function createManagerConfirmationRequestTool(): ToolDefinition {
  return {
    name: "request_manager_confirmation",
    label: "Request Manager Confirmation",
    description: "Ask the manager to hold one or more mutation proposals for explicit user confirmation instead of committing them now.",
    promptSnippet: "Use this only when explicit user confirmation is truly required. Include the exact proposals to hold, the preview reply to show now, and persistence=replace.",
    parameters: Type.Object({
      previewReply: Type.String({ description: "The exact public preview reply to show in this turn." }),
      previewSummaryLines: Type.Array(Type.String({ description: "Short bullet-style summary lines for the pending confirmation context." })),
      proposalsJson: Type.String({ description: "JSON array of exact ManagerCommandProposal objects to hold for confirmation." }),
      persistence: Type.String({ description: "replace | none" }),
    }),
    async execute(_toolCallId, params) {
      const raw = params as {
        previewReply: string;
        previewSummaryLines: string[];
        proposalsJson: string;
        persistence: ManagerPendingConfirmationRequest["persistence"];
      };
      const parsedJson = JSON.parse(raw.proposalsJson) as unknown;
      const proposals = Array.isArray(parsedJson)
        ? parsedJson.map((proposal) => managerCommandProposalSchema.parse(proposal))
        : managerCommandProposalSchema.array().parse(parsedJson);
      const typed: ManagerPendingConfirmationRequest = {
        kind: "mutation",
        previewReply: raw.previewReply.trim(),
        previewSummaryLines: raw.previewSummaryLines.map((line) => line.trim()).filter(Boolean),
        proposals,
        persistence: raw.persistence === "replace" ? "replace" : "none",
      };
      return {
        content: [{ type: "text", text: "Manager confirmation requested." }],
        details: { pendingConfirmationRequest: typed },
      };
    },
  };
}

export function createManagerInternalTools(): ToolDefinition[] {
  return [
    createIntentReportTool(),
    createPendingClarificationDecisionTool(),
    createTaskExecutionDecisionTool(),
    createQuerySnapshotTool(),
    createSystemThreadContextTool(),
    createPartialFollowupResolutionTool(),
    createManagerConfirmationRequestTool(),
  ];
}
