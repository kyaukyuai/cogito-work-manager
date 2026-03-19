import { Type } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import { buildWorkgraphThreadKey } from "../state/workgraph/events.js";
import {
  getIssueContext,
  getThreadContext,
  getThreadPlanningContext,
  listAwaitingFollowups,
  listPendingClarifications,
} from "../state/workgraph/queries.js";

function formatJsonDetails(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function createWorkgraphReadTools(
  repositories: Pick<ManagerRepositories, "workgraph">,
): ToolDefinition[] {
  return [
    {
      name: "workgraph_get_thread_context",
      label: "Workgraph Get Thread Context",
      description: "Load the current execution context for a Slack thread from the workgraph read model.",
      promptSnippet: "Use this to understand thread-linked issues, clarification state, and recent focus.",
      parameters: Type.Object({
        channelId: Type.String({ description: "Slack channel ID." }),
        threadTs: Type.String({ description: "Slack root thread timestamp." }),
      }),
      async execute(_toolCallId, params) {
        const typedParams = params as { channelId: string; threadTs: string };
        const context = await getThreadContext(
          repositories.workgraph,
          buildWorkgraphThreadKey(typedParams.channelId, typedParams.threadTs),
        );
        return {
          content: [{ type: "text", text: context ? formatJsonDetails(context) : "No workgraph thread context found." }],
          details: context,
        };
      },
    },
    {
      name: "workgraph_get_issue_context",
      label: "Workgraph Get Issue Context",
      description: "Load issue-centric execution context from the workgraph read model.",
      promptSnippet: "Use this to inspect last known status, follow-up state, and linked threads for an issue.",
      parameters: Type.Object({
        issueId: Type.String({ description: "Issue identifier like AIC-123." }),
      }),
      async execute(_toolCallId, params) {
        const context = await getIssueContext(repositories.workgraph, (params as { issueId: string }).issueId);
        return {
          content: [{ type: "text", text: context ? formatJsonDetails(context) : "No workgraph issue context found." }],
          details: context,
        };
      },
    },
    {
      name: "workgraph_list_pending_clarifications",
      label: "Workgraph List Pending Clarifications",
      description: "List threads that are waiting for a clarification response.",
      promptSnippet: "Use this for review and execution follow-up.",
      parameters: Type.Object({}),
      async execute() {
        const contexts = await listPendingClarifications(repositories.workgraph);
        return {
          content: [{ type: "text", text: contexts.length > 0 ? formatJsonDetails(contexts) : "No pending clarifications." }],
          details: contexts,
        };
      },
    },
    {
      name: "workgraph_list_awaiting_followups",
      label: "Workgraph List Awaiting Followups",
      description: "List issues currently waiting for a follow-up response.",
      promptSnippet: "Use this for heartbeat, review, and next-step recommendations.",
      parameters: Type.Object({}),
      async execute() {
        const contexts = await listAwaitingFollowups(repositories.workgraph);
        return {
          content: [{ type: "text", text: contexts.length > 0 ? formatJsonDetails(contexts) : "No awaiting follow-ups." }],
          details: contexts,
        };
      },
    },
    {
      name: "workgraph_get_recent_routing_context",
      label: "Workgraph Get Recent Routing Context",
      description: "Load the thread planning context used for issue resolution and continuation handling.",
      promptSnippet: "Use this for '他には？', inspect-work, and next-step continuation inside a thread.",
      parameters: Type.Object({
        channelId: Type.String({ description: "Slack channel ID." }),
        threadTs: Type.String({ description: "Slack root thread timestamp." }),
      }),
      async execute(_toolCallId, params) {
        const typedParams = params as { channelId: string; threadTs: string };
        const context = await getThreadPlanningContext(
          repositories.workgraph,
          buildWorkgraphThreadKey(typedParams.channelId, typedParams.threadTs),
        );
        return {
          content: [{ type: "text", text: context ? formatJsonDetails(context) : "No routing context found." }],
          details: context,
        };
      },
    },
  ];
}
