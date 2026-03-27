import { mkdir, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { basename, join } from "node:path";
import type { AttachmentRecord } from "../lib/thread-workspace.js";
import { buildSlackVisibleLlmFailureNotice } from "../lib/llm-failure.js";
import type { ManagerIntentReport } from "../lib/manager-command-commit.js";
import type { RawSlackMessageEvent } from "../lib/slack.js";

export interface QueueLike {
  enqueue(key: string, job: () => Promise<void>): void;
}

export class ThreadQueue implements QueueLike {
  private readonly jobs = new Map<string, Promise<void>>();

  enqueue(key: string, job: () => Promise<void>): void {
    const previous = this.jobs.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(job)
      .finally(() => {
        if (this.jobs.get(key) === current) {
          this.jobs.delete(key);
        }
      });

    this.jobs.set(key, current);
  }
}

export async function readRawBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function extractSchedulerRunCommitSummary(rawReply: string, postedReply: string): string | undefined {
  const systemLogLine = rawReply
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^>\s*system log:\s*/i.test(line));
  if (systemLogLine) {
    return systemLogLine.replace(/^>\s*system log:\s*/i, "").trim();
  }

  const firstParagraph = rawReply
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .find(Boolean);
  const collapsed = (firstParagraph ?? postedReply)
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed || undefined;
}

export function buildSlackVisibleFailureReply(args: {
  error: unknown;
  fallbackReply: string;
  includeTechnicalMessage?: boolean;
}): string {
  const llmFailureNotice = buildSlackVisibleLlmFailureNotice(args.error);
  if (llmFailureNotice) {
    return [llmFailureNotice, args.fallbackReply].filter(Boolean).join("\n\n");
  }

  if (!args.includeTechnicalMessage) {
    return args.fallbackReply;
  }

  const technicalMessage = args.error instanceof Error ? args.error.message : String(args.error);
  return [args.fallbackReply, technicalMessage].filter(Boolean).join("\n\n");
}

export function isReadOnlyStreamingIntent(
  intent: ManagerIntentReport["intent"] | undefined,
): intent is "conversation" | "query" | "query_schedule" {
  return intent === "conversation" || intent === "query" || intent === "query_schedule";
}

export async function downloadAttachments(
  token: string,
  attachmentsDir: string,
  files: RawSlackMessageEvent["files"] = [],
): Promise<AttachmentRecord[]> {
  if (files.length === 0) return [];

  await mkdir(attachmentsDir, { recursive: true });
  const results: AttachmentRecord[] = [];

  for (const file of files) {
    const url = file.url_private_download ?? file.url_private;
    if (!url) continue;

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
    results.push({
      id: file.id,
      name: file.name,
      mimeType: file.mimetype,
      storedPath,
    });
  }

  return results;
}

export interface JstClock {
  currentDateInJst: () => string;
  currentDateTimeInJst: () => string;
}

export function createJstClock(): JstClock {
  return {
    currentDateInJst: () => new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date()),
    currentDateTimeInJst: () => {
      const formatted = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date());
      return `${formatted} JST`;
    },
  };
}
