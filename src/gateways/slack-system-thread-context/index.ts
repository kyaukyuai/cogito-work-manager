import { readFile } from "node:fs/promises";
import type { WebClient } from "@slack/web-api";
import {
  saveSystemThreadContext,
  type SystemThreadContext,
  type SystemThreadIssueRef,
} from "../../lib/system-thread-context.js";
import { appendThreadLog, type ThreadPaths } from "../../lib/thread-workspace.js";

type SlackHistoryMessage = {
  ts?: string;
  text?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  app_id?: string;
  subtype?: string;
  bot_profile?: unknown;
};

export interface SystemThreadRecoveryDiagnostic {
  level: "info" | "warn";
  message: string;
}

export interface RecoverLegacySystemThreadContextArgs {
  paths: ThreadPaths;
  webClient: Pick<WebClient, "conversations">;
  channelId: string;
  rootThreadTs: string;
  botUserId: string;
}

export interface RecoverLegacySystemThreadContextResult {
  recovered: boolean;
  context?: SystemThreadContext;
  diagnostics: SystemThreadRecoveryDiagnostic[];
}

const ISSUE_ID_PATTERN = /\b([A-Z][A-Z0-9]+)-(\d+)((?:\s*[\/→]\s*\d+)+)\b/g;
const FULL_ISSUE_ID_PATTERN = /\b([A-Z][A-Z0-9]+-\d+)\b/g;

function uniqueIssueRefs(issueRefs: SystemThreadIssueRef[]): SystemThreadIssueRef[] {
  const byId = new Map<string, SystemThreadIssueRef>();
  for (const issueRef of issueRefs) {
    const existing = byId.get(issueRef.issueId);
    if (!existing) {
      byId.set(issueRef.issueId, issueRef);
      continue;
    }
    byId.set(issueRef.issueId, {
      ...existing,
      titleHint: existing.titleHint ?? issueRef.titleHint,
      role: existing.role ?? issueRef.role,
    });
  }
  return Array.from(byId.values());
}

function extractImmediateTitleHint(line: string, afterIndex: number): string | undefined {
  const suffix = line.slice(afterIndex).trimStart();
  const match = suffix.match(/^[（(]([^）)]+)[）)]/);
  const titleHint = match?.[1]?.trim();
  return titleHint ? titleHint : undefined;
}

function expandGroupedIssueIds(prefix: string, firstNumber: string, suffix: string): string[] {
  const issueIds = [`${prefix}-${firstNumber}`];
  const trailingNumbers = Array.from(suffix.matchAll(/\d+/g))
    .map((match) => match[0])
    .filter((value) => value !== firstNumber);
  for (const number of trailingNumbers) {
    issueIds.push(`${prefix}-${number}`);
  }
  return issueIds;
}

export function extractLegacySystemThreadIssueRefs(text: string): SystemThreadIssueRef[] {
  const issueRefs: SystemThreadIssueRef[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const groupedMatches: Array<{
      start: number;
      end: number;
      issueIds: string[];
      titleHint?: string;
    }> = [];
    for (const match of line.matchAll(ISSUE_ID_PATTERN)) {
      const prefix = match[1];
      const firstNumber = match[2];
      const suffix = match[3];
      if (!prefix || !firstNumber || !suffix || typeof match.index !== "number") {
        continue;
      }
      const ids = expandGroupedIssueIds(prefix, firstNumber, suffix);
      groupedMatches.push({
        start: match.index,
        end: match.index + match[0].length,
        issueIds: ids,
        titleHint: extractImmediateTitleHint(line, match.index + match[0].length),
      });
    }

    const mask = Array.from(line);
    for (const groupedMatch of groupedMatches) {
      for (let index = groupedMatch.start; index < groupedMatch.end; index += 1) {
        if (mask[index] !== undefined) {
          mask[index] = " ";
        }
      }
      for (const issueId of groupedMatch.issueIds) {
        issueRefs.push({
          issueId,
          titleHint: groupedMatch.titleHint,
        });
      }
    }

    const maskedLine = mask.join("");
    const fullMatches = Array.from(maskedLine.matchAll(FULL_ISSUE_ID_PATTERN))
      .filter((match) => typeof match.index === "number")
      .map((match) => ({
        issueId: match[1]!,
        titleHint: extractImmediateTitleHint(line, match.index! + match[0].length),
      }));

    for (const fullMatch of fullMatches) {
      issueRefs.push(fullMatch);
    }
  }

  return uniqueIssueRefs(issueRefs);
}

function isTopLevelRootMessage(message: SlackHistoryMessage, rootThreadTs: string): boolean {
  return message.ts === rootThreadTs
    && (message.thread_ts === undefined || message.thread_ts === rootThreadTs);
}

function isSystemGeneratedRootMessage(message: SlackHistoryMessage, botUserId: string): boolean {
  return message.user === botUserId
    || typeof message.bot_id === "string"
    || typeof message.app_id === "string"
    || message.subtype === "bot_message"
    || typeof message.bot_profile === "object";
}

async function threadLogAlreadyContainsRootAssistant(
  paths: ThreadPaths,
  rootThreadTs: string,
): Promise<boolean> {
  try {
    const raw = await readFile(paths.logFile, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .some((line) => {
        try {
          const entry = JSON.parse(line) as { ts?: string; type?: string };
          return entry.ts === rootThreadTs && entry.type === "assistant";
        } catch {
          return false;
        }
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function recoverLegacySystemThreadContextFromSlackHistory(
  args: RecoverLegacySystemThreadContextArgs,
): Promise<RecoverLegacySystemThreadContextResult> {
  const diagnostics: SystemThreadRecoveryDiagnostic[] = [];
  const result = await args.webClient.conversations.replies({
    channel: args.channelId,
    ts: args.rootThreadTs,
    inclusive: true,
    limit: 20,
  });
  const rootMessage = (result.messages ?? []).find((message) => message.ts === args.rootThreadTs) as SlackHistoryMessage | undefined;

  if (!rootMessage) {
    diagnostics.push({
      level: "info",
      message: "Legacy system thread recovery found no root Slack post",
    });
    return { recovered: false, diagnostics };
  }

  if (!isTopLevelRootMessage(rootMessage, args.rootThreadTs)) {
    diagnostics.push({
      level: "info",
      message: "Legacy system thread recovery skipped non-root Slack message",
    });
    return { recovered: false, diagnostics };
  }

  if (!isSystemGeneratedRootMessage(rootMessage, args.botUserId)) {
    diagnostics.push({
      level: "info",
      message: "Legacy system thread recovery skipped non-system root Slack post",
    });
    return { recovered: false, diagnostics };
  }

  const rootText = (rootMessage.text ?? "").trim();
  const issueRefs = extractLegacySystemThreadIssueRefs(rootText);
  if (issueRefs.length === 0) {
    diagnostics.push({
      level: "info",
      message: "Legacy system thread recovery found no explicit issue refs in root Slack post",
    });
    return { recovered: false, diagnostics };
  }

  if (!await threadLogAlreadyContainsRootAssistant(args.paths, args.rootThreadTs)) {
    await appendThreadLog(args.paths, {
      type: "assistant",
      ts: args.rootThreadTs,
      threadTs: args.rootThreadTs,
      text: rootText,
    });
  }

  const context: SystemThreadContext = {
    sourceKind: "legacy-system",
    rootPostedTs: args.rootThreadTs,
    issueRefs,
    summary: "Recovered from pre-AIC-119 root Slack post",
    recordedAt: new Date().toISOString(),
  };
  await saveSystemThreadContext(args.paths, context);
  diagnostics.push({
    level: "info",
    message: "Recovered legacy system thread context from root Slack history",
  });
  return {
    recovered: true,
    context,
    diagnostics,
  };
}
