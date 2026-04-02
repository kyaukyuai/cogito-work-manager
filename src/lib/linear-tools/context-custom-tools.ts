import { Type } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AppConfig } from "../config.js";
import { getRecentChannelContext, getSlackThreadContext } from "../slack-context.js";
import { webFetchUrl, webSearchFetch } from "../web-research.js";

export function createLinearContextCustomTools(config: AppConfig): ToolDefinition[] {
  return [
    {
      name: "slack_get_thread_context",
      label: "Slack Get Thread Context",
      description: "Read the recent stored message log for a Slack thread in the local workspace.",
      promptSnippet: "Use this before researching or summarizing a thread.",
      promptGuidelines: [
        "Use this before research or planning, not for every message.",
        "Prefer this when Slack context may change issue scope or next actions.",
      ],
      parameters: Type.Object({
        channelId: Type.String({ description: "Slack channel ID." }),
        threadTs: Type.String({ description: "Root thread timestamp." }),
        limit: Type.Optional(Type.Number({ description: "Maximum number of log entries to return." })),
      }),
      async execute(_toolCallId, params, _signal) {
        const typedParams = params as { channelId: string; threadTs: string; limit?: number };
        const context = await getSlackThreadContext(config.workspaceDir, typedParams.channelId, typedParams.threadTs, typedParams.limit);
        const text = context.entries.length > 0
          ? context.entries.map((entry) => `- [${entry.type}] ${entry.text}`).join("\n")
          : "No stored thread context found.";
        return {
          content: [{ type: "text", text }],
          details: context,
        };
      },
    },
    {
      name: "slack_get_recent_channel_context",
      label: "Slack Get Recent Channel Context",
      description: "Read recent stored thread summaries for an allowed channel.",
      promptSnippet: "Use this to understand nearby work before planning or researching.",
      promptGuidelines: [
        "Use this only when nearby work may affect research or planning.",
        "Do not read broad channel context unless it materially changes the next task decision.",
      ],
      parameters: Type.Object({
        channelId: Type.String({ description: "Slack channel ID." }),
        limit: Type.Optional(Type.Number({ description: "Maximum number of recent threads to inspect." })),
      }),
      async execute(_toolCallId, params, _signal) {
        const typedParams = params as { channelId: string; limit?: number };
        const contexts = await getRecentChannelContext(config.workspaceDir, typedParams.channelId, typedParams.limit);
        const text = contexts.length > 0
          ? contexts.map((context) => `- ${context.rootThreadTs}: ${context.entries.slice(-1)[0]?.text ?? "(no entries)"}`).join("\n")
          : "No recent thread context found.";
        return {
          content: [{ type: "text", text }],
          details: contexts,
        };
      },
    },
    {
      name: "web_search_fetch",
      label: "Web Search Fetch",
      description: "Run a lightweight web search and return structured results.",
      promptSnippet: "Use this for lightweight research without external search API keys.",
      promptGuidelines: [
        "Use this only when research is required.",
        "Keep the search narrow and inspect only a small number of top results.",
      ],
      parameters: Type.Object({
        query: Type.String({ description: "Search query." }),
        limit: Type.Optional(Type.Number({ description: "Maximum number of search results." })),
      }),
      async execute(_toolCallId, params, signal) {
        const typedParams = params as { query: string; limit?: number };
        const results = await webSearchFetch(typedParams.query, typedParams.limit, signal);
        const text = results.length > 0
          ? results.map((result) => `- ${result.title}\n  - ${result.url}\n  - ${result.snippet ?? ""}`.trim()).join("\n")
          : "No search results found.";
        return {
          content: [{ type: "text", text }],
          details: results,
        };
      },
    },
    {
      name: "web_fetch_url",
      label: "Web Fetch URL",
      description: "Fetch a web page and return a short summary.",
      promptSnippet: "Use this after web_search_fetch when one result needs a closer read.",
      promptGuidelines: [
        "Use this only after web_search_fetch identifies a promising result.",
        "Fetch only the small number of pages needed to support the research summary.",
      ],
      parameters: Type.Object({
        url: Type.String({ description: "URL to fetch." }),
      }),
      async execute(_toolCallId, params, signal) {
        const summary = await webFetchUrl((params as { url: string }).url, signal);
        return {
          content: [{ type: "text", text: `Title: ${summary.title ?? "(none)"}\nURL: ${summary.url}\nSnippet: ${summary.snippet ?? "(none)"}` }],
          details: summary,
        };
      },
    },
  ];
}
