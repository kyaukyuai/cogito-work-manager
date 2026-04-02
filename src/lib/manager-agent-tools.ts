import { Type } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AppConfig } from "./config.js";
import type { ManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import {
  getNotionDatabaseFacts,
  getNotionPageContent,
  getNotionPageFacts,
  listNotionDatabases,
  queryNotionDatabase,
  searchNotionDatabases,
  searchNotionPages,
  type NotionCommandEnv,
} from "./notion.js";
import {
  getUnifiedSchedule,
  listUnifiedSchedules,
  type SchedulerScheduleView,
} from "./scheduler-management.js";
import { getRecentChannelContext, getSlackThreadContext } from "./slack-context.js";
import {
  listThreadAttachmentsForMessage,
  readThreadAttachmentForMessage,
  type ThreadAttachmentReadResult,
  type ThreadAttachmentSummary,
} from "../gateways/slack-attachments/index.js";
import {
  buildSystemPaths,
  readAgendaTemplate,
  readHeartbeatInstructions,
} from "./system-workspace.js";
import { webFetchUrl, webSearchFetch } from "./web-research.js";
import { createWorkgraphReadTools } from "./workgraph-tools.js";
import { analyzeOwnerMap } from "./owner-map-diagnostics.js";
import type { OwnerMap } from "../state/manager-state-contract.js";
import { createManagerInternalTools } from "./manager-agent-tools/internal-tools.js";
import {
  createLinearReadTools,
  type ManagerAgentToolHelpers,
} from "./manager-agent-tools/linear-read-tools.js";
import { createManagerProposalTools } from "./manager-agent-tools/proposal-tools.js";

function buildNotionEnv(config: AppConfig): NotionCommandEnv {
  return {
    ...process.env,
    NOTION_API_TOKEN: config.notionApiToken,
  };
}

function formatJsonDetails(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function formatAttachmentSummary(summary: ThreadAttachmentSummary): string {
  return [
    `- ${summary.attachmentId}: ${summary.name}`,
    `  kind: ${summary.kind}`,
    `  mimeType: ${summary.mimeType ?? "(none)"}`,
    `  extractionStatus: ${summary.extractionStatus}`,
    `  transcriptionStatus: ${summary.transcriptionStatus}`,
    typeof summary.durationSec === "number" ? `  durationSec: ${summary.durationSec}` : undefined,
    summary.previewText ? `  preview: ${summary.previewText}` : undefined,
  ].filter(Boolean).join("\n");
}

function formatThreadAttachmentListText(summaries: ThreadAttachmentSummary[]): string {
  if (summaries.length === 0) {
    return "No stored thread attachments found.";
  }
  return [
    "Thread attachments:",
    ...summaries.map((summary) => formatAttachmentSummary(summary)),
  ].join("\n");
}

function formatThreadAttachmentReadText(result: ThreadAttachmentReadResult): string {
  const lines = [
    `Attachment: ${result.entry.name}`,
    `attachmentId: ${result.entry.attachmentId}`,
    `kind: ${result.entry.kind}`,
    `mimeType: ${result.entry.mimeType ?? "(none)"}`,
    `extractionStatus: ${result.entry.extraction.status}`,
    `transcriptionStatus: ${result.entry.transcription.status}`,
    typeof result.entry.durationSec === "number" ? `durationSec: ${result.entry.durationSec}` : undefined,
    result.note ? `note: ${result.note}` : undefined,
  ].filter(Boolean);
  if (!result.textWindow) {
    return [
      ...lines,
      `Readable text unavailable: ${result.note ?? result.entry.transcription.errorSummary ?? result.entry.extraction.errorSummary ?? "No readable text is available."}`,
    ].join("\n");
  }
  return [
    ...lines,
    `Lines (${result.startLine}-${result.endLine} of ${result.totalLines}):`,
    result.textWindow,
    ...(result.moreLinesAvailable
      ? [`More lines are available. Call slack_read_thread_attachment again with startLine=${result.endLine + 1} to continue.`]
      : []),
  ].join("\n");
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

function formatScheduleLabel(view: SchedulerScheduleView): string {
  if (view.kind === "custom-job") {
    return view.id;
  }
  if (view.kind === "morning-review") return "朝レビュー";
  if (view.kind === "evening-review") return "夕方レビュー";
  if (view.kind === "weekly-review") return "週次レビュー";
  return "heartbeat";
}

function formatScheduleTiming(view: SchedulerScheduleView): string {
  if (view.scheduleType === "heartbeat") {
    return `${view.intervalMin ?? 0}分ごと`;
  }
  if (view.scheduleType === "daily") {
    return `毎日 ${view.time}`;
  }
  if (view.scheduleType === "weekly") {
    return `毎週 ${view.weekday} ${view.time}`;
  }
  if (view.scheduleType === "every") {
    return `${view.everySec}秒ごと`;
  }
  return view.at ?? "単発実行";
}

function formatScheduleViewText(view: SchedulerScheduleView): string {
  return [
    `${formatScheduleLabel(view)} (${view.id})`,
    `- enabled: ${view.enabled ? "yes" : "no"}`,
    `- source: ${view.source}`,
    `- channel: ${view.channelLabel} (${view.channelId})`,
    `- schedule: ${formatScheduleTiming(view)}`,
    `- prompt: ${view.prompt}`,
    view.nextRunAt ? `- nextRunAt: ${view.nextRunAt}` : undefined,
    view.lastRunAt ? `- lastRunAt: ${view.lastRunAt}` : undefined,
    view.lastStatus ? `- lastStatus: ${view.lastStatus}` : undefined,
    view.lastError ? `- lastError: ${view.lastError}` : undefined,
  ].filter(Boolean).join("\n");
}

function createNotionReadTools(config: AppConfig): ToolDefinition[] {
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

function createSchedulerReadTools(
  config: AppConfig,
  repositories: Pick<ManagerRepositories, "policy">,
): ToolDefinition[] {
  const systemPaths = buildSystemPaths(config.workspaceDir);

  return [
    {
      name: "scheduler_list_schedules",
      label: "Scheduler List Schedules",
      description: "List unified scheduler facts across custom jobs and built-in schedules.",
      promptSnippet: "Use this when the user asks to list or inspect schedules from Slack.",
      parameters: Type.Object({
        channelId: Type.Optional(Type.String({ description: "Optional Slack channel ID filter. Defaults to the control room channel." })),
      }),
      async execute(_toolCallId, params) {
        const policy = await repositories.policy.load();
        const schedules = await listUnifiedSchedules(systemPaths, policy, {
          channelId: (params as { channelId?: string }).channelId,
        });
        return {
          content: [{ type: "text", text: schedules.length > 0 ? schedules.map(formatScheduleViewText).join("\n\n") : "No schedules found." }],
          details: schedules,
        };
      },
    },
    {
      name: "scheduler_get_schedule",
      label: "Scheduler Get Schedule",
      description: "Get one unified scheduler fact by job ID or built-in schedule ID.",
      promptSnippet: "Use this when the user asks about one specific schedule like manager-review-evening or heartbeat.",
      parameters: Type.Object({
        id: Type.String({ description: "Custom job id or built-in schedule id such as manager-review-evening, morning-review, or heartbeat." }),
      }),
      async execute(_toolCallId, params) {
        const policy = await repositories.policy.load();
        const schedule = await getUnifiedSchedule(systemPaths, policy, (params as { id: string }).id);
        return {
          content: [{ type: "text", text: schedule ? formatScheduleViewText(schedule) : "Schedule not found." }],
          details: schedule,
        };
      },
    },
  ];
}

function formatOwnerMapText(ownerMap: OwnerMap): string {
  const diagnostics = analyzeOwnerMap(ownerMap);
  return [
    "Owner map summary:",
    `- defaultOwner: ${ownerMap.defaultOwner}`,
    `- entries: ${ownerMap.entries.map((entry) => entry.id).join(", ") || "(none)"}`,
    `- duplicateSlackMappings: ${diagnostics.duplicateSlackUserIds.length > 0
      ? diagnostics.duplicateSlackUserIds
        .map((entry) => `${entry.slackUserId} -> ${entry.entryIds.join(", ")}`)
        .join(" | ")
      : "(none)"}`,
    `- unmappedEntries: ${diagnostics.unmappedSlackEntries.length > 0
      ? diagnostics.unmappedSlackEntries.map((entry) => entry.id).join(", ")
      : "(none)"}`,
    "",
    "Owner map JSON:",
    formatJsonDetails(ownerMap),
  ].join("\n");
}

function createWorkspaceReadTools(
  config: AppConfig,
  repositories: Pick<ManagerRepositories, "ownerMap">,
): ToolDefinition[] {
  const systemPaths = buildSystemPaths(config.workspaceDir);

  return [
    {
      name: "workspace_get_agenda_template",
      label: "Workspace Get Agenda Template",
      description: "Read the current AGENDA_TEMPLATE.md contents. Read-only.",
      promptSnippet: "Use this before proposing any AGENDA_TEMPLATE.md update or replacement so you can preserve the intended structure.",
      parameters: Type.Object({}),
      async execute() {
        const content = await readAgendaTemplate(systemPaths);
        return {
          content: [{ type: "text", text: content ?? "(empty agenda template)" }],
          details: { content: content ?? "" },
        };
      },
    },
    {
      name: "workspace_get_heartbeat_prompt",
      label: "Workspace Get HEARTBEAT Prompt",
      description: "Read the current HEARTBEAT.md contents. Read-only.",
      promptSnippet: "Use this before proposing any HEARTBEAT.md update or replacement so you inspect the current prompt first.",
      parameters: Type.Object({}),
      async execute() {
        const content = await readHeartbeatInstructions(systemPaths);
        return {
          content: [{ type: "text", text: content ?? "(empty heartbeat prompt)" }],
          details: { content: content ?? "" },
        };
      },
    },
    {
      name: "workspace_get_owner_map",
      label: "Workspace Get Owner Map",
      description: "Read owner-map.json with both raw JSON and duplicate or unmapped-entry diagnostics. Read-only.",
      promptSnippet: "Use this before proposing owner-map changes so you inspect the current default owner and entries first.",
      parameters: Type.Object({}),
      async execute() {
        const ownerMap = await repositories.ownerMap.load();
        const diagnostics = analyzeOwnerMap(ownerMap);
        return {
          content: [{ type: "text", text: formatOwnerMapText(ownerMap) }],
          details: {
            ownerMap,
            summary: {
              defaultOwner: ownerMap.defaultOwner,
              entryIds: ownerMap.entries.map((entry) => entry.id),
              duplicateSlackMappings: diagnostics.duplicateSlackUserIds,
              unmappedEntryIds: diagnostics.unmappedSlackEntries.map((entry) => entry.id),
            },
          },
        };
      },
    },
  ];
}

function createSlackContextTools(config: AppConfig): ToolDefinition[] {
  return [
    {
      name: "slack_get_thread_context",
      label: "Slack Get Thread Context",
      description: "Read the stored thread log for a Slack thread.",
      promptSnippet: "Use this for continuation, recent context, and response drafting.",
      parameters: Type.Object({
        channelId: Type.String({ description: "Slack channel ID." }),
        threadTs: Type.String({ description: "Slack root thread timestamp." }),
        limit: Type.Optional(Type.Number({ description: "Maximum number of log entries." })),
      }),
      async execute(_toolCallId, params) {
        const typedParams = params as { channelId: string; threadTs: string; limit?: number };
        const context = await getSlackThreadContext(config.workspaceDir, typedParams.channelId, typedParams.threadTs, typedParams.limit);
        return {
          content: [{ type: "text", text: context.entries.length > 0 ? formatJsonDetails(context.entries) : "No stored thread context found." }],
          details: context,
        };
      },
    },
    {
      name: "slack_get_recent_channel_context",
      label: "Slack Get Recent Channel Context",
      description: "Read recent stored thread summaries for a Slack channel.",
      promptSnippet: "Use this sparingly when nearby channel context changes the answer.",
      parameters: Type.Object({
        channelId: Type.String({ description: "Slack channel ID." }),
        limit: Type.Optional(Type.Number({ description: "Maximum number of threads to inspect." })),
      }),
      async execute(_toolCallId, params) {
        const typedParams = params as { channelId: string; limit?: number };
        const contexts = await getRecentChannelContext(config.workspaceDir, typedParams.channelId, typedParams.limit);
        return {
          content: [{ type: "text", text: contexts.length > 0 ? formatJsonDetails(contexts) : "No recent channel context found." }],
          details: contexts,
        };
      },
    },
  ];
}

function createSlackAttachmentTools(config: AppConfig): ToolDefinition[] {
  return [
    {
      name: "slack_list_thread_attachments",
      label: "Slack List Thread Attachments",
      description: "Read the stored attachment inventory for a Slack thread or the latest message in that thread.",
      promptSnippet: "Use this when the latest message or thread includes files such as PDFs, contract docs, videos, or reference material.",
      parameters: Type.Object({
        channelId: Type.String({ description: "Slack channel ID." }),
        threadTs: Type.String({ description: "Slack root thread timestamp." }),
        sourceMessageTs: Type.Optional(Type.String({ description: "Optional source message timestamp to narrow to attachments from one message." })),
      }),
      async execute(_toolCallId, params) {
        const typedParams = params as { channelId: string; threadTs: string; sourceMessageTs?: string };
        const summaries = await listThreadAttachmentsForMessage({
          workspaceDir: config.workspaceDir,
          channelId: typedParams.channelId,
          rootThreadTs: typedParams.threadTs,
          sourceMessageTs: typedParams.sourceMessageTs,
        });
        return {
          content: [{ type: "text", text: formatThreadAttachmentListText(summaries) }],
          details: summaries,
        };
      },
    },
    {
      name: "slack_read_thread_attachment",
      label: "Slack Read Thread Attachment",
      description: "Read extracted text from a document attachment or transcript lines from an audio/video attachment.",
      promptSnippet: "Use this after slack_list_thread_attachments to inspect attachment contents. For long attachments, continue reading with startLine.",
      parameters: Type.Object({
        channelId: Type.String({ description: "Slack channel ID." }),
        threadTs: Type.String({ description: "Slack root thread timestamp." }),
        attachmentId: Type.String({ description: "Attachment ID returned by slack_list_thread_attachments." }),
        startLine: Type.Optional(Type.Number({ description: "1-based starting line for continuation reads." })),
        maxLines: Type.Optional(Type.Number({ description: "Maximum number of lines to return." })),
      }),
      async execute(_toolCallId, params) {
        const typedParams = params as {
          channelId: string;
          threadTs: string;
          attachmentId: string;
          startLine?: number;
          maxLines?: number;
        };
        const result = await readThreadAttachmentForMessage({
          config,
          channelId: typedParams.channelId,
          rootThreadTs: typedParams.threadTs,
          attachmentId: typedParams.attachmentId,
          startLine: typedParams.startLine,
          maxLines: typedParams.maxLines,
        });
        return {
          content: [{ type: "text", text: formatThreadAttachmentReadText(result) }],
          details: result,
        };
      },
    },
  ];
}

function createWebReadTools(): ToolDefinition[] {
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

export function createManagerAgentTools(
  config: AppConfig,
  repositories: Pick<ManagerRepositories, "policy" | "workgraph" | "ownerMap">,
  helpers?: ManagerAgentToolHelpers,
): ToolDefinition[] {
  return [
    ...createManagerInternalTools(),
    ...createLinearReadTools(config, helpers),
    ...createSchedulerReadTools(config, repositories),
    ...createWorkspaceReadTools(config, repositories),
    ...createNotionReadTools(config),
    ...createSlackContextTools(config),
    ...createSlackAttachmentTools(config),
    ...createWorkgraphReadTools(repositories),
    ...createWebReadTools(),
    ...createManagerProposalTools(),
  ];
}
