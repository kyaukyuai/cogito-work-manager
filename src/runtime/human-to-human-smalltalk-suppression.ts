import { readFile } from "node:fs/promises";
import { loadExternalCoordinationHint } from "../lib/external-coordination-hint.js";
import {
  loadLastManagerAgentTurn,
  saveLastManagerAgentTurn,
} from "../lib/last-manager-agent-turn.js";
import { loadPendingManagerClarification } from "../lib/pending-manager-clarification.js";
import { loadPendingManagerConfirmation } from "../lib/pending-manager-confirmation.js";
import { loadThreadQueryContinuation } from "../lib/query-continuation.js";
import { loadSystemThreadContext } from "../lib/system-thread-context.js";
import type { ManagerIntentReport } from "../lib/manager-command-commit.js";
import type { ThreadPaths } from "../lib/thread-workspace.js";

const USER_MENTION_PATTERN = /<@([A-Z0-9]+)>/g;

export const HUMAN_TO_HUMAN_SMALLTALK_IGNORE_REASON = "ignored_human_to_human_smalltalk_without_bot" as const;

export interface HumanToHumanSmalltalkActiveContextFlags {
  lastQueryContext: boolean;
  pendingManagerClarification: boolean;
  pendingManagerConfirmation: boolean;
  systemThreadContext: boolean;
  externalCoordinationHint: boolean;
  recentCommittedCommands: boolean;
  recentTaskExecution: boolean;
}

export interface HumanToHumanSmalltalkReplyGateContext {
  currentHasBotMention: boolean;
  rootHumanDirectedWithoutBot: boolean;
  activeThreadContextFlags: HumanToHumanSmalltalkActiveContextFlags;
  hasActiveThreadContext: boolean;
}

export interface HumanToHumanSmalltalkReplyGateDecision
  extends HumanToHumanSmalltalkReplyGateContext {
  shouldSuppress: boolean;
  ignoreReason?: typeof HUMAN_TO_HUMAN_SMALLTALK_IGNORE_REASON;
  intent?: ManagerIntentReport["intent"];
  conversationKind?: "greeting" | "smalltalk" | "other";
}

function extractMentionedUserIds(text: string): string[] {
  const mentionedUserIds = new Set<string>();
  let match: RegExpExecArray | null = USER_MENTION_PATTERN.exec(text);
  while (match) {
    if (match[1]) {
      mentionedUserIds.add(match[1]);
    }
    match = USER_MENTION_PATTERN.exec(text);
  }
  USER_MENTION_PATTERN.lastIndex = 0;
  return Array.from(mentionedUserIds);
}

async function loadRootThreadLogEntry(paths: ThreadPaths): Promise<{
  type?: string;
  text?: string;
} | undefined> {
  try {
    const raw = await readFile(paths.logFile, "utf8");
    const firstLine = raw
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
    if (!firstLine) {
      return undefined;
    }
    const parsed = JSON.parse(firstLine) as Record<string, unknown>;
    return {
      type: typeof parsed.type === "string" ? parsed.type : undefined,
      text: typeof parsed.text === "string" ? parsed.text : undefined,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function loadHumanToHumanSmalltalkReplyGateContext(args: {
  paths: ThreadPaths;
  botUserId: string;
  currentHasBotMention: boolean;
  now?: Date;
}): Promise<HumanToHumanSmalltalkReplyGateContext> {
  const [
    lastQueryContext,
    pendingManagerClarification,
    pendingManagerConfirmation,
    systemThreadContext,
    externalCoordinationHint,
    lastManagerTurn,
    rootEntry,
  ] = await Promise.all([
    loadThreadQueryContinuation(args.paths).catch(() => undefined),
    loadPendingManagerClarification(args.paths, args.now).catch(() => undefined),
    loadPendingManagerConfirmation(args.paths, args.now).catch(() => undefined),
    loadSystemThreadContext(args.paths).catch(() => undefined),
    loadExternalCoordinationHint(args.paths).catch(() => undefined),
    loadLastManagerAgentTurn(args.paths).catch(() => undefined),
    loadRootThreadLogEntry(args.paths),
  ]);

  const rootMentionedUserIds = extractMentionedUserIds(rootEntry?.text ?? "");
  const rootHasBotMention = rootMentionedUserIds.includes(args.botUserId);
  const rootHasOtherUserMention = rootMentionedUserIds.some((userId) => userId !== args.botUserId);
  const activeThreadContextFlags: HumanToHumanSmalltalkActiveContextFlags = {
    lastQueryContext: Boolean(lastQueryContext),
    pendingManagerClarification: Boolean(pendingManagerClarification),
    pendingManagerConfirmation: Boolean(pendingManagerConfirmation),
    systemThreadContext: Boolean(systemThreadContext),
    externalCoordinationHint: Boolean(externalCoordinationHint),
    recentCommittedCommands: Boolean(lastManagerTurn?.committedCommands?.length),
    recentTaskExecution: Boolean(lastManagerTurn?.taskExecutionDecision),
  };

  return {
    currentHasBotMention: args.currentHasBotMention,
    rootHumanDirectedWithoutBot: rootEntry?.type === "user" && rootHasOtherUserMention && !rootHasBotMention,
    activeThreadContextFlags,
    hasActiveThreadContext: Object.values(activeThreadContextFlags).some(Boolean),
  };
}

export function evaluateHumanToHumanSmalltalkReplyGate(args: {
  context: HumanToHumanSmalltalkReplyGateContext;
  handled: boolean;
  intent?: ManagerIntentReport["intent"];
  conversationKind?: "greeting" | "smalltalk" | "other";
}): HumanToHumanSmalltalkReplyGateDecision {
  const shouldSuppress = args.handled
    && args.intent === "conversation"
    && (args.conversationKind === "smalltalk" || args.conversationKind === "greeting")
    && !args.context.currentHasBotMention
    && args.context.rootHumanDirectedWithoutBot
    && !args.context.hasActiveThreadContext;

  return {
    ...args.context,
    shouldSuppress,
    ignoreReason: shouldSuppress ? HUMAN_TO_HUMAN_SMALLTALK_IGNORE_REASON : undefined,
    intent: args.intent,
    conversationKind: args.conversationKind,
  };
}

export async function persistHumanToHumanSmalltalkReplySuppressionOnLastTurn(
  paths: ThreadPaths,
  ignoreReason: typeof HUMAN_TO_HUMAN_SMALLTALK_IGNORE_REASON,
): Promise<void> {
  const lastManagerTurn = await loadLastManagerAgentTurn(paths);
  if (!lastManagerTurn) {
    return;
  }

  await saveLastManagerAgentTurn(paths, {
    ...lastManagerTurn,
    publicReplySuppressedReason: ignoreReason,
  });
}
