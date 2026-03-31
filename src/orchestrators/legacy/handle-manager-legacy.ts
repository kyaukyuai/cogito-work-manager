import type { AppConfig } from "../../lib/config.js";
import { handleIntakeRequest } from "../intake/handle-intake.js";
import { classifyManagerQuery, handleManagerQuery, type ManagerQueryKind } from "../query/handle-query.js";
import { handleManagerUpdates } from "../updates/handle-updates.js";
import {
  buildSlackCapabilityReply,
  composeSlackReply,
  detectSlackCapabilityQuery,
  isSlackGreetingMessage,
} from "../shared/slack-conversation.js";
import {
  runManagerReplyTurn,
  runMessageRouterTurn,
  type MessageRouterInput,
  type MessageRouterResult,
} from "../../lib/pi-session.js";
import { createFileBackedManagerRepositories } from "../../state/repositories/file-backed-manager-repositories.js";
import type { ManagerRepositories } from "../../state/repositories/file-backed-manager-repositories.js";
import { buildWorkgraphThreadKey } from "../../state/workgraph/events.js";
import {
  getPendingClarificationForThread,
  getThreadPlanningContext,
} from "../../state/workgraph/queries.js";
import { getSlackThreadContext } from "../../lib/slack-context.js";
import { saveLastManagerAgentTurn } from "../../lib/last-manager-agent-turn.js";
import { buildSlackVisibleLlmFailureNotice } from "../../lib/llm-failure.js";
import { loadExternalCoordinationHint } from "../../lib/external-coordination-hint.js";
import type { SystemPaths } from "../../lib/system-workspace.js";
import { buildThreadPaths, ensureThreadWorkspace, type ThreadPaths } from "../../lib/thread-workspace.js";
import {
  clearThreadQueryContinuation,
  loadThreadQueryContinuation,
  saveThreadQueryContinuation,
  type ThreadQueryContinuation,
  type ThreadQueryKind,
  type ThreadQueryScope,
} from "../../lib/query-continuation.js";
import {
  assessRisk,
} from "../review/risk.js";
import { formatReviewFollowupPrompt } from "../review/review-helpers.js";
import {
  classifyManagerSignal,
  fingerprintText,
  type ManagerHandleResult,
  type ManagerSlackMessage,
} from "../../lib/manager.js";

// Compatibility-only legacy manager path. Keep isolated from the primary path.

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const LIST_MARKER_PATTERN = /^\s*(?:[-*・•]\s+|\d+[.)]\s+)/;
const INTAKE_CORRECTION_PATTERN = /(ではなく|そうではなく|意図としては|つまり|言い換えると|そういう意味です|という意図です)/;

function nowIso(now: Date): string {
  return now.toISOString();
}

function toJstDate(date: Date): Date {
  return new Date(date.getTime() + JST_OFFSET_MS);
}

function currentDateInJst(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function currentDateTimeInJst(now: Date): string {
  const formatted = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  return `${formatted} JST`;
}

function detectFallbackConversationKind(text: string): "greeting" | "smalltalk" | "other" {
  if (isSlackGreetingMessage(text)) {
    return "greeting";
  }
  if (/[?？]$/.test(text.trim())) {
    return "smalltalk";
  }
  return "other";
}

function buildFallbackConversationReply(
  kind: "greeting" | "smalltalk" | "other",
  capabilityQuery?: ReturnType<typeof detectSlackCapabilityQuery>,
): string {
  if (capabilityQuery) {
    return buildSlackCapabilityReply(capabilityQuery);
  }
  if (kind === "greeting") {
    return "確認したいことや進めたい task があれば、そのまま送ってください。";
  }
  if (kind === "smalltalk") {
    return "確認したいことがあれば、そのまま続けて送ってください。状況確認でも task 追加でも大丈夫です。";
  }
  return "必要なことがあれば、そのまま続けて送ってください。状況確認でも task の相談でも対応します。";
}

function prependLlmFailureNotice(reply: string, error: unknown): string {
  const llmFailureNotice = buildSlackVisibleLlmFailureNotice(error);
  if (!llmFailureNotice) {
    return reply;
  }
  return composeSlackReply([llmFailureNotice, reply]);
}

async function buildConversationReply(
  config: AppConfig,
  message: ManagerSlackMessage,
  now: Date,
  conversationKind: "greeting" | "smalltalk" | "other",
): Promise<{
  reply: string;
  replyPath: "reply-planner" | "fallback";
  technicalFailure?: string;
}> {
  const paths = buildThreadPaths(config.workspaceDir, message.channelId, message.rootThreadTs);
  await ensureThreadWorkspace(paths);
  const capabilityQuery = detectSlackCapabilityQuery(message.text);

  try {
    const result = await runManagerReplyTurn(config, paths, {
      kind: "conversation",
      conversationKind,
      currentDate: currentDateInJst(now),
      currentDateTimeJst: currentDateTimeInJst(now),
      messageText: message.text,
      facts: {
        messageText: message.text,
        conversationKind,
        capabilityQuery,
      },
      taskKey: `${message.channelId}-${message.rootThreadTs}-conversation-reply`,
    });
    return {
      reply: result.reply,
      replyPath: "reply-planner",
    };
  } catch (error) {
    return {
      reply: prependLlmFailureNotice(
        buildFallbackConversationReply(conversationKind, capabilityQuery),
        error,
      ),
      replyPath: "fallback",
      technicalFailure: error instanceof Error ? error.message : String(error),
    };
  }
}

async function loadMessageRouterInput(
  config: AppConfig,
  repositories: Pick<ManagerRepositories, "workgraph">,
  message: ManagerSlackMessage,
  now: Date,
  pendingClarification?: Awaited<ReturnType<typeof getPendingClarificationForThread>>,
): Promise<MessageRouterInput> {
  const paths = buildThreadPaths(config.workspaceDir, message.channelId, message.rootThreadTs);
  const recentThread = await getSlackThreadContext(
    config.workspaceDir,
    message.channelId,
    message.rootThreadTs,
    8,
  ).catch(() => undefined);
  const planningContext = await getThreadPlanningContext(
    repositories.workgraph,
    buildWorkgraphThreadKey(message.channelId, message.rootThreadTs),
  ).catch(() => undefined);
  const lastQueryContext = await loadThreadQueryContinuation(paths).catch(() => undefined);
  const externalCoordinationHint = await loadExternalCoordinationHint(paths).catch(() => undefined);

  return {
    channelId: message.channelId,
    rootThreadTs: message.rootThreadTs,
    userId: message.userId,
    messageText: message.text,
    currentDate: currentDateInJst(now),
    recentThreadEntries: (recentThread?.entries ?? [])
      .slice(-6)
      .map((entry) => ({
        role: entry.type,
        text: entry.text,
      })),
    lastQueryContext,
    threadContext: {
      intakeStatus: pendingClarification?.intakeStatus ?? planningContext?.thread.intakeStatus,
      pendingClarification: pendingClarification?.pendingClarification ?? planningContext?.thread.pendingClarification ?? false,
      clarificationQuestion: pendingClarification?.clarificationQuestion ?? planningContext?.thread.clarificationQuestion,
      originalRequestText: pendingClarification?.originalText ?? planningContext?.thread.originalText,
      parentIssueId: planningContext?.thread.parentIssueId,
      childIssueIds: planningContext?.thread.childIssueIds ?? [],
      linkedIssueIds: planningContext?.thread.linkedIssueIds ?? [],
      latestFocusIssueId: planningContext?.thread.latestFocusIssueId,
      lastResolvedIssueId: planningContext?.thread.lastResolvedIssueId,
      externalCoordinationHintIssueId: externalCoordinationHint?.issueId,
    },
    taskKey: `${message.channelId}-${message.rootThreadTs}-message-router`,
  };
}

function saveLegacyQueryContinuation(args: {
  paths: ThreadPaths;
  queryKind: ThreadQueryKind;
  queryScope: ThreadQueryScope;
  messageText: string;
  replySummary: string;
  now: Date;
  continuation?: {
    issueIds: string[];
    shownIssueIds: string[];
    remainingIssueIds: string[];
    totalItemCount: number;
  };
}): Promise<void> {
  if (!args.continuation) {
    return Promise.resolve();
  }

  const snapshot: ThreadQueryContinuation = {
    kind: args.queryKind,
    scope: args.queryScope,
    userMessage: args.messageText.trim(),
    replySummary: args.replySummary,
    issueIds: args.continuation.issueIds,
    shownIssueIds: args.continuation.shownIssueIds,
    remainingIssueIds: args.continuation.remainingIssueIds,
    totalItemCount: args.continuation.totalItemCount,
    recordedAt: args.now.toISOString(),
  };

  return saveThreadQueryContinuation(args.paths, snapshot);
}

export async function handleManagerMessageLegacy(
  config: AppConfig,
  systemPaths: SystemPaths,
  message: ManagerSlackMessage,
  repositoriesOrNow?: ManagerRepositories | Date,
  maybeNow?: Date,
): Promise<ManagerHandleResult> {
  const repositories = typeof repositoriesOrNow === "object" && repositoriesOrNow !== null && "policy" in repositoriesOrNow
    ? repositoriesOrNow
    : createFileBackedManagerRepositories(systemPaths);
  const now = repositoriesOrNow instanceof Date ? repositoriesOrNow : (maybeNow ?? new Date());
  const policy = await repositories.policy.load();
  const followups = await repositories.followups.load();
  const paths = buildThreadPaths(config.workspaceDir, message.channelId, message.rootThreadTs);
  await ensureThreadWorkspace(paths);
  const pendingClarification = await getPendingClarificationForThread(
    repositories.workgraph,
    buildWorkgraphThreadKey(message.channelId, message.rootThreadTs),
  );
  const originalRequestText = pendingClarification?.originalText ?? message.text;
  const followupText = pendingClarification ? message.text : "";
  const combinedRequestText = pendingClarification
    ? `${originalRequestText}\n${followupText}`.trim()
    : message.text;
  const requestMessage: ManagerSlackMessage = pendingClarification
    ? {
        ...message,
        messageTs: pendingClarification.sourceMessageTs ?? message.messageTs,
        text: combinedRequestText,
      }
    : message;
  let routerResult: MessageRouterResult | undefined;
  let routerDiagnostics: ManagerHandleResult["diagnostics"] = undefined;
  const routerInput = await loadMessageRouterInput(config, repositories, message, now, pendingClarification);

  try {
    routerResult = await runMessageRouterTurn(
      config,
      paths,
      routerInput,
    );
    routerDiagnostics = {
      router: {
        source: "llm",
        action: routerResult.action,
        queryKind: routerResult.action === "query" ? routerResult.queryKind : undefined,
        queryScope: routerResult.action === "query" ? routerResult.queryScope : undefined,
        confidence: routerResult.confidence,
        reasoningSummary: routerResult.reasoningSummary,
      },
    };
  } catch (error) {
    const signal = pendingClarification ? "request" : classifyManagerSignal(message.text);
    const queryKind: ManagerQueryKind | undefined = !pendingClarification && signal === "query"
      ? classifyManagerQuery(message.text)
      : undefined;
    routerDiagnostics = {
      router: {
        source: "fallback",
        action: signal,
        queryKind,
        technicalFailure: error instanceof Error ? error.message : String(error),
      },
    };
    const correctionLooksLikeCreateWork = !pendingClarification
      && routerInput.threadContext?.intakeStatus === "created"
      && !routerInput.threadContext?.parentIssueId
      && (routerInput.threadContext?.childIssueIds.length ?? 0) === 1
      && INTAKE_CORRECTION_PATTERN.test(message.text);
    if (signal === "query" && queryKind) {
      routerResult = {
        action: "query",
        queryKind,
        queryScope: /(?:自分|自分の|私|私の|僕|僕の|わたし|わたしの)/i.test(message.text) ? "self" : "team",
        confidence: 0,
        reasoningSummary: "LLM router fallback",
      };
    } else if (correctionLooksLikeCreateWork) {
      routerResult = { action: "create_work", confidence: 0, reasoningSummary: "LLM router correction fallback" };
    } else if (signal === "progress") {
      routerResult = { action: "update_progress", confidence: 0, reasoningSummary: "LLM router fallback" };
    } else if (signal === "completed") {
      routerResult = { action: "update_completed", confidence: 0, reasoningSummary: "LLM router fallback" };
    } else if (signal === "blocked") {
      routerResult = { action: "update_blocked", confidence: 0, reasoningSummary: "LLM router fallback" };
    } else if (signal === "request") {
      routerResult = { action: "create_work", confidence: 0, reasoningSummary: "LLM router fallback" };
    } else {
      routerResult = {
        action: "conversation",
        conversationKind: detectFallbackConversationKind(message.text),
        confidence: 0,
        reasoningSummary: "LLM router fallback",
      };
    }
  }

  const env = {
    ...process.env,
    LINEAR_API_KEY: config.linearApiKey,
    LINEAR_WORKSPACE: config.linearWorkspace,
    LINEAR_TEAM_KEY: config.linearTeamKey,
  };
  const signal = routerResult.action === "update_progress"
    ? "progress"
    : routerResult.action === "update_completed"
      ? "completed"
      : routerResult.action === "update_blocked"
        ? "blocked"
        : routerResult.action === "create_work"
          ? "request"
          : routerResult.action === "query"
            ? "query"
            : "conversation";

  const updatesResult = await handleManagerUpdates({
    config,
    repositories,
    message,
    now,
    signal,
    policy,
    followups,
    allowFollowupResolution: !pendingClarification,
    env,
    helpers: {
      formatReviewFollowupPrompt,
      assessRisk,
      nowIso,
    },
  });
  if (updatesResult) {
    await clearThreadQueryContinuation(paths);
    return {
      ...updatesResult,
      diagnostics: routerDiagnostics,
    };
  }

  if (routerResult.action === "query") {
    const result = await handleManagerQuery({
      config,
      repositories,
      kind: routerResult.queryKind,
      queryScope: routerResult.queryScope,
      message,
      now,
      workspaceDir: config.workspaceDir,
      env,
      lastQueryContext: routerInput.lastQueryContext,
    });
    if (result.handled && result.reply) {
      await saveLegacyQueryContinuation({
        paths,
        queryKind: routerResult.queryKind,
        queryScope: routerResult.queryScope,
        messageText: message.text,
        replySummary: result.reply,
        now,
        continuation: result.continuation,
      });
    }
    return {
      ...result,
      diagnostics: routerDiagnostics,
    };
  }

  if (routerResult.action === "conversation") {
    const conversationReply = await buildConversationReply(config, message, now, routerResult.conversationKind);
    await saveLastManagerAgentTurn(paths, {
      recordedAt: now.toISOString(),
      replyPath: conversationReply.replyPath,
      intent: "conversation",
      conversationKind: routerResult.conversationKind,
      confidence: routerResult.confidence,
      summary: routerResult.reasoningSummary,
      currentDateTimeJst: currentDateTimeInJst(now),
      technicalFailure: conversationReply.technicalFailure,
      missingQuerySnapshot: false,
    });
    return {
      handled: true,
      reply: conversationReply.reply,
      diagnostics: routerDiagnostics,
    };
  }

  if (!policy.autoCreate) {
    return { handled: false, diagnostics: routerDiagnostics };
  }

  const intakeResult = await handleIntakeRequest({
    config,
    repositories,
    message,
    now,
    policy,
    pendingClarification,
    originalRequestText,
    requestMessage,
    env,
    helpers: {
      toJstDate,
      fingerprintText,
      nowIso,
    },
  });
  if (intakeResult.handled) {
    await clearThreadQueryContinuation(paths);
  }
  return {
    ...intakeResult,
    diagnostics: routerDiagnostics,
  };
}
