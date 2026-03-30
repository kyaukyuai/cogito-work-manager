import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import type { WebClient } from "@slack/web-api";
import mammoth from "mammoth";
import OpenAI from "openai";
import type { AppConfig } from "../../lib/config.js";
import { buildThreadPaths, ensureThreadWorkspace, type AttachmentRecord, type ThreadPaths } from "../../lib/thread-workspace.js";
import type { RawSlackMessageEvent } from "../../lib/slack.js";
import {
  buildAttachmentRecord,
  buildThreadAttachmentArtifactsDir,
  buildThreadAttachmentSummary,
  findThreadAttachmentEntry,
  loadThreadAttachmentCatalog,
  saveThreadAttachmentCatalog,
  type ThreadAttachmentCatalog,
  type ThreadAttachmentCatalogEntry,
  type ThreadAttachmentKind,
  type ThreadAttachmentSummary,
} from "./catalog.js";

const execFileAsync = promisify(execFile);

const ATTACHMENT_PREVIEW_MAX_CHARS = 280;
export const DEFAULT_ATTACHMENT_WINDOW_LINES = 80;
export const MAX_ATTACHMENT_WINDOW_LINES = 120;
export const AUDIO_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const MAX_TRANSCRIPTION_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_TRANSCRIPTION_DURATION_SEC = 30 * 60;
const ATTACHMENT_HISTORY_RETRY_DELAY_MS = 500;

type SlackAttachmentMetadata = NonNullable<RawSlackMessageEvent["files"]>[number];

export interface AttachmentIngestDiagnostic {
  level: "info" | "warn";
  message: string;
}

export interface IngestThreadAttachmentsArgs {
  paths: ThreadPaths;
  slackBotToken: string;
  webClient: Pick<WebClient, "conversations">;
  channelId: string;
  rootThreadTs: string;
  messageTs: string;
  subtype?: string;
  files?: RawSlackMessageEvent["files"];
}

export interface IngestThreadAttachmentsResult {
  attachments: AttachmentRecord[];
  summaries: ThreadAttachmentSummary[];
  usedHydratedSlackFiles: boolean;
  diagnostics?: AttachmentIngestDiagnostic[];
}

export interface ThreadAttachmentReadResult {
  entry: ThreadAttachmentCatalogEntry;
  startLine: number;
  endLine: number;
  totalLines: number;
  textWindow: string;
  moreLinesAvailable: boolean;
  note?: string;
}

export interface ReadThreadAttachmentArgs {
  paths: ThreadPaths;
  attachmentId: string;
  openaiApiKey?: string;
  startLine?: number;
  maxLines?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeArtifactName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "attachment";
}

function buildAttachmentId(file: SlackAttachmentMetadata, messageTs: string): string {
  const preferred = file.id ? `${messageTs}-${file.id}` : `${messageTs}-${basename(file.name)}`;
  return sanitizeArtifactName(preferred);
}

function isTextLikeMimeType(mimeType: string | undefined): boolean {
  return mimeType?.startsWith("text/") === true
    || mimeType === "application/json"
    || mimeType === "application/csv"
    || mimeType === "text/csv";
}

function inferAttachmentKind(name: string, mimeType?: string): ThreadAttachmentKind {
  const extension = extname(name).toLowerCase();
  if (
    mimeType === "application/pdf"
    || mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    || isTextLikeMimeType(mimeType)
    || [".pdf", ".docx", ".txt", ".md", ".csv", ".json"].includes(extension)
  ) {
    return "document";
  }
  if (mimeType?.startsWith("audio/") || [".mp3", ".m4a", ".wav", ".webm"].includes(extension)) {
    return "audio";
  }
  if (mimeType?.startsWith("video/") || [".mp4", ".mov", ".mkv", ".avi"].includes(extension)) {
    return "video";
  }
  return "other";
}

function buildPreviewText(text: string): string | undefined {
  const normalized = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!normalized) return undefined;
  return normalized.length > ATTACHMENT_PREVIEW_MAX_CHARS
    ? `${normalized.slice(0, ATTACHMENT_PREVIEW_MAX_CHARS).trimEnd()}...`
    : normalized;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function hasDownloadableSlackFileUrl(file: SlackAttachmentMetadata): boolean {
  return typeof file.url_private_download === "string" || typeof file.url_private === "string";
}

function normalizeSlackAttachmentMetadata(file: {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  url_private_download?: string;
  url_private?: string;
}): SlackAttachmentMetadata {
  return {
    id: file.id,
    name: file.name ?? file.title ?? file.id ?? "attachment",
    mimetype: file.mimetype,
    filetype: file.filetype,
    url_private_download: file.url_private_download,
    url_private: file.url_private,
  };
}

async function runCommand(command: string, args: string[]): Promise<string> {
  const result = await execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return result.stdout;
}

async function safeStatSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function safeStatMtime(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

async function loadSlackMessageFilesFromThreadHistory(
  args: Pick<IngestThreadAttachmentsArgs, "webClient" | "channelId" | "rootThreadTs" | "messageTs">,
): Promise<SlackAttachmentMetadata[]> {
  const result = await args.webClient.conversations.replies({
    channel: args.channelId,
    ts: args.rootThreadTs,
    inclusive: true,
    limit: 200,
  });
  const matched = result.messages?.find((message) => message.ts === args.messageTs);
  return (matched?.files ?? []).map((file) => normalizeSlackAttachmentMetadata(file));
}

async function hydrateSlackMessageFiles(
  args: Pick<IngestThreadAttachmentsArgs, "webClient" | "channelId" | "rootThreadTs" | "messageTs" | "files">,
  options?: { forceThreadHistory?: boolean },
): Promise<{ files: SlackAttachmentMetadata[]; usedHydratedSlackFiles: boolean; diagnostics: AttachmentIngestDiagnostic[] }> {
  const diagnostics: AttachmentIngestDiagnostic[] = [];
  const eventFiles = args.files ?? [];
  const downloadReadyEventFiles = eventFiles.filter((file) => hasDownloadableSlackFileUrl(file));
  const eventFilesAreDownloadReady = eventFiles.length > 0 && eventFiles.every((file) => hasDownloadableSlackFileUrl(file));

  if (!options?.forceThreadHistory && eventFilesAreDownloadReady) {
    return {
      files: eventFiles,
      usedHydratedSlackFiles: false,
      diagnostics,
    };
  }

  if (!options?.forceThreadHistory && eventFiles.length > 0) {
    diagnostics.push({
      level: "info",
      message: "Attachment metadata incomplete on Slack event",
    });
  }

  // Slack can omit both `files` and `subtype=file_share` on threaded replies even
  // when the exact source message has files in conversations.replies history.
  let files = await loadSlackMessageFilesFromThreadHistory(args);
  if (files.length === 0) {
    diagnostics.push({
      level: "info",
      message: "Attachment history hydration returned no files",
    });
    await delay(ATTACHMENT_HISTORY_RETRY_DELAY_MS);
    files = await loadSlackMessageFilesFromThreadHistory(args);
    if (files.length > 0) {
      diagnostics.push({
        level: "info",
        message: "Attachment history hydration retry recovered files",
      });
    } else {
      if (!options?.forceThreadHistory && downloadReadyEventFiles.length > 0) {
        diagnostics.push({
          level: "info",
          message: "Attachment history hydration returned no files after retry; using download-ready Slack event attachments",
        });
        return {
          files: downloadReadyEventFiles,
          usedHydratedSlackFiles: false,
          diagnostics,
        };
      }
      diagnostics.push({
        level: "warn",
        message: "Attachment history hydration returned no files after retry",
      });
    }
  }
  return {
    files,
    usedHydratedSlackFiles: files.length > 0,
    diagnostics,
  };
}

async function downloadSlackAttachments(
  token: string,
  attachmentsDir: string,
  files: SlackAttachmentMetadata[],
): Promise<{
  downloaded: Array<{ file: SlackAttachmentMetadata; record: AttachmentRecord & { sourceAttachmentId?: string } }>;
  skippedFiles: SlackAttachmentMetadata[];
}> {
  if (files.length === 0) {
    return {
      downloaded: [],
      skippedFiles: [],
    };
  }

  await mkdir(attachmentsDir, { recursive: true });
  const downloaded: Array<{ file: SlackAttachmentMetadata; record: AttachmentRecord & { sourceAttachmentId?: string } }> = [];
  const skippedFiles: SlackAttachmentMetadata[] = [];

  for (const file of files) {
    const url = file.url_private_download ?? file.url_private;
    if (!url) {
      skippedFiles.push(file);
      continue;
    }

    const safeName = `${file.id ?? Date.now()}-${basename(file.name)}`;
    const storedPath = join(attachmentsDir, safeName);
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to download Slack attachment: ${response.status} ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(storedPath, buffer);
    downloaded.push({
      file,
      record: {
        sourceAttachmentId: file.id,
        id: file.id,
        name: file.name,
        mimeType: file.mimetype,
        storedPath,
      },
    });
  }

  return {
    downloaded,
    skippedFiles,
  };
}

async function writeDerivedTextArtifact(
  paths: ThreadPaths,
  attachmentId: string,
  suffix: string,
  text: string,
): Promise<{ artifactPath: string; lineCount: number; previewText?: string }> {
  const artifactsDir = buildThreadAttachmentArtifactsDir(paths);
  await mkdir(artifactsDir, { recursive: true });
  const artifactPath = join(artifactsDir, `${sanitizeArtifactName(attachmentId)}.${suffix}.txt`);
  await writeFile(artifactPath, text, "utf8");
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    artifactPath,
    lineCount: lines.length,
    previewText: buildPreviewText(text),
  };
}

async function extractDocumentText(entry: ThreadAttachmentCatalogEntry): Promise<string> {
  const extension = extname(entry.name).toLowerCase();
  if (entry.mimeType === "application/pdf" || extension === ".pdf") {
    return runCommand("pdftotext", ["-layout", entry.storedPath, "-"]);
  }
  if (
    entry.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    || extension === ".docx"
  ) {
    const extracted = await mammoth.extractRawText({ path: entry.storedPath });
    return extracted.value;
  }
  return readFile(entry.storedPath, "utf8");
}

async function probeMediaDuration(storedPath: string): Promise<number | undefined> {
  try {
    const raw = await runCommand("ffprobe", [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      storedPath,
    ]);
    const parsed = JSON.parse(raw) as { format?: { duration?: string } };
    const duration = Number(parsed.format?.duration);
    return Number.isFinite(duration) ? duration : undefined;
  } catch {
    return undefined;
  }
}

async function enrichAttachmentEntry(
  paths: ThreadPaths,
  entry: ThreadAttachmentCatalogEntry,
): Promise<ThreadAttachmentCatalogEntry> {
  if (entry.kind === "document") {
    try {
      const extractedText = await extractDocumentText(entry);
      const artifact = await writeDerivedTextArtifact(paths, entry.attachmentId, "extracted", extractedText);
      return {
        ...entry,
        previewText: artifact.previewText,
        updatedAt: nowIso(),
        extraction: {
          status: "completed",
          artifactPath: artifact.artifactPath,
          lineCount: artifact.lineCount,
        },
      };
    } catch (error) {
      return {
        ...entry,
        updatedAt: nowIso(),
        extraction: {
          status: "failed",
          errorSummary: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  if (entry.kind === "audio" || entry.kind === "video") {
    const durationSec = entry.durationSec ?? await probeMediaDuration(entry.storedPath);
    return {
      ...entry,
      durationSec,
      updatedAt: nowIso(),
    };
  }

  return {
    ...entry,
    updatedAt: nowIso(),
  };
}

function toCatalogEntry(
  file: SlackAttachmentMetadata,
  downloaded: AttachmentRecord & { sourceAttachmentId?: string },
  sourceMessageTs: string,
  existing?: ThreadAttachmentCatalogEntry,
): ThreadAttachmentCatalogEntry {
  const attachmentId = existing?.attachmentId ?? buildAttachmentId(file, sourceMessageTs);
  const kind = inferAttachmentKind(file.name, file.mimetype);
  const createdAt = existing?.createdAt ?? nowIso();
  return {
    attachmentId,
    sourceAttachmentId: file.id,
    sourceMessageTs,
    name: downloaded.name,
    mimeType: downloaded.mimeType,
    storedPath: downloaded.storedPath,
    kind,
    previewText: existing?.previewText,
    durationSec: existing?.durationSec,
    createdAt,
    updatedAt: nowIso(),
    extraction: existing?.extraction ?? {
      status: kind === "document" ? "pending" : "not_applicable",
    },
    transcription: existing?.transcription ?? {
      status: kind === "audio" || kind === "video" ? "pending" : "not_applicable",
    },
  };
}

export async function ingestThreadAttachments(
  args: IngestThreadAttachmentsArgs,
): Promise<IngestThreadAttachmentsResult> {
  await ensureThreadWorkspace(args.paths);
  let hydrated = await hydrateSlackMessageFiles(args);
  const diagnostics = [...hydrated.diagnostics];
  let downloadResult = await downloadSlackAttachments(args.slackBotToken, args.paths.attachmentsDir, hydrated.files);
  if (downloadResult.skippedFiles.length > 0) {
    diagnostics.push({
      level: "info",
      message: "Attachment download skipped because no private URL",
    });
  }
  if (hydrated.files.length > 0 && downloadResult.downloaded.length === 0 && !hydrated.usedHydratedSlackFiles) {
    diagnostics.push({
      level: "info",
      message: "Attachment download produced no files from Slack event metadata; retrying thread history hydration",
    });
    hydrated = await hydrateSlackMessageFiles(args, { forceThreadHistory: true });
    diagnostics.push(...hydrated.diagnostics);
    downloadResult = await downloadSlackAttachments(args.slackBotToken, args.paths.attachmentsDir, hydrated.files);
    if (downloadResult.skippedFiles.length > 0) {
      diagnostics.push({
        level: "info",
        message: "Attachment download skipped because no private URL",
      });
    }
  }
  const existingCatalog = await loadThreadAttachmentCatalog(args.paths);

  const entries = await Promise.all(downloadResult.downloaded.map(async ({ file, record }) => {
    const existing = existingCatalog.entries.find((entry) => (
      (file.id && entry.sourceAttachmentId === file.id)
      || entry.attachmentId === buildAttachmentId(file, args.messageTs)
    ));
    const baseEntry = toCatalogEntry(file, record, args.messageTs, existing);
    return enrichAttachmentEntry(args.paths, baseEntry);
  }));

  const mergedCatalog = entries.length > 0
    ? {
        entries: [
          ...existingCatalog.entries.filter((entry) => !entries.some((candidate) => candidate.attachmentId === entry.attachmentId)),
          ...entries,
        ].sort((left, right) => (
          left.sourceMessageTs.localeCompare(right.sourceMessageTs)
          || left.name.localeCompare(right.name)
        )),
      }
    : existingCatalog;
  if (entries.length > 0) {
    await saveThreadAttachmentCatalog(args.paths, mergedCatalog);
  }

  return {
    attachments: entries.map((entry) => buildAttachmentRecord(entry)),
    summaries: entries.map((entry) => buildThreadAttachmentSummary(entry)),
    usedHydratedSlackFiles: hydrated.usedHydratedSlackFiles,
    diagnostics,
  };
}

export async function listThreadAttachments(
  paths: ThreadPaths,
  sourceMessageTs?: string,
): Promise<ThreadAttachmentSummary[]> {
  const catalog = await loadThreadAttachmentCatalog(paths);
  return catalog.entries
    .filter((entry) => !sourceMessageTs || entry.sourceMessageTs === sourceMessageTs)
    .map((entry) => buildThreadAttachmentSummary(entry));
}

function buildUnavailableReadResult(entry: ThreadAttachmentCatalogEntry, note: string): ThreadAttachmentReadResult {
  return {
    entry,
    startLine: 0,
    endLine: 0,
    totalLines: 0,
    textWindow: "",
    moreLinesAvailable: false,
    note,
  };
}

function buildTextWindowResult(
  entry: ThreadAttachmentCatalogEntry,
  text: string,
  startLine?: number,
  maxLines?: number,
  note?: string,
): ThreadAttachmentReadResult {
  const allLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const requestedStart = Number.isFinite(startLine) ? Math.trunc(startLine as number) : 1;
  const requestedMax = Number.isFinite(maxLines) ? Math.trunc(maxLines as number) : DEFAULT_ATTACHMENT_WINDOW_LINES;
  const safeStart = Math.max(1, requestedStart);
  const safeMax = Math.min(MAX_ATTACHMENT_WINDOW_LINES, Math.max(1, requestedMax));
  const startIndex = Math.min(allLines.length, safeStart - 1);
  const lines = allLines.slice(startIndex, startIndex + safeMax);
  const start = lines.length > 0 ? startIndex + 1 : 0;
  const end = startIndex + lines.length;
  return {
    entry,
    startLine: start,
    endLine: end,
    totalLines: allLines.length,
    textWindow: lines.join("\n"),
    moreLinesAvailable: allLines.length > end,
    note,
  };
}

async function ensureDocumentArtifact(
  paths: ThreadPaths,
  entry: ThreadAttachmentCatalogEntry,
): Promise<ThreadAttachmentCatalogEntry> {
  if (entry.extraction.status === "completed" && entry.extraction.artifactPath) {
    return entry;
  }

  const nextEntry = await enrichAttachmentEntry(paths, {
    ...entry,
    extraction: {
      status: "pending",
    },
  });
  const catalog = await loadThreadAttachmentCatalog(paths);
  await saveThreadAttachmentCatalog(paths, {
    entries: catalog.entries.map((candidate) => (
      candidate.attachmentId === nextEntry.attachmentId ? nextEntry : candidate
    )),
  });
  return nextEntry;
}

async function extractAudioTrack(
  paths: ThreadPaths,
  entry: ThreadAttachmentCatalogEntry,
): Promise<string> {
  const artifactsDir = buildThreadAttachmentArtifactsDir(paths);
  await mkdir(artifactsDir, { recursive: true });
  const audioPath = join(artifactsDir, `${sanitizeArtifactName(entry.attachmentId)}.transcription-source.mp3`);
  const existingSize = await safeStatSize(audioPath);
  if (existingSize > 0) {
    return audioPath;
  }

  await execFileAsync("ffmpeg", [
    "-y",
    "-i",
    entry.storedPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-codec:a",
    "libmp3lame",
    "-b:a",
    "96k",
    audioPath,
  ], {
    maxBuffer: 20 * 1024 * 1024,
  });
  return audioPath;
}

async function splitAudioIntoChunks(
  audioPath: string,
  durationSec: number | undefined,
): Promise<string[]> {
  const totalBytes = await safeStatSize(audioPath);
  if (totalBytes <= MAX_TRANSCRIPTION_AUDIO_BYTES) {
    return [audioPath];
  }

  const safeDuration = durationSec && durationSec > 0 ? durationSec : undefined;
  if (!safeDuration) {
    return [audioPath];
  }

  const chunkCount = Math.max(2, Math.ceil(totalBytes / MAX_TRANSCRIPTION_AUDIO_BYTES));
  const segmentDurationSec = Math.max(30, Math.ceil(safeDuration / chunkCount));
  const chunkPattern = join(tmpdir(), `${sanitizeArtifactName(basename(audioPath, ".mp3"))}-%03d.mp3`);
  await execFileAsync("ffmpeg", [
    "-y",
    "-i",
    audioPath,
    "-f",
    "segment",
    "-segment_time",
    String(segmentDurationSec),
    "-reset_timestamps",
    "1",
    "-codec",
    "copy",
    chunkPattern,
  ], {
    maxBuffer: 20 * 1024 * 1024,
  });

  const chunks: string[] = [];
  for (let index = 0; index < 100; index += 1) {
    const chunkPath = chunkPattern.replace("%03d", String(index).padStart(3, "0"));
    const chunkSize = await safeStatSize(chunkPath);
    if (chunkSize <= 0) {
      continue;
    }
    chunks.push(chunkPath);
  }
  return chunks.length > 0 ? chunks : [audioPath];
}

async function transcribeAudioChunks(
  audioPaths: string[],
  apiKey: string,
): Promise<string> {
  const client = new OpenAI({ apiKey });
  const transcripts: string[] = [];
  for (const audioPath of audioPaths) {
    const transcription = await client.audio.transcriptions.create({
      file: createReadStream(audioPath),
      model: AUDIO_TRANSCRIPTION_MODEL,
      response_format: "text",
    });
    transcripts.push(transcription);
  }
  return transcripts.map((part) => part.trim()).filter(Boolean).join("\n\n");
}

async function ensureTranscriptArtifact(
  paths: ThreadPaths,
  entry: ThreadAttachmentCatalogEntry,
  openaiApiKey: string | undefined,
): Promise<ThreadAttachmentCatalogEntry> {
  if (entry.transcription.status === "completed" && entry.transcription.artifactPath) {
    return entry;
  }
  if (!openaiApiKey) {
    const unavailableEntry = {
      ...entry,
      updatedAt: nowIso(),
      transcription: {
        status: "unavailable" as const,
        errorSummary: "OPENAI_API_KEY is not configured for audio/video transcription.",
      },
    };
    const catalog = await loadThreadAttachmentCatalog(paths);
    await saveThreadAttachmentCatalog(paths, {
      entries: catalog.entries.map((candidate) => (
        candidate.attachmentId === unavailableEntry.attachmentId ? unavailableEntry : candidate
      )),
    });
    return unavailableEntry;
  }

  const durationSec = entry.durationSec ?? await probeMediaDuration(entry.storedPath);
  if (durationSec && durationSec > MAX_TRANSCRIPTION_DURATION_SEC) {
    const unavailableEntry = {
      ...entry,
      durationSec,
      updatedAt: nowIso(),
      transcription: {
        status: "unavailable" as const,
        errorSummary: `Attachment exceeds the ${Math.round(MAX_TRANSCRIPTION_DURATION_SEC / 60)} minute transcription cap.`,
      },
    };
    const catalog = await loadThreadAttachmentCatalog(paths);
    await saveThreadAttachmentCatalog(paths, {
      entries: catalog.entries.map((candidate) => (
        candidate.attachmentId === unavailableEntry.attachmentId ? unavailableEntry : candidate
      )),
    });
    return unavailableEntry;
  }

  try {
    const audioPath = await extractAudioTrack(paths, entry);
    const chunks = await splitAudioIntoChunks(audioPath, durationSec);
    const transcriptText = await transcribeAudioChunks(chunks, openaiApiKey);
    const artifact = await writeDerivedTextArtifact(paths, entry.attachmentId, "transcript", transcriptText);
    const completedEntry = {
      ...entry,
      durationSec,
      previewText: entry.previewText ?? artifact.previewText,
      updatedAt: nowIso(),
      transcription: {
        status: "completed" as const,
        artifactPath: artifact.artifactPath,
        lineCount: artifact.lineCount,
        chunkCount: chunks.length,
        model: AUDIO_TRANSCRIPTION_MODEL,
      },
    };
    const catalog = await loadThreadAttachmentCatalog(paths);
    await saveThreadAttachmentCatalog(paths, {
      entries: catalog.entries.map((candidate) => (
        candidate.attachmentId === completedEntry.attachmentId ? completedEntry : candidate
      )),
    });
    return completedEntry;
  } catch (error) {
    const failedEntry = {
      ...entry,
      durationSec,
      updatedAt: nowIso(),
      transcription: {
        status: "failed" as const,
        errorSummary: error instanceof Error ? error.message : String(error),
      },
    };
    const catalog = await loadThreadAttachmentCatalog(paths);
    await saveThreadAttachmentCatalog(paths, {
      entries: catalog.entries.map((candidate) => (
        candidate.attachmentId === failedEntry.attachmentId ? failedEntry : candidate
      )),
    });
    return failedEntry;
  }
}

export async function readThreadAttachment(
  args: ReadThreadAttachmentArgs,
): Promise<ThreadAttachmentReadResult> {
  await ensureThreadWorkspace(args.paths);
  const catalog = await loadThreadAttachmentCatalog(args.paths);
  const initialEntry = findThreadAttachmentEntry(catalog, args.attachmentId);
  if (!initialEntry) {
    throw new Error(`Attachment not found: ${args.attachmentId}`);
  }

  let entry = initialEntry;
  let artifactPath: string | undefined;
  let note: string | undefined;
  if (entry.kind === "document") {
    entry = await ensureDocumentArtifact(args.paths, entry);
    artifactPath = entry.extraction.artifactPath;
    if (entry.extraction.status === "failed") {
      return buildUnavailableReadResult(entry, entry.extraction.errorSummary ?? "Attachment extraction failed.");
    }
  } else if (entry.kind === "audio" || entry.kind === "video") {
    entry = await ensureTranscriptArtifact(args.paths, entry, args.openaiApiKey);
    artifactPath = entry.transcription.artifactPath;
    note = entry.kind === "video"
      ? "Video attachments are read through audio transcription only in v1."
      : undefined;
    if (entry.transcription.status === "unavailable" || entry.transcription.status === "failed") {
      return buildUnavailableReadResult(entry, entry.transcription.errorSummary ?? "Transcription is unavailable.");
    }
  } else {
    return buildUnavailableReadResult(entry, "This attachment type is metadata-only in v1.");
  }

  if (!artifactPath) {
    return buildUnavailableReadResult(entry, "No readable artifact is available for this attachment.");
  }

  const text = await readFile(artifactPath, "utf8");
  return buildTextWindowResult(entry, text, args.startLine, args.maxLines, note);
}

export async function listThreadAttachmentsForMessage(args: {
  workspaceDir: string;
  channelId: string;
  rootThreadTs: string;
  sourceMessageTs?: string;
}): Promise<ThreadAttachmentSummary[]> {
  const paths = buildThreadPaths(args.workspaceDir, args.channelId, args.rootThreadTs);
  return listThreadAttachments(paths, args.sourceMessageTs);
}

export async function readThreadAttachmentForMessage(args: {
  config: Pick<AppConfig, "workspaceDir" | "openaiApiKey">;
  channelId: string;
  rootThreadTs: string;
  attachmentId: string;
  startLine?: number;
  maxLines?: number;
}): Promise<ThreadAttachmentReadResult> {
  const paths = buildThreadPaths(args.config.workspaceDir, args.channelId, args.rootThreadTs);
  return readThreadAttachment({
    paths,
    attachmentId: args.attachmentId,
    openaiApiKey: args.config.openaiApiKey,
    startLine: args.startLine,
    maxLines: args.maxLines,
  });
}

export async function touchAttachmentCatalog(paths: ThreadPaths): Promise<number | undefined> {
  return safeStatMtime(join(paths.attachmentsDir, "catalog.json"));
}
