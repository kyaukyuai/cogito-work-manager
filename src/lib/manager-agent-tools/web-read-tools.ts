import { Type } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { webFetchUrl, webSearchFetch } from "../web-research.js";

function formatJsonDetails(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function createWebReadTools(): ToolDefinition[] {
  return [
    {
      name: "web_search_fetch",
      label: "Web Search Fetch",
      description: "Run a lightweight web search and return structured results.",
      promptSnippet: "Use this only when external research materially changes the answer.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query." }),
        limit: Type.Optional(Type.Number({ description: "Maximum number of results." })),
      }),
      async execute(_toolCallId, params, signal) {
        const typedParams = params as { query: string; limit?: number };
        const results = await webSearchFetch(typedParams.query, typedParams.limit, signal);
        return {
          content: [{ type: "text", text: results.length > 0 ? formatJsonDetails(results) : "No web search results found." }],
          details: results,
        };
      },
    },
    {
      name: "web_fetch_url",
      label: "Web Fetch URL",
      description: "Fetch and summarize one URL.",
      promptSnippet: "Use this after selecting a relevant search result.",
      parameters: Type.Object({
        url: Type.String({ description: "URL to fetch." }),
      }),
      async execute(_toolCallId, params, signal) {
        const result = await webFetchUrl((params as { url: string }).url, signal);
        return {
          content: [{ type: "text", text: formatJsonDetails(result) }],
          details: result,
        };
      },
    },
  ];
}
