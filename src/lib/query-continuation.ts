import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThreadPaths } from "./thread-workspace.js";

export type ThreadQueryKind =
  | "list-active"
  | "list-today"
  | "what-should-i-do"
  | "inspect-work"
  | "search-existing"
  | "recommend-next-step";

export type ThreadQueryScope = "self" | "team" | "thread-context";

export interface ThreadQueryContinuation {
  kind: ThreadQueryKind;
  scope: ThreadQueryScope;
  userMessage: string;
  replySummary: string;
  issueIds: string[];
  recordedAt: string;
}

function buildThreadQueryContinuationPath(paths: ThreadPaths): string {
  return join(paths.scratchDir, "last-query-context.json");
}

function isThreadQueryKind(value: unknown): value is ThreadQueryKind {
  return value === "list-active"
    || value === "list-today"
    || value === "what-should-i-do"
    || value === "inspect-work"
    || value === "search-existing"
    || value === "recommend-next-step";
}

function isThreadQueryScope(value: unknown): value is ThreadQueryScope {
  return value === "self" || value === "team" || value === "thread-context";
}

export function extractIssueIdsFromText(text: string): string[] {
  return Array.from(
    new Set(
      Array.from(text.matchAll(/\b[A-Z][A-Z0-9]+-\d+\b/g)).map((match) => match[0]),
    ),
  );
}

export function summarizeSlackReply(text: string, maxLength = 220): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export async function loadThreadQueryContinuation(
  paths: ThreadPaths,
): Promise<ThreadQueryContinuation | undefined> {
  try {
    const raw = await readFile(buildThreadQueryContinuationPath(paths), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!isThreadQueryKind(parsed.kind) || !isThreadQueryScope(parsed.scope)) {
      return undefined;
    }
    if (typeof parsed.userMessage !== "string" || typeof parsed.replySummary !== "string" || typeof parsed.recordedAt !== "string") {
      return undefined;
    }
    const issueIds = Array.isArray(parsed.issueIds)
      ? parsed.issueIds.filter((value): value is string => typeof value === "string")
      : [];

    return {
      kind: parsed.kind,
      scope: parsed.scope,
      userMessage: parsed.userMessage,
      replySummary: parsed.replySummary,
      issueIds,
      recordedAt: parsed.recordedAt,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function saveThreadQueryContinuation(
  paths: ThreadPaths,
  continuation: ThreadQueryContinuation,
): Promise<void> {
  await writeFile(
    buildThreadQueryContinuationPath(paths),
    `${JSON.stringify(continuation, null, 2)}\n`,
    "utf8",
  );
}

export async function clearThreadQueryContinuation(paths: ThreadPaths): Promise<void> {
  try {
    await rm(buildThreadQueryContinuationPath(paths), { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}
