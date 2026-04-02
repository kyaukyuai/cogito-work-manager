import { Type } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AppConfig } from "../config.js";
import { getRecentChannelContext, getSlackThreadContext } from "../slack-context.js";
import {
  listThreadAttachmentsForMessage,
  readThreadAttachmentForMessage,
  type ThreadAttachmentReadResult,
  type ThreadAttachmentSummary,
} from "../../gateways/slack-attachments/index.js";

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

export function createSlackContextTools(config: AppConfig): ToolDefinition[] {
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

export function createSlackAttachmentTools(config: AppConfig): ToolDefinition[] {
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
