import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AttachmentRecord, ThreadPaths } from "../../lib/thread-workspace.js";

export type ThreadAttachmentKind = "document" | "audio" | "video" | "other";
export type ThreadAttachmentStatus = "pending" | "completed" | "failed" | "not_applicable" | "unavailable";

export interface ThreadAttachmentProcessingState {
  status: ThreadAttachmentStatus;
  artifactPath?: string;
  errorSummary?: string;
  lineCount?: number;
  chunkCount?: number;
  model?: string;
}

export interface ThreadAttachmentCatalogEntry {
  attachmentId: string;
  sourceAttachmentId?: string;
  sourceMessageTs: string;
  name: string;
  mimeType?: string;
  storedPath: string;
  kind: ThreadAttachmentKind;
  previewText?: string;
  durationSec?: number;
  createdAt: string;
  updatedAt: string;
  extraction: ThreadAttachmentProcessingState;
  transcription: ThreadAttachmentProcessingState;
}

export interface ThreadAttachmentCatalog {
  entries: ThreadAttachmentCatalogEntry[];
}

export interface ThreadAttachmentSummary {
  attachmentId: string;
  sourceMessageTs: string;
  name: string;
  mimeType?: string;
  kind: ThreadAttachmentKind;
  previewText?: string;
  durationSec?: number;
  extractionStatus: ThreadAttachmentStatus;
  transcriptionStatus: ThreadAttachmentStatus;
}

const EMPTY_CATALOG: ThreadAttachmentCatalog = {
  entries: [],
};

export function buildThreadAttachmentCatalogPath(paths: ThreadPaths): string {
  return join(paths.attachmentsDir, "catalog.json");
}

export function buildThreadAttachmentArtifactsDir(paths: ThreadPaths): string {
  return join(paths.attachmentsDir, "derived");
}

export async function loadThreadAttachmentCatalog(paths: ThreadPaths): Promise<ThreadAttachmentCatalog> {
  try {
    const raw = await readFile(buildThreadAttachmentCatalogPath(paths), "utf8");
    const parsed = JSON.parse(raw) as Partial<ThreadAttachmentCatalog> | undefined;
    return {
      entries: Array.isArray(parsed?.entries) ? parsed.entries : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return EMPTY_CATALOG;
    }
    throw error;
  }
}

export async function saveThreadAttachmentCatalog(
  paths: ThreadPaths,
  catalog: ThreadAttachmentCatalog,
): Promise<void> {
  await mkdir(paths.attachmentsDir, { recursive: true });
  await writeFile(
    buildThreadAttachmentCatalogPath(paths),
    `${JSON.stringify(catalog, null, 2)}\n`,
    "utf8",
  );
}

export async function upsertThreadAttachmentCatalogEntries(
  paths: ThreadPaths,
  entries: ThreadAttachmentCatalogEntry[],
): Promise<ThreadAttachmentCatalog> {
  const catalog = await loadThreadAttachmentCatalog(paths);
  const byId = new Map(catalog.entries.map((entry) => [entry.attachmentId, entry]));
  for (const entry of entries) {
    byId.set(entry.attachmentId, entry);
  }
  const nextCatalog = {
    entries: Array.from(byId.values()).sort((left, right) => (
      left.sourceMessageTs.localeCompare(right.sourceMessageTs)
      || left.name.localeCompare(right.name)
    )),
  };
  await saveThreadAttachmentCatalog(paths, nextCatalog);
  return nextCatalog;
}

export function findThreadAttachmentEntry(
  catalog: ThreadAttachmentCatalog,
  attachmentId: string,
): ThreadAttachmentCatalogEntry | undefined {
  return catalog.entries.find((entry) => entry.attachmentId === attachmentId);
}

export function buildThreadAttachmentSummary(entry: ThreadAttachmentCatalogEntry): ThreadAttachmentSummary {
  return {
    attachmentId: entry.attachmentId,
    sourceMessageTs: entry.sourceMessageTs,
    name: entry.name,
    mimeType: entry.mimeType,
    kind: entry.kind,
    previewText: entry.previewText,
    durationSec: entry.durationSec,
    extractionStatus: entry.extraction.status,
    transcriptionStatus: entry.transcription.status,
  };
}

export function buildAttachmentRecord(entry: ThreadAttachmentCatalogEntry): AttachmentRecord {
  return {
    id: entry.sourceAttachmentId ?? entry.attachmentId,
    catalogId: entry.attachmentId,
    name: entry.name,
    mimeType: entry.mimeType,
    storedPath: entry.storedPath,
    kind: entry.kind,
  };
}
