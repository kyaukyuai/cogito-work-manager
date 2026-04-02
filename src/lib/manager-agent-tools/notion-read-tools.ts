import { Type } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AppConfig } from "../config.js";
import {
  getNotionDatabaseFacts,
  getNotionPageContent,
  getNotionPageFacts,
  listNotionDatabases,
  queryNotionDatabase,
  searchNotionDatabases,
  searchNotionPages,
  type NotionCommandEnv,
} from "../notion.js";

function buildNotionEnv(config: AppConfig): NotionCommandEnv {
  return {
    ...process.env,
    NOTION_API_TOKEN: config.notionApiToken,
  };
}

function formatJsonDetails(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function formatDateLabel(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatNotionPageLabel(page: {
  title?: string;
  url?: string | null;
  lastEditedTime?: string | null;
}): string {
  const title = page.title?.trim() || "Untitled";
  const linkedTitle = page.url ? `[${title}](${page.url})` : title;
  const edited = formatDateLabel(page.lastEditedTime);
  return edited ? `${linkedTitle}（最終更新: ${edited}）` : linkedTitle;
}

function formatNotionSearchResultText(
  pages: Array<{
    title?: string;
    url?: string | null;
    lastEditedTime?: string | null;
  }>,
): string {
  if (pages.length === 0) {
    return "No matching Notion pages found.";
  }
  return [
    "Notion pages:",
    ...pages.map((page) => `- ${formatNotionPageLabel(page)}`),
  ].join("\n");
}

function formatNotionPageFactsText(page: {
  title?: string;
  url?: string | null;
  lastEditedTime?: string | null;
  createdTime?: string | null;
  archived?: boolean;
  inTrash?: boolean;
}): string {
  return [
    `Title: ${formatNotionPageLabel(page)}`,
    page.createdTime ? `Created: ${formatDateLabel(page.createdTime)}` : undefined,
    page.archived ? "Archived: yes" : undefined,
    page.inTrash ? "In trash: yes" : undefined,
  ].filter(Boolean).join("\n");
}

const DEFAULT_NOTION_PAGE_WINDOW_LINES = 80;
const MAX_NOTION_PAGE_WINDOW_LINES = 120;

function formatNotionPageContentText(page: {
  title?: string;
  url?: string | null;
  excerpt?: string;
  lines?: Array<{ text?: string }>;
}, options?: { startLine?: number; maxLines?: number }): string {
  const allBodyLines = (page.lines ?? [])
    .map((line) => line.text?.trim())
    .filter((line): line is string => Boolean(line));
  const requestedStartLine = Number.isFinite(options?.startLine) ? Math.trunc(options!.startLine!) : 1;
  const requestedMaxLines = Number.isFinite(options?.maxLines) ? Math.trunc(options!.maxLines!) : DEFAULT_NOTION_PAGE_WINDOW_LINES;
  const safeStartLine = Math.max(1, requestedStartLine);
  const safeMaxLines = Math.min(MAX_NOTION_PAGE_WINDOW_LINES, Math.max(1, requestedMaxLines));
  const startIndex = Math.min(allBodyLines.length, safeStartLine - 1);
  const windowLines = allBodyLines.slice(startIndex, startIndex + safeMaxLines);
  const startLabel = windowLines.length > 0 ? startIndex + 1 : 0;
  const endLabel = startIndex + windowLines.length;
  return [
    `Title: ${formatNotionPageLabel(page)}`,
    page.excerpt ? `Excerpt: ${page.excerpt}` : undefined,
    allBodyLines.length > 0
      ? `Extracted page lines: ${allBodyLines.length} total. The lines below are the current display window, not a hard retrieval limit.`
      : undefined,
    ...(windowLines.length > 0
      ? [
          `Page lines (${startLabel}-${endLabel} of ${allBodyLines.length}):`,
          ...windowLines.map((line) => `- ${line}`),
          ...(allBodyLines.length > endLabel
            ? [`More lines are available. Call notion_get_page_content again with startLine=${endLabel + 1} to continue reading this page.`]
            : []),
        ]
      : []),
  ].filter(Boolean).join("\n");
}

function formatNotionDatabaseLabel(database: {
  title?: string;
  url?: string | null;
  lastEditedTime?: string | null;
  description?: string;
}): string {
  const title = database.title?.trim() || "Untitled database";
  const linkedTitle = database.url ? `[${title}](${database.url})` : title;
  const edited = formatDateLabel(database.lastEditedTime);
  const description = database.description?.trim();
  const suffix = [edited ? `最終更新: ${edited}` : undefined, description].filter(Boolean).join(" / ");
  return suffix ? `${linkedTitle}（${suffix}）` : linkedTitle;
}

function formatNotionDatabaseSearchResultText(
  databases: Array<{
    title?: string;
    url?: string | null;
    lastEditedTime?: string | null;
    description?: string;
  }>,
): string {
  if (databases.length === 0) {
    return "No matching Notion databases found.";
  }
  return [
    "Notion databases:",
    ...databases.map((database) => `- ${formatNotionDatabaseLabel(database)}`),
  ].join("\n");
}

function formatNotionDatabaseRow(row: {
  title?: string;
  url?: string | null;
  properties?: Record<string, unknown>;
}): string {
  const title = row.title?.trim() || "Untitled row";
  const linkedTitle = row.url ? `[${title}](${row.url})` : title;
  const propertySummary = Object.entries(row.properties ?? {})
    .slice(0, 4)
    .map(([key, value]) => {
      if (Array.isArray(value)) {
        return `${key}: ${value.join(", ")}`;
      }
      if (value && typeof value === "object") {
        return `${key}: ${formatJsonDetails(value)}`;
      }
      return `${key}: ${String(value)}`;
    })
    .join(" / ");
  return propertySummary ? `${linkedTitle}（${propertySummary}）` : linkedTitle;
}

function formatNotionDatabaseQueryText(result: {
  title?: string;
  url?: string | null;
  lastEditedTime?: string | null;
  description?: string;
  properties?: Record<string, { type?: string; options?: string[] }>;
  rows: Array<{
    title?: string;
    url?: string | null;
    properties?: Record<string, unknown>;
  }>;
}): string {
  const propertySummary = Object.entries(result.properties ?? {})
    .slice(0, 6)
    .map(([name, schema]) => {
      const options = Array.isArray(schema.options) && schema.options.length > 0
        ? ` (${schema.options.join(", ")})`
        : "";
      return `- ${name}: ${schema.type ?? "unknown"}${options}`;
    });
  return [
    `Database: ${formatNotionDatabaseLabel(result)}`,
    ...(propertySummary.length > 0 ? ["Properties:", ...propertySummary] : []),
    result.rows.length > 0
      ? ["Rows:", ...result.rows.slice(0, 5).map((row) => `- ${formatNotionDatabaseRow(row)}`)].join("\n")
      : "Rows: (none)",
  ].join("\n");
}

function formatNotionDatabaseFactsText(database: {
  title?: string;
  url?: string | null;
  lastEditedTime?: string | null;
  description?: string;
  properties?: Record<string, { type?: string; options?: string[] }>;
}): string {
  const properties = Object.entries(database.properties ?? {})
    .slice(0, 12)
    .map(([name, schema]) => {
      const options = Array.isArray(schema.options) && schema.options.length > 0
        ? ` (${schema.options.join(", ")})`
        : "";
      return `- ${name}: ${schema.type ?? "unknown"}${options}`;
    });
  return [
    `Database: ${formatNotionDatabaseLabel(database)}`,
    ...(properties.length > 0 ? ["Properties:", ...properties] : []),
  ].join("\n");
}

export function createNotionReadTools(config: AppConfig): ToolDefinition[] {
  const env = buildNotionEnv(config);

  return [
    {
      name: "notion_search_pages",
      label: "Notion Search Pages",
      description: "Search Notion pages as raw facts. Read-only.",
      promptSnippet: "Use this when Notion may contain relevant specs, notes, or operating context for the current task.",
      parameters: Type.Object({
        query: Type.String({ description: "Search text." }),
        pageSize: Type.Optional(Type.Number({ description: "Maximum number of pages to return." })),
      }),
      async execute(_toolCallId, params, signal) {
        const pages = await searchNotionPages(params as { query: string; pageSize?: number }, env, signal);
        return {
          content: [{ type: "text", text: formatNotionSearchResultText(pages) }],
          details: pages,
        };
      },
    },
    {
      name: "notion_list_databases",
      label: "Notion List Databases",
      description: "List accessible Notion databases as raw facts. Read-only.",
      promptSnippet: "Use this when the user asks for Notion databases without a specific keyword or wants to browse which databases are available.",
      parameters: Type.Object({
        pageSize: Type.Optional(Type.Number({ description: "Maximum number of databases to return." })),
      }),
      async execute(_toolCallId, params, signal) {
        const databases = await listNotionDatabases(params as { pageSize?: number }, env, signal);
        return {
          content: [{ type: "text", text: formatNotionDatabaseSearchResultText(databases) }],
          details: databases,
        };
      },
    },
    {
      name: "notion_search_databases",
      label: "Notion Search Databases",
      description: "Search Notion databases as raw facts. Read-only.",
      promptSnippet: "Use this when the answer likely lives in a structured Notion database rather than a page.",
      parameters: Type.Object({
        query: Type.String({ description: "Search text." }),
        pageSize: Type.Optional(Type.Number({ description: "Maximum number of databases to return." })),
      }),
      async execute(_toolCallId, params, signal) {
        const databases = await searchNotionDatabases(params as { query: string; pageSize?: number }, env, signal);
        return {
          content: [{ type: "text", text: formatNotionDatabaseSearchResultText(databases) }],
          details: databases,
        };
      },
    },
    {
      name: "notion_get_page_facts",
      label: "Notion Get Page Facts",
      description: "Load one Notion page as raw facts. Read-only.",
      promptSnippet: "Use this after selecting a relevant Notion page from search results.",
      parameters: Type.Object({
        pageId: Type.String({ description: "Notion page ID." }),
      }),
      async execute(_toolCallId, params, signal) {
        const page = await getNotionPageFacts((params as { pageId: string }).pageId, env, signal);
        return {
          content: [{ type: "text", text: formatNotionPageFactsText(page) }],
          details: page,
        };
      },
    },
    {
      name: "notion_get_page_content",
      label: "Notion Get Page Content",
      description: "Load one Notion page and extract read-only content lines and a short excerpt.",
      promptSnippet: "Use this when metadata is not enough and you need the actual Notion page contents.",
      parameters: Type.Object({
        pageId: Type.String({ description: "Notion page ID." }),
        startLine: Type.Optional(Type.Number({ description: "Optional 1-based line number to start from when continuing through a longer page." })),
        maxLines: Type.Optional(Type.Number({ description: "Optional number of lines to show in this window. Defaults to 80 and caps at 120." })),
      }),
      async execute(_toolCallId, params, signal) {
        const typedParams = params as { pageId: string; startLine?: number; maxLines?: number };
        const page = await getNotionPageContent(typedParams.pageId, env, signal);
        return {
          content: [{ type: "text", text: formatNotionPageContentText(page, typedParams) }],
          details: page,
        };
      },
    },
    {
      name: "notion_get_database_facts",
      label: "Notion Get Database Facts",
      description: "Load one Notion database and return its schema as raw facts. Read-only.",
      promptSnippet: "Use this before filtering or sorting a Notion database so you know the property names and types.",
      parameters: Type.Object({
        databaseId: Type.String({ description: "Notion database ID." }),
      }),
      async execute(_toolCallId, params, signal) {
        const database = await getNotionDatabaseFacts((params as { databaseId: string }).databaseId, env, signal);
        return {
          content: [{ type: "text", text: formatNotionDatabaseFactsText(database) }],
          details: database,
        };
      },
    },
    {
      name: "notion_query_database",
      label: "Notion Query Database",
      description: "Load one Notion database and return a small read-only row sample.",
      promptSnippet: "Use this after selecting a relevant Notion database when you need structured rows instead of free-form page text. Call notion_get_database_facts first when you need to filter or sort by property.",
      parameters: Type.Object({
        databaseId: Type.String({ description: "Notion database ID." }),
        pageSize: Type.Optional(Type.Number({ description: "Maximum number of rows to return." })),
        filterProperty: Type.Optional(Type.String({ description: "Optional property name to filter by." })),
        filterOperator: Type.Optional(Type.String({ description: "Optional filter operator: equals | contains | on_or_after | on_or_before." })),
        filterValue: Type.Optional(Type.String({ description: "Optional filter value, serialized as text." })),
        sortProperty: Type.Optional(Type.String({ description: "Optional property name to sort by." })),
        sortDirection: Type.Optional(Type.String({ description: "Optional sort direction: ascending | descending." })),
      }),
      async execute(_toolCallId, params, signal) {
        const result = await queryNotionDatabase(params as {
          databaseId: string;
          pageSize?: number;
          filterProperty?: string;
          filterOperator?: "equals" | "contains" | "on_or_after" | "on_or_before";
          filterValue?: string;
          sortProperty?: string;
          sortDirection?: "ascending" | "descending";
        }, env, signal);
        return {
          content: [{ type: "text", text: formatNotionDatabaseQueryText(result) }],
          details: result,
        };
      },
    },
  ];
}
