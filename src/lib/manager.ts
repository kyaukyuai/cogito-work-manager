import type { AppConfig } from "./config.js";
import { chooseOwner } from "../orchestrators/intake/planning-support.js";
import {
  buildHeartbeatReviewDecision as buildHeartbeatReviewDecisionOrchestrator,
  buildManagerReview as buildManagerReviewOrchestrator,
} from "../orchestrators/review/build-review.js";
import {
  classifyManagerQuery,
  type ManagerQueryKind,
} from "../orchestrators/query/handle-query.js";
import {
  isExplicitProjectGroupedTaskListQuery,
  isProjectGroupedTaskListQuery,
} from "../orchestrators/query/project-grouped-task-list.js";
import {
  applyCommittedThreadNotionPageTarget,
  buildProjectGroupedTaskListReplyOverride,
  extractQuerySnapshot,
  hasCompleteQuerySnapshot,
  persistQueryContinuationForAction,
  persistThreadNotionPageTargetForQuery,
} from "../orchestrators/query/manager-query-state.js";
import {
  runManagerAgentTurn,
  type ManagerAgentTurnObserver,
} from "./pi-session.js";
import type { ManagerMessageAttachmentSummary } from "../runtime/manager-prompts.js";
import {
  buildRunTaskActionClarifyReply,
  buildRunTaskClarifyReply,
  extractExplicitRunTaskIssueIdentifier,
  isRunTaskRequestText,
} from "../orchestrators/execution/handle-run-task.js";
import type {
  HeartbeatReviewDecision,
  ManagerReviewKind,
  ManagerReviewResult,
} from "../orchestrators/review/contract.js";
import { loadManagerReviewData } from "../orchestrators/review/review-data.js";
import {
  buildAwaitingFollowupPatch,
  buildIssueRiskSummary,
  buildReviewFollowup,
  formatReviewFollowupPrompt,
  formatRiskLine,
  getPrimaryRiskCategory,
  isUrgentRisk,
  isWithinBusinessHours,
  selectReviewFollowupItem,
  shouldSuppressFollowup,
  sortRiskyIssues,
  upsertFollowup,
} from "../orchestrators/review/review-helpers.js";
import {
  assessRisk,
  businessDaysSince,
} from "../orchestrators/review/risk.js";
import { createFileBackedManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import type { ManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import {
  buildSlackCapabilityReply,
  isSlackGreetingMessage,
  composeSlackReply,
  detectSlackCapabilityQuery,
  detectSlackOutboundPostRequest,
  formatSlackBullets,
  joinSlackSentences,
} from "../orchestrators/shared/slack-conversation.js";
import {
  commitManagerCommandProposals,
  type CommitManagerCommandArgs,
  type ManagerIntentReport,
  type ManagerIssueTargetValidationSummary,
  type PendingClarificationDecisionReport,
} from "./manager-command-commit.js";
import type { LinearIssue } from "../gateways/linear/types.js";
import {
  type ManagerPolicy,
} from "../state/manager-state-contract.js";
import { buildWorkgraphThreadKey } from "../state/workgraph/events.js";
import {
  getThreadPlanningContext,
} from "../state/workgraph/queries.js";
import {
  saveLastManagerAgentTurn,
  summarizeManagerCommittedCommand,
  summarizeManagerProposal,
  summarizeManagerProposalRejection,
} from "./last-manager-agent-turn.js";
import { buildSlackVisibleLlmFailureNotice } from "./llm-failure.js";
import type { LinearDuplicateResolutionSummary } from "./linear-duplicate-resolution.js";
import {
  appendPostCommitWarningNotice,
  buildCommitRejectionReply,
  buildCompactSuccessfulMutationReply,
  buildGroundedCreateWorkClarificationReply,
  buildGroundedCreateWorkReply,
  buildPartialFollowupSuccessReply,
  buildPartialSuccessfulMutationReply,
  collectCommittedPostCommitWarnings,
  deriveCommittedPostCommitStatus,
  isMutableIntent,
  mergeAgentReplyWithCommit,
  resolvePartialFollowupResolutionForReply,
  shouldPreferCommittedPublicReply,
} from "./manager-reply-shaping.js";
import type { SystemPaths } from "./system-workspace.js";
import { buildThreadPaths, ensureThreadWorkspace, type ThreadPaths } from "./thread-workspace.js";
import {
  clearThreadQueryContinuation,
  loadThreadQueryContinuation,
  type ThreadQueryContinuation,
} from "./query-continuation.js";
import {
  loadThreadNotionPageTarget,
} from "./thread-notion-page-target.js";
import {
  clearExternalCoordinationHint,
  loadExternalCoordinationHint,
} from "./external-coordination-hint.js";
import { loadSystemThreadContext, type SystemThreadContext } from "./system-thread-context.js";
import {
  originalMessageForPendingClarification,
  persistPendingManagerClarification,
  validatePendingClarificationDecision,
} from "./manager-pending-clarification.js";
import {
  clearPendingManagerClarification,
  isPendingManagerClarificationContinuation,
  isPendingManagerClarificationStatusQuestion,
  loadPendingManagerClarification,
  type PendingManagerClarification,
} from "./pending-manager-clarification.js";
import {
  clearPendingManagerConfirmation,
  loadPendingManagerConfirmation,
  parsePendingManagerConfirmationDecision,
  savePendingManagerConfirmation,
  type PendingManagerConfirmation,
} from "./pending-manager-confirmation.js";
import { handlePersonalizationUpdate } from "../orchestrators/personalization/handle-personalization.js";

export type ManagerMessageKind = "request" | "query" | "progress" | "completed" | "blocked" | "conversation" | "scheduler";
export type ClarificationNeed = "scope" | "due_date" | "execution_plan";
export type {
  HeartbeatNoopReason,
  HeartbeatReviewDecision,
  ManagerFollowupSource,
  ManagerReviewFollowup,
  ManagerReviewIssueLine,
  ManagerReviewKind,
  ManagerReviewResult,
  RiskAssessment,
} from "../orchestrators/review/contract.js";
export type { ManagerQueryKind } from "../orchestrators/query/handle-query.js";
export {
  formatControlRoomFollowupForSlack,
  formatControlRoomReviewForSlack,
  formatIssueLineForSlack,
  formatManagerReviewFollowupLine,
} from "../orchestrators/review/review-helpers.js";
export { assessRisk, businessDaysSince } from "../orchestrators/review/risk.js";
export { formatIssueSelectionReply } from "../orchestrators/updates/target-resolution.js";
export { chooseOwner } from "../orchestrators/intake/planning-support.js";
export { classifyManagerQuery } from "../orchestrators/query/handle-query.js";

export interface ManagerSlackMessage {
  channelId: string;
  rootThreadTs: string;
  messageTs: string;
  userId: string;
  text: string;
  attachments?: ManagerMessageAttachmentSummary[];
}

export interface ManagerHandleResult {
  handled: boolean;
  reply?: string;
  diagnostics?: {
    agent?: {
      source: "agent" | "fallback";
      intent?: ManagerIntentReport["intent"];
      conversationKind?: "greeting" | "smalltalk" | "other";
      queryKind?: ManagerIntentReport["queryKind"];
      queryScope?: ManagerIntentReport["queryScope"];
      confidence?: number;
      reasoningSummary?: string;
      toolCalls: string[];
      proposalCount: number;
      invalidProposalCount?: number;
      committedCommands: string[];
      commitWarnings?: string[];
      postCommitStatus?: "complete" | "partial-local-failure";
      commitRejections: string[];
      pendingClarificationDecision?: PendingClarificationDecisionReport["decision"];
      pendingClarificationPersistence?: PendingClarificationDecisionReport["persistence"];
      pendingClarificationDecisionSummary?: string;
      taskExecutionDecision?: "execute" | "noop";
      taskExecutionTargetIssueId?: string;
      taskExecutionTargetIssueIdentifier?: string;
      taskExecutionSummary?: string;
      agentIssueEvidence?: Array<{
        issueId: string;
        source: "linear_get_issue_facts" | "duplicate_exact_reuse";
        summary?: string;
      }>;
      strongAllowSet?: string[];
      weakHintSet?: string[];
      rejectionGate?: "hard-override" | "strong-allow-mismatch" | "weak-hint-mismatch" | "no-hints";
      duplicateResolutions?: LinearDuplicateResolutionSummary[];
      missingQuerySnapshot?: boolean;
      technicalFailure?: string;
    };
    router?: {
      source: "llm" | "fallback";
      action: string;
      queryKind?: ManagerQueryKind;
      queryScope?: "self" | "team" | "thread-context";
      confidence?: number;
      reasoningSummary?: string;
      technicalFailure?: string;
    };
  };
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const RESEARCH_PATTERN = /(調査|確認|検証|比較|リサーチ|洗い出し|調べ)/i;
const EXPLICIT_RESEARCH_REQUEST_PATTERN =
  /(?:を|について)?(調査|検証|比較|リサーチ|洗い出し|調べ)(しておいて|して|お願いします|お願い|したい|してほしい)?(?:[。!！?？\s]|$)/i;
const EXPLICIT_CONFIRM_REQUEST_PATTERN =
  /(?:を|について)?確認(しておいて|して|お願いします|お願い|したい|してほしい)(?:[。!！?？\s]|$)/i;
const REQUEST_PATTERN =
  /(linear|issue|イシュー|ticket|チケット|todo|タスク|登録|追加|作成|作って|しておいて|お願い|お願いします|対応して|やっておいて|進めて|進めておいて)/i;
const COMPLETED_PATTERN = /(完了|終わった|終わりました|done|closed?|完了した)/i;
const BLOCKED_PATTERN = /(blocked|ブロック|詰まって|進められない|待ち)/i;
const PROGRESS_PATTERN = /(進捗|対応中|やっています|started|着手|進めています)/i;
const ISSUE_ID_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/g;
const DEFERRED_CLOSE_CONDITION_PATTERN =
  /(?:確認が終えたら|確認が終わったら|確認が済んだら|確認が取れたら|確認できたら|終えたら|終わったら|済んだら|完了したら|終えた後|終わった後|完了後)/i;
const CLOSE_TERM_PATTERN = /(クローズ|close|closed?|閉じる|閉じて|完了扱い)/i;
const NO_REMAINING_WORK_PATTERN =
  /(実施することはない|追加作業はない|やることはない|対応不要|対応は不要|不要と認識|キャンセル|cancell?ed?|中止|取りやめ)/i;
const URGENCY_WITHOUT_EXACT_DUE_PATTERN = /(急ぎ|至急|優先|早め|今週|来週|今月|来月|月内|リリース|今期)/i;
const VAGUE_REFERENCE_PATTERN = /(これ|それ|あれ|例の|この件|その件|あの件|やつ)/i;
const GENERIC_TITLE_PATTERN = /^(対応|確認|修正|作業|依頼|タスク|issue|イシュー|ticket|チケット)$/i;
const AMBIGUOUS_EXECUTION_PATTERN = /(進めておいて|進めて|よしなに|一式|まとめて|諸々|全般|いろいろ)/i;
const ACTIONABLE_RESEARCH_PATTERN = /(確認|修正|対応|実装|調査|整理|洗い出し|作成|更新|共有|再現|検証|比較)/i;
const LIST_MARKER_PATTERN = /^\s*(?:[-*・•]\s+|\d+[.)]\s+)/;
const LIST_HEADING_PATTERN = /^(?:タスク|todo|issue|イシュー)?\s*一覧$/i;
const REFERENCE_QUERY_PATTERN = /((?:notion|ノーション|slack|スラック|ドキュメント|docs?|メモ).*(?:確認|見て|検索|探して|調べ|読んで)|(?:確認|見て|検索|探して|調べ|読んで).*(?:notion|ノーション|slack|スラック|ドキュメント|docs?|メモ))/i;
const SCHEDULER_PATTERN = /(スケジュール|schedule|scheduler|cron|heartbeat|朝レビュー|夕方レビュー|週次レビュー|weekly review|morning review|evening review)/i;
interface ParsedTaskSegment {
  raw: string;
  title: string;
  dueDate?: string;
  assignee?: string;
}

function nowIso(now: Date): string {
  return now.toISOString();
}

function toJstDate(date: Date): Date {
  return new Date(date.getTime() + JST_OFFSET_MS);
}

function normalizeText(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[。！!？?]+$/g, "")
    .toLowerCase();
}

function stripLeadingListMarker(text: string): string {
  return text.replace(LIST_MARKER_PATTERN, "").trim();
}

function getListHeading(text: string): string | undefined {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return undefined;

  const first = stripLeadingListMarker(lines[0] ?? "");
  const second = lines[1] ?? "";
  if (!LIST_MARKER_PATTERN.test(second)) return undefined;

  const heading = first
    .replace(/^<@[^>]+>\s*/, "")
    .replace(/[。！!？?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!heading) return undefined;
  if (LIST_HEADING_PATTERN.test(heading) || heading.endsWith("一覧")) {
    return heading;
  }
  return undefined;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

export function fingerprintText(text: string): string {
  return normalizeText(text)
    .replace(/(linear|issue|イシュー|ticket|チケット|todo|タスク|登録|追加|作成|作って|しておいて|お願い|お願いします)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyManagerSignal(text: string): ManagerMessageKind {
  const normalized = text.trim();
  if (!normalized) return "conversation";
  if (classifyManagerQuery(normalized)) return "query";
  if (BLOCKED_PATTERN.test(normalized)) return "blocked";
  if (COMPLETED_PATTERN.test(normalized)) return "completed";
  if (PROGRESS_PATTERN.test(normalized)) return "progress";
  if (REFERENCE_QUERY_PATTERN.test(normalized)) return "query";
  if (RESEARCH_PATTERN.test(normalized)) return "request";
  if (REQUEST_PATTERN.test(normalized)) return "request";
  return "conversation";
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

function buildSafetyQueryReply(): string {
  return "いまは一覧や優先順位を安全に判断できないため、issue ID か条件をもう少し具体的に教えてください。";
}

function isSchedulerRunRequestText(text: string): boolean {
  return /(今すぐ実行|テスト実行|試しに一度動かして|実行して)/.test(text);
}

function formatCommitLogs(commitSummaries: string[]): string {
  return commitSummaries
    .map((summary) => `> system log: ${summary}`)
    .join("\n");
}

function describePendingManagerConfirmationTarget(
  confirmation: PendingManagerConfirmation,
): {
  confirmableLabel: string;
  cancelLabel: string;
} {
  if (confirmation.kind === "owner-map") {
    return {
      confirmableLabel: "owner-map.json の変更",
      cancelLabel: "owner-map.json の変更案",
    };
  }
  return {
    confirmableLabel: "確認待ちの変更",
    cancelLabel: "確認待ちの変更案",
  };
}

function buildSafetyOnlyManagerFallbackReply(
  message: ManagerSlackMessage,
  pendingClarification?: PendingManagerClarification,
): {
  action: ManagerMessageKind | "scheduler";
  reply: string;
} {
  if (pendingClarification && isPendingManagerClarificationStatusQuestion(message.text)) {
    return {
      action: "conversation",
      reply: joinSlackSentences([
        "この thread では、前の依頼を task として確定するための補足待ちです。",
        pendingClarification.missingDecisionSummary ?? "何を task にしたいかをもう一度短く言い換えてもらえれば、その続きとして扱います。",
      ]) ?? "この thread では前の依頼の補足待ちです。",
    };
  }
  if (pendingClarification && isPendingManagerClarificationContinuation(message.text)) {
    return {
      action: pendingClarification.intent === "run_task" || pendingClarification.intent === "create_work"
        ? "request"
        : pendingClarification.intent === "create_schedule"
          ? "scheduler"
          : pendingClarification.intent === "post_slack_message"
            ? "request"
          : pendingClarification.intent === "update_progress"
            ? "progress"
            : pendingClarification.intent === "update_completed"
            ? "completed"
            : pendingClarification.intent === "update_blocked"
              ? "blocked"
              : pendingClarification.intent === "run_schedule" || pendingClarification.intent === "update_schedule" || pendingClarification.intent === "delete_schedule"
                ? "scheduler"
              : "request",
      reply: joinSlackSentences([
        "補足として受け取りました。",
        "この thread の続きとして扱うので、直したい点や更新したい issue を 1 文で言い換えてもらえれば再試行できます。",
      ]) ?? "補足として受け取りました。",
    };
  }

  if (isRunTaskRequestText(message.text)) {
    const explicitIssueIdentifier = extractExplicitRunTaskIssueIdentifier(message.text);
    return {
      action: "request",
      reply: explicitIssueIdentifier
        ? buildRunTaskActionClarifyReply(explicitIssueIdentifier)
        : buildRunTaskClarifyReply(),
    };
  }

  if (SCHEDULER_PATTERN.test(message.text)) {
    return {
      action: "scheduler",
      reply: "いまは scheduler の内容を安全に確定できないため、見たい schedule 名か、追加・変更したい時刻、または今すぐ実行したい job 名をもう少し具体的に教えてください。",
    };
  }

  if (detectSlackOutboundPostRequest(message.text)) {
    return {
      action: "request",
      reply: "いまはメンション投稿の宛先や送信先を安全に確定できないため、owner-map にある相手名と送る文面を 1 文で言い換えてください。control room に送りたい場合はそれも明記してください。",
    };
  }

  if (isMixedIssueStatusAndDeferredCloseNote(message.text)) {
    return {
      action: "progress",
      reply: "いまは既存 issue の状態変更とクローズ条件コメントを安全に確定できないため、Canceled にしたい issue と条件を残したい issue を短く言い換えてください。次の返信はこの thread の続きとして扱います。",
    };
  }

  const action = classifyManagerSignal(message.text);
  if (action === "conversation") {
    const capabilityQuery = detectSlackCapabilityQuery(message.text);
    return {
      action,
      reply: buildFallbackConversationReply(detectFallbackConversationKind(message.text), capabilityQuery),
    };
  }
  if (action === "query") {
    return {
      action,
      reply: buildSafetyQueryReply(),
    };
  }
  if (action === "progress" || action === "completed" || action === "blocked") {
    return {
      action,
      reply: "いまは更新対象を安全に確定できないため、`AIC-123` のように issue ID を添えてもう一度送ってください。",
    };
  }
  return {
    action,
    reply: "いまは起票内容を安全に確定できないため、直したい点を 1 文で言い換えるか、親 issue の有無を補足してください。次の返信はこの thread の続きとして扱います。",
  };
}

function isMixedIssueStatusAndDeferredCloseNote(text: string): boolean {
  const issueIds = text.match(ISSUE_ID_PATTERN) ?? [];
  return issueIds.length >= 2
    && NO_REMAINING_WORK_PATTERN.test(text)
    && DEFERRED_CLOSE_CONDITION_PATTERN.test(text)
    && CLOSE_TERM_PATTERN.test(text);
}

export function needsResearchTask(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  const bulletLines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => LIST_MARKER_PATTERN.test(line))
    .map((line) => stripLeadingListMarker(line))
    .filter(Boolean);
  if (bulletLines.length >= 2) return false;
  if (extractInlineTaskSegments(text).length >= 2) return false;
  if (/(?:作業|対応|タスク)(?:は|を)?.+に分けて/i.test(normalized)) return false;
  return EXPLICIT_RESEARCH_REQUEST_PATTERN.test(normalized) || EXPLICIT_CONFIRM_REQUEST_PATTERN.test(normalized);
}

function extractInlineTaskSegments(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  const match = normalized.match(/(?:作業|対応|タスク)(?:は|を)?\s*(.+?)(?:\s*)に分けて/i);
  if (!match?.[1]) return [];

  return unique(
    match[1]
      .split(/(?:、|,|と|および|及び)/)
      .map((segment) => deriveIssueTitle(segment))
      .filter((segment) => segment.length >= 2),
  );
}

function hasExplicitTaskBreakdown(text: string): boolean {
  const bulletLines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => LIST_MARKER_PATTERN.test(line))
    .map((line) => stripLeadingListMarker(line))
    .filter(Boolean);

  if (bulletLines.length >= 2) return true;
  return extractInlineTaskSegments(text).length >= 2;
}

export function extractTaskSegments(text: string): string[] {
  const listHeading = getListHeading(text);
  const bulletLines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => LIST_MARKER_PATTERN.test(line))
    .map((line) => stripLeadingListMarker(line))
    .filter(Boolean);

  if (bulletLines.length >= 2) {
    const filteredBulletLines = listHeading
      ? bulletLines.filter((line, index) => !(index === 0 && normalizeText(line) === normalizeText(listHeading)))
      : bulletLines;
    return Array.from(new Set(filteredBulletLines));
  }

  const inlineSegments = extractInlineTaskSegments(text);
  if (inlineSegments.length >= 2) {
    return inlineSegments;
  }

  const sentenceLike = text
    .split(/[。\n]/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => segment.length >= 6);

  if (sentenceLike.length >= 2) {
    return Array.from(new Set(sentenceLike));
  }

  return [];
}

function isNarrativeTaskBreakdown(text: string, segments: string[]): boolean {
  if (segments.length < 2) return false;
  if (hasExplicitTaskBreakdown(text)) return false;

  const nonEmptyLines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return nonEmptyLines.length >= 2;
}

export function deriveIssueTitle(text: string): string {
  let title = text.trim();
  title = title.replace(/^<@[^>]+>\s*/, "");
  title = title.replace(LIST_MARKER_PATTERN, "");
  title = title.replace(/(の)?(タスク|issue|Issue|イシュー|ticket|チケット)(を)?/g, " ");
  title = title.replace(/(しておいて|やっておいて|追加して|作成して|作って|登録して|おいて|お願い(します)?|対応して|進めておいて|進めて)/g, " ");
  title = title.replace(/[。！!？?]+$/g, "");
  title = title.replace(/\s+/g, " ").trim();
  title = title.replace(/を$/, "");
  return title || "Slack からの依頼";
}

function deriveResearchTitle(text: string): string {
  const normalized = text.replace(/(を)?(調査|確認|検証|比較|リサーチ|洗い出し|調べ)(しておいて|して|お願いします|お願い)?/g, " ");
  const title = deriveIssueTitle(normalized);
  return title || deriveIssueTitle(text);
}

function summarizeParentTitleFromSegments(segments: string[]): string | undefined {
  const parsedSegments = segments
    .map((segment) => parseTaskSegment(segment))
    .map((segment) => segment.title)
    .filter(Boolean);

  if (parsedSegments.length === 0) return undefined;
  if (parsedSegments.length === 1) return parsedSegments[0];
  return `${parsedSegments[0]} ほか${parsedSegments.length - 1}件`;
}

function derivePlanningTitle(text: string, research: boolean, segments: string[]): string {
  const listHeading = getListHeading(text);
  if (listHeading && segments.length >= 2) {
    if (LIST_HEADING_PATTERN.test(listHeading) || listHeading === "一覧") {
      return summarizeParentTitleFromSegments(segments) ?? listHeading;
    }
    return listHeading;
  }
  if (segments.length >= 3 && text.split("\n").some((line) => LIST_MARKER_PATTERN.test(line))) {
    return summarizeParentTitleFromSegments(segments) ?? "Slack から取り込んだタスク一覧";
  }
  if (isNarrativeTaskBreakdown(text, segments)) {
    return deriveIssueTitle(segments[0] ?? text);
  }
  return research ? deriveResearchTitle(text) : deriveIssueTitle(text);
}

function filterChildSegmentsForPlanning(text: string, segments: string[], planningTitle: string): string[] {
  if (!isNarrativeTaskBreakdown(text, segments)) {
    return segments;
  }

  const normalizedParent = normalizeText(planningTitle);
  const filtered = segments.filter((segment) => normalizeText(deriveIssueTitle(segment)) !== normalizedParent);
  return filtered.length > 0 ? filtered : segments;
}

function inferDocumentHint(texts: string[]): string | undefined {
  for (const text of texts) {
    const normalized = text.replace(/\s+/g, " ").trim();
    const directMatch = normalized.match(/([^\s、,。]+書)(?=(?:の|を|へ|に|確認|ドラフト|作成|送付|レビュー|締結))/);
    if (directMatch?.[1]) {
      return directMatch[1];
    }
  }

  for (const text of texts) {
    if (/契約/.test(text)) {
      return "契約書";
    }
  }

  return undefined;
}

function normalizeNarrativeChildTitle(
  text: string,
  fallbackTitle: string,
  context: { requestText: string; planningTitle: string; segments: string[] },
): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  const documentHint = inferDocumentHint([normalizedText, ...context.segments, context.requestText, context.planningTitle]);

  const confirmRequestMatch = normalizedText.match(/(?:.+?(?:後|完了後)[、,]\s*)?(.+?)(?:に|へ)確認依頼(?:を)?(?:する)?(?:必要あり|必要があります|が必要|予定|待ち|済み)?$/);
  if (confirmRequestMatch?.[1]) {
    const addressee = confirmRequestMatch[1].trim().replace(/\s+/g, " ");
    return `${addressee}へ${documentHint ? `${documentHint}` : ""}確認依頼`;
  }

  if (/ドラフト(?:版)?/.test(normalizedText) && /(作成|作成依頼|作成依頼済み)/.test(normalizedText)) {
    return "ドラフト作成";
  }

  return fallbackTitle
    .replace(/依頼済み$/g, "依頼")
    .replace(/(?:を|の)?作成依頼$/g, "作成")
    .replace(/(?:する)?必要があります$/g, "")
    .replace(/(?:する)?必要あり$/g, "")
    .replace(/(?:が)?必要です$/g, "")
    .replace(/(?:が)?必要$/g, "")
    .trim();
}

export function isComplexRequest(text: string): boolean {
  return extractTaskSegments(text).length >= 2 || text.length >= 48;
}

export function detectClarificationNeeds(text: string, now = new Date()): ClarificationNeed[] {
  const needs: ClarificationNeed[] = [];
  const title = deriveIssueTitle(text);
  const dueDate = extractDueDate(text, now);
  const hasSegments = extractTaskSegments(text).length >= 2;

  if (VAGUE_REFERENCE_PATTERN.test(text) || title === "Slack からの依頼" || GENERIC_TITLE_PATTERN.test(title)) {
    needs.push("scope");
  }

  if (!dueDate && URGENCY_WITHOUT_EXACT_DUE_PATTERN.test(text)) {
    needs.push("due_date");
  }

  if ((isComplexRequest(text) || AMBIGUOUS_EXECUTION_PATTERN.test(text)) && !hasSegments && !needsResearchTask(text)) {
    needs.push("execution_plan");
  }

  return unique(needs);
}

export function formatClarificationReply(title: string, needs: ClarificationNeed[]): string {
  const asks: string[] = [];

  if (needs.includes("scope")) {
    asks.push("何をどこまで対応するタスクか、対象をもう少し具体化してください。");
  }
  if (needs.includes("due_date")) {
    asks.push("期限を確認したいです。いつまでに完了したいか教えてください。例: 2026-03-20 / 今日中 / 明日");
  }
  if (needs.includes("execution_plan")) {
    asks.push("進め方を固めたいです。完了条件か、分けたい作業を 1-3 点で教えてください。");
  }

  return composeSlackReply([
    joinSlackSentences([
      "起票前に確認したい点があります。",
      `対象は ${title} です。`,
    ]),
    formatSlackBullets(asks),
    "返答をもらえれば、その内容を取り込んで Linear に起票します。",
  ]);
}

function extractDueDate(text: string, now = new Date()): string | undefined {
  const normalized = text.trim();
  const explicit = normalized.match(/\b(\d{4})[-/](\d{2})[-/](\d{2})\b/);
  if (explicit) {
    return `${explicit[1]}-${explicit[2]}-${explicit[3]}`;
  }

  const jstNow = toJstDate(now);
  const year = jstNow.getUTCFullYear();
  const month = jstNow.getUTCMonth();
  const day = jstNow.getUTCDate();

  if (/明後日/.test(normalized)) {
    return new Date(Date.UTC(year, month, day + 2)).toISOString().slice(0, 10);
  }
  if (/明日/.test(normalized)) {
    return new Date(Date.UTC(year, month, day + 1)).toISOString().slice(0, 10);
  }
  if (/今日/.test(normalized)) {
    return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
  }

  return undefined;
}

function extractGlobalDueDate(text: string, now = new Date()): string | undefined {
  const nonListText = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !LIST_MARKER_PATTERN.test(line))
    .join("\n");

  if (!nonListText) return undefined;
  return extractDueDate(nonListText, now);
}

function parseTaskSegment(text: string, now = new Date()): ParsedTaskSegment {
  let raw = stripLeadingListMarker(text.trim());
  let metadataText: string | undefined;
  const metadataMatch = raw.match(/\s*[（(]([^()（）]+)[)）]\s*$/);
  if (metadataMatch && metadataMatch.index != null) {
    metadataText = metadataMatch[1]?.trim();
    raw = raw.slice(0, metadataMatch.index).trim();
  }

  let dueDate: string | undefined;
  let assignee: string | undefined;

  for (const part of (metadataText ?? "").split(/[、,，]/).map((value) => value.trim()).filter(Boolean)) {
    const assigneeMatch = part.match(/^担当[:：]\s*(.+)$/);
    if (assigneeMatch?.[1]) {
      assignee = assigneeMatch[1].trim();
      continue;
    }

    const dueMatch = part.match(/^期限[:：]\s*(.+)$/);
    if (dueMatch?.[1]) {
      const rawDue = dueMatch[1].trim();
      if (rawDue !== "未定") {
        dueDate = extractDueDate(rawDue, now) ?? dueDate;
      }
    }
  }

  return {
    raw: text,
    title: deriveIssueTitle(raw),
    dueDate,
    assignee,
  };
}

function isManagerRepositories(value: unknown): value is ManagerRepositories {
  return typeof value === "object"
    && value !== null
    && "policy" in value
    && "ownerMap" in value
    && "followups" in value
    && "planning" in value
    && "workgraph" in value;
}

export async function buildHeartbeatReviewDecision(
  config: AppConfig,
  systemPaths: SystemPaths,
  repositoriesOrNow?: ManagerRepositories | Date,
  maybeNow?: Date,
): Promise<HeartbeatReviewDecision> {
  const repositories = isManagerRepositories(repositoriesOrNow)
    ? repositoriesOrNow
    : createFileBackedManagerRepositories(systemPaths);
  const now = repositoriesOrNow instanceof Date ? repositoriesOrNow : (maybeNow ?? new Date());
  return buildHeartbeatReviewDecisionOrchestrator({
    config,
    repositories,
    now,
    helpers: {
      loadManagerReviewData,
      isWithinBusinessHours: (policy, candidateNow) => isWithinBusinessHours(policy, candidateNow, { toJstDate }),
      sortRiskyIssues,
      isUrgentRisk,
      shouldSuppressFollowup,
      buildReviewFollowup: (item, policy, ownerMap, existingFollowup, issueSources) => buildReviewFollowup(
        item,
        policy,
        ownerMap,
        existingFollowup,
        issueSources,
        { normalizeText },
      ),
      upsertFollowup,
      buildAwaitingFollowupPatch: (followups, followup, category, candidateNow) => buildAwaitingFollowupPatch(
        followups,
        followup,
        category,
        candidateNow,
        { nowIso },
      ),
      getPrimaryRiskCategory,
      buildIssueRiskSummary,
      formatRiskLine,
      selectReviewFollowupItem,
    },
  });
}

export async function handleManagerMessage(
  config: AppConfig,
  systemPaths: SystemPaths,
  message: ManagerSlackMessage,
  repositoriesOrNow?: ManagerRepositories | Date,
  maybeNow?: Date,
  runtimeActions?: {
    runSchedulerJobNow?: CommitManagerCommandArgs["runSchedulerJobNow"];
    postSlackMessage?: CommitManagerCommandArgs["postSlackMessage"];
    managerAgentObserver?: ManagerAgentTurnObserver;
    logger?: CommitManagerCommandArgs["logger"];
  },
): Promise<ManagerHandleResult> {
  const repositories = isManagerRepositories(repositoriesOrNow)
    ? repositoriesOrNow
    : createFileBackedManagerRepositories(systemPaths);
  const now = repositoriesOrNow instanceof Date ? repositoriesOrNow : (maybeNow ?? new Date());
  const policy = await repositories.policy.load();
  const paths = buildThreadPaths(config.workspaceDir, message.channelId, message.rootThreadTs);
  await ensureThreadWorkspace(paths);
  const threadKey = buildWorkgraphThreadKey(message.channelId, message.rootThreadTs);
  const env = {
    ...process.env,
    LINEAR_API_KEY: config.linearApiKey,
    LINEAR_WORKSPACE: config.linearWorkspace,
    LINEAR_TEAM_KEY: config.linearTeamKey,
  };

  try {
    const explicitRunTaskIssueIdentifier = isRunTaskRequestText(message.text)
      ? extractExplicitRunTaskIssueIdentifier(message.text)
      : undefined;
    const lastQueryContext = await loadThreadQueryContinuation(paths).catch(() => undefined);
    const effectiveLastQueryContext = isExplicitProjectGroupedTaskListQuery(message.text)
      ? undefined
      : lastQueryContext;
    const deterministicReplyStreamingDisabled = isProjectGroupedTaskListQuery({
      messageText: message.text,
      lastQueryContext: effectiveLastQueryContext,
    });
    const currentThreadNotionPageTarget = await loadThreadNotionPageTarget(paths).catch(() => undefined);
    const externalCoordinationHint = await loadExternalCoordinationHint(paths).catch(() => undefined);
    const systemThreadContext = await loadSystemThreadContext(paths).catch(() => undefined);
    const pendingManagerClarification = await loadPendingManagerClarification(paths, now).catch(() => undefined);
    const pendingManagerConfirmation = await loadPendingManagerConfirmation(paths, now).catch(() => undefined);
    const pendingConfirmationDecision = pendingManagerConfirmation
      ? parsePendingManagerConfirmationDecision(message.text)
      : undefined;
    const threadPlanningContext = await getThreadPlanningContext(repositories.workgraph, threadKey).catch(() => undefined);

    if (pendingManagerConfirmation && pendingConfirmationDecision === "cancel") {
      await clearPendingManagerConfirmation(paths);
      const labels = describePendingManagerConfirmationTarget(pendingManagerConfirmation);
      return {
        handled: true,
        reply: `${labels.cancelLabel}を取り消しました。`,
        diagnostics: {
          agent: {
            source: "fallback",
            intent: "update_workspace_config",
            toolCalls: [],
            proposalCount: 0,
            committedCommands: [],
            commitRejections: [],
            missingQuerySnapshot: false,
          },
        },
      };
    }

    if (pendingManagerConfirmation && pendingConfirmationDecision === "confirm") {
      const labels = describePendingManagerConfirmationTarget(pendingManagerConfirmation);
      const confirmCommitResult = await commitManagerCommandProposals({
        config,
        repositories,
        proposals: pendingManagerConfirmation.proposals,
        message,
        now,
        policy,
        env,
        pendingConfirmationMode: "confirm",
        runSchedulerJobNow: runtimeActions?.runSchedulerJobNow,
        postSlackMessage: runtimeActions?.postSlackMessage,
        logger: runtimeActions?.logger,
      });
      if (confirmCommitResult.committed.length > 0 && confirmCommitResult.rejected.length === 0) {
        await clearPendingManagerConfirmation(paths);
      }
      return {
        handled: true,
        reply: confirmCommitResult.replySummaries.join(" ")
          || buildCommitRejectionReply(confirmCommitResult.rejected)
          || `${labels.confirmableLabel}を確定できませんでした。`,
        diagnostics: {
          agent: {
            source: "fallback",
            intent: "update_workspace_config",
            toolCalls: [],
            proposalCount: pendingManagerConfirmation.proposals.length,
            committedCommands: confirmCommitResult.committed.map((entry) => entry.commandType),
            commitRejections: confirmCommitResult.rejected.map((entry) => entry.reason),
            missingQuerySnapshot: false,
          },
        },
      };
    }

    if (deterministicReplyStreamingDisabled) {
      runtimeActions?.managerAgentObserver?.onReplyStreamingPolicy?.({
        mode: "disabled",
        reason: "deterministic-project-grouped-query",
      });
    }

    const agentTurn = await runManagerAgentTurn(config, paths, {
      kind: "message",
      channelId: message.channelId,
      rootThreadTs: message.rootThreadTs,
      messageTs: message.messageTs,
      userId: message.userId,
      text: message.text,
      attachments: message.attachments,
      currentDate: currentDateInJst(now),
      currentDateTimeJst: currentDateTimeInJst(now),
      lastQueryContext: effectiveLastQueryContext,
      currentThreadNotionPageTarget,
      externalCoordinationHint,
      systemThreadContext,
      pendingClarification: pendingManagerClarification,
      pendingConfirmation: pendingManagerConfirmation,
    }, runtimeActions?.managerAgentObserver);

    if (agentTurn.invalidProposalCount > 0 && agentTurn.proposals.length === 0) {
      throw new Error(`manager agent returned ${agentTurn.invalidProposalCount} invalid proposals`);
    }
    if (pendingManagerClarification && !agentTurn.pendingClarificationDecision) {
      throw new Error("manager agent missing pending clarification decision");
    }
    validatePendingClarificationDecision({
      messageText: message.text,
      pendingClarification: pendingManagerClarification,
      intent: agentTurn.intentReport?.intent,
      queryKind: agentTurn.intentReport?.queryKind,
      pendingDecision: agentTurn.pendingClarificationDecision,
    });
    if (explicitRunTaskIssueIdentifier && agentTurn.intentReport?.intent === "query") {
      throw new Error("manager agent explicit run_task misclassified as query");
    }
    if (agentTurn.intentReport?.intent === "run_task" && !agentTurn.taskExecutionDecision) {
      throw new Error("manager agent run_task missing task execution decision");
    }
    if (agentTurn.intentReport?.intent === "conversation" && !agentTurn.intentReport.conversationKind) {
      throw new Error("manager agent conversation missing conversationKind");
    }

    const issueTargetValidations: ManagerIssueTargetValidationSummary[] = [];
    const commitResult = agentTurn.pendingConfirmationRequest
      ? {
          committed: [],
          rejected: [],
          replySummaries: [],
          pendingConfirmation: {
            kind: agentTurn.pendingConfirmationRequest.kind,
            proposals: agentTurn.pendingConfirmationRequest.proposals,
            previewSummaryLines: agentTurn.pendingConfirmationRequest.previewSummaryLines,
            previewReply: agentTurn.pendingConfirmationRequest.previewReply,
          },
        }
      : await commitManagerCommandProposals({
          config,
          repositories,
          proposals: agentTurn.proposals,
          message,
          now,
          policy,
          env,
          agentIssueEvidence: agentTurn.agentIssueEvidence,
          recordIssueTargetValidation: (summary) => {
            issueTargetValidations.push(summary);
          },
          runSchedulerJobNow: runtimeActions?.runSchedulerJobNow,
          postSlackMessage: runtimeActions?.postSlackMessage,
          logger: runtimeActions?.logger,
        });
    const agentIntent = agentTurn.intentReport?.intent;
    const extractedQuerySnapshot = agentIntent === "query"
      ? extractQuerySnapshot(agentTurn.toolCalls)
      : undefined;
    const completeQuerySnapshot = hasCompleteQuerySnapshot(extractedQuerySnapshot)
      ? extractedQuerySnapshot
      : undefined;
    const projectGroupedTaskListReplyOverride = buildProjectGroupedTaskListReplyOverride({
      intent: agentIntent,
      queryKind: agentTurn.intentReport?.queryKind,
      messageText: message.text,
      lastQueryContext: effectiveLastQueryContext,
      toolCalls: agentTurn.toolCalls,
    });
    const effectiveQuerySnapshot = projectGroupedTaskListReplyOverride
      ? projectGroupedTaskListReplyOverride.snapshot
      : completeQuerySnapshot;
    const missingQuerySnapshot = agentIntent === "query"
      && !effectiveQuerySnapshot
      && !projectGroupedTaskListReplyOverride;
    const preferRejectionReply = isMutableIntent(agentIntent)
      && commitResult.committed.length === 0
      && commitResult.rejected.length > 0;
    const compactSuccessfulMutationReply = buildCompactSuccessfulMutationReply({
      intent: agentIntent,
      agentReply: agentTurn.reply,
      committed: commitResult.committed,
      commitRejections: commitResult.rejected.map((entry) => entry.reason),
    });
    const groundedCreateWorkReply = buildGroundedCreateWorkReply({
      intent: agentIntent,
      committed: commitResult.committed,
      commitRejections: commitResult.rejected.map((entry) => entry.reason),
    });
    const partialSuccessfulMutationReply = buildPartialSuccessfulMutationReply({
      intent: agentIntent,
      committed: commitResult.committed,
      commitRejections: commitResult.rejected,
    });
    const effectivePartialFollowupResolutionReport = await resolvePartialFollowupResolutionForReply({
      config,
      paths,
      message,
      intent: agentIntent,
      committed: commitResult.committed,
      commitRejections: commitResult.rejected,
      partialFollowupResolutionReport: agentTurn.partialFollowupResolutionReport,
      systemThreadContext,
      logger: runtimeActions?.logger,
    });
    const commitWarnings = collectCommittedPostCommitWarnings(commitResult.committed);
    const postCommitStatus = deriveCommittedPostCommitStatus(commitResult.committed);
    const agentIssueEvidence = agentTurn.agentIssueEvidence ?? [];
    const effectiveProposalSet = agentTurn.pendingConfirmationRequest?.proposals ?? agentTurn.proposals;
    const strongAllowSet = unique(issueTargetValidations.flatMap((entry) => entry.strongAllowSet));
    const weakHintSet = unique(issueTargetValidations.flatMap((entry) => entry.weakHintSet));
    const rejectionGate = [...issueTargetValidations]
      .reverse()
      .find((entry) => entry.rejectionGate)?.rejectionGate;
    const partialFollowupSuccessReply = buildPartialFollowupSuccessReply({
      intent: agentIntent,
      committed: commitResult.committed,
      commitRejections: commitResult.rejected,
      partialFollowupResolutionReport: effectivePartialFollowupResolutionReport,
    });
    const groundedCreateWorkClarificationReply = buildGroundedCreateWorkClarificationReply({
      intent: agentIntent,
      committed: commitResult.committed,
      rejected: commitResult.rejected,
      pendingClarificationPersistence: agentTurn.pendingClarificationDecision?.persistence,
    });
    const mergedReplyBase = projectGroupedTaskListReplyOverride?.reply
      ?? (missingQuerySnapshot
      ? buildSafetyQueryReply()
      : partialFollowupSuccessReply ?? compactSuccessfulMutationReply ?? partialSuccessfulMutationReply ?? groundedCreateWorkClarificationReply ?? groundedCreateWorkReply ?? mergeAgentReplyWithCommit({
          agentReply: agentTurn.reply,
          commitSummaries: commitResult.replySummaries,
          commitRejections: commitResult.rejected,
          preferCommittedPublicReply: shouldPreferCommittedPublicReply(agentIntent),
          preferRejectionReply,
        }));
    const warningAwareReply = appendPostCommitWarningNotice({
      intent: agentIntent,
      reply: mergedReplyBase,
      committed: commitResult.committed,
      commitRejections: commitResult.rejected,
    });
    const mergedReply = commitResult.pendingConfirmation
      ? commitResult.pendingConfirmation.previewReply
      : warningAwareReply;

    if (
      externalCoordinationHint
      && commitResult.committed.some((entry) => entry.issueIds.includes(externalCoordinationHint.issueId))
    ) {
      await clearExternalCoordinationHint(paths);
    }

    if (agentIntent === "query") {
      const queryKind = agentTurn.intentReport?.queryKind;
      if (!queryKind) {
        throw new Error("manager agent query missing queryKind");
      }
      if (effectiveQuerySnapshot) {
        await persistQueryContinuationForAction({
          paths,
          action: "query",
          queryKind,
          messageText: message.text,
          now,
          snapshot: effectiveQuerySnapshot,
        });
        await persistThreadNotionPageTargetForQuery({
          paths,
          snapshot: effectiveQuerySnapshot,
          now,
        });
      } else {
        await clearThreadQueryContinuation(paths);
      }
    } else if (
      agentIntent === "create_work"
      || agentIntent === "create_schedule"
      || agentIntent === "run_schedule"
      || agentIntent === "run_task"
      || agentIntent === "update_progress"
      || agentIntent === "update_completed"
      || agentIntent === "update_blocked"
      || agentIntent === "update_schedule"
      || agentIntent === "delete_schedule"
      || agentIntent === "followup_resolution"
      || agentIntent === "update_workspace_config"
      || agentIntent === "post_slack_message"
      || agentIntent === "review"
      || agentIntent === "heartbeat"
      || agentIntent === "scheduler"
    ) {
      runtimeActions?.logger?.info("manager persistence step started", {
        step: "persist_mutation_query_continuation",
        channelId: message.channelId,
        threadTs: message.rootThreadTs,
        intent: agentIntent,
      });
      await persistQueryContinuationForAction({
        paths,
        action: "mutation",
        messageText: message.text,
        now,
      });
      runtimeActions?.logger?.info("manager persistence step completed", {
        step: "persist_mutation_query_continuation",
        channelId: message.channelId,
        threadTs: message.rootThreadTs,
        intent: agentIntent,
      });
      runtimeActions?.logger?.info("manager persistence step started", {
        step: "apply_committed_thread_notion_page_target",
        channelId: message.channelId,
        threadTs: message.rootThreadTs,
        intent: agentIntent,
      });
      await applyCommittedThreadNotionPageTarget({
        paths,
        committed: commitResult.committed,
        now,
      });
      runtimeActions?.logger?.info("manager persistence step completed", {
        step: "apply_committed_thread_notion_page_target",
        channelId: message.channelId,
        threadTs: message.rootThreadTs,
        intent: agentIntent,
      });
    }

    const pendingPersistence = agentTurn.pendingClarificationDecision?.persistence;
    const commitSucceeded = commitResult.committed.length > 0;
    if (commitSucceeded && pendingManagerClarification) {
      runtimeActions?.logger?.info("manager persistence step started", {
        step: "clear_pending_manager_clarification",
        channelId: message.channelId,
        threadTs: message.rootThreadTs,
        intent: agentIntent,
      });
      await clearPendingManagerClarification(paths);
      runtimeActions?.logger?.info("manager persistence step completed", {
        step: "clear_pending_manager_clarification",
        channelId: message.channelId,
        threadTs: message.rootThreadTs,
        intent: agentIntent,
      });
    } else if (pendingPersistence === "clear") {
      runtimeActions?.logger?.info("manager persistence step started", {
        step: "clear_pending_manager_clarification",
        channelId: message.channelId,
        threadTs: message.rootThreadTs,
        intent: agentIntent,
      });
      await clearPendingManagerClarification(paths);
      runtimeActions?.logger?.info("manager persistence step completed", {
        step: "clear_pending_manager_clarification",
        channelId: message.channelId,
        threadTs: message.rootThreadTs,
        intent: agentIntent,
      });
    } else if (pendingPersistence === "replace" && isMutableIntent(agentIntent)) {
      await persistPendingManagerClarification({
        paths,
        intent: agentIntent,
        originalUserMessage: originalMessageForPendingClarification(
          pendingManagerClarification,
          agentTurn.pendingClarificationDecision?.decision,
          message.text,
        ),
        lastUserMessage: message.text,
        clarificationReply: mergedReply,
        missingDecisionSummary: commitResult.rejected.map((entry) => entry.reason).join(" / ")
          || agentTurn.pendingClarificationDecision?.summary,
        threadParentIssueId: threadPlanningContext?.parentIssue?.issueId ?? threadPlanningContext?.thread.parentIssueId,
        relatedIssueIds: unique([
          ...(threadPlanningContext?.childIssues.map((issue) => issue.issueId) ?? []),
          ...(threadPlanningContext?.linkedIssues.map((issue) => issue.issueId) ?? []),
          threadPlanningContext?.latestResolvedIssue?.issueId ?? "",
        ].filter(Boolean)),
        now,
      });
    }

    if (
      commitResult.pendingConfirmation
      && (!agentTurn.pendingConfirmationRequest || agentTurn.pendingConfirmationRequest.persistence === "replace")
    ) {
      await savePendingManagerConfirmation(paths, {
        kind: commitResult.pendingConfirmation.kind,
        originalUserMessage: message.text,
        proposals: commitResult.pendingConfirmation.proposals,
        previewSummaryLines: commitResult.pendingConfirmation.previewSummaryLines,
        previewReply: commitResult.pendingConfirmation.previewReply,
        recordedAt: now.toISOString(),
      });
    }

    try {
      await handlePersonalizationUpdate({
        config,
        systemPaths,
        paths,
        repositories,
        turnKind: "slack-message",
        latestUserMessage: message.text,
        latestAssistantReply: mergedReply,
        committedCommands: commitResult.committed.map((entry) => entry.commandType),
        rejectedReasons: commitResult.rejected.map((entry) => entry.reason),
        currentDate: currentDateInJst(now),
        issueContext: {
          issueId: agentTurn.taskExecutionDecision?.targetIssueId,
          issueIdentifier: agentTurn.taskExecutionDecision?.targetIssueIdentifier,
        },
        now,
      });
    } catch {
      // Personalization updates are silent and must not affect the main reply path.
    }

    runtimeActions?.logger?.info("manager persistence step started", {
      step: "save_last_manager_agent_turn",
      channelId: message.channelId,
      threadTs: message.rootThreadTs,
      intent: agentIntent,
    });
    await saveLastManagerAgentTurn(paths, {
      recordedAt: now.toISOString(),
      replyPath: "agent",
      intent: agentTurn.intentReport?.intent,
      conversationKind: agentTurn.intentReport?.conversationKind,
      queryKind: agentTurn.intentReport?.queryKind,
      queryScope: agentTurn.intentReport?.queryScope,
      confidence: agentTurn.intentReport?.confidence,
      summary: agentTurn.intentReport?.summary,
      currentDateTimeJst: currentDateTimeInJst(now),
      pendingClarificationDecision: agentTurn.pendingClarificationDecision?.decision,
      pendingClarificationPersistence: agentTurn.pendingClarificationDecision?.persistence,
      pendingClarificationDecisionSummary: agentTurn.pendingClarificationDecision?.summary,
      taskExecutionDecision: agentTurn.taskExecutionDecision?.decision,
      taskExecutionTargetIssueId: agentTurn.taskExecutionDecision?.targetIssueId,
      taskExecutionTargetIssueIdentifier: agentTurn.taskExecutionDecision?.targetIssueIdentifier,
      taskExecutionSummary: agentTurn.taskExecutionDecision?.summary,
      agentIssueEvidence,
      strongAllowSet,
      weakHintSet,
      rejectionGate,
      toolCalls: agentTurn.toolCalls.map((call) => call.toolName),
      proposalCount: effectiveProposalSet.length,
      invalidProposalCount: agentTurn.invalidProposalCount,
      proposals: effectiveProposalSet.map(summarizeManagerProposal),
      committedCommands: commitResult.committed.map(summarizeManagerCommittedCommand),
      commitWarnings,
      postCommitStatus,
      rejectedProposals: commitResult.rejected.map(summarizeManagerProposalRejection),
      duplicateResolutions: agentTurn.duplicateResolutions,
      partialFollowupUnmatchedTopics: effectivePartialFollowupResolutionReport?.unmatchedTopics,
      missingQuerySnapshot,
    });
    runtimeActions?.logger?.info("manager persistence step completed", {
      step: "save_last_manager_agent_turn",
      channelId: message.channelId,
      threadTs: message.rootThreadTs,
      intent: agentIntent,
    });

    return {
      handled: true,
      reply: mergedReply,
      diagnostics: {
        agent: {
          source: "agent",
          intent: agentTurn.intentReport?.intent,
          conversationKind: agentTurn.intentReport?.conversationKind,
          queryKind: agentTurn.intentReport?.queryKind,
          queryScope: agentTurn.intentReport?.queryScope,
          confidence: agentTurn.intentReport?.confidence,
          reasoningSummary: agentTurn.intentReport?.summary,
          toolCalls: agentTurn.toolCalls.map((call) => call.toolName),
          invalidProposalCount: agentTurn.invalidProposalCount,
          committedCommands: commitResult.committed.map((entry) => entry.commandType),
          commitRejections: commitResult.rejected.map((entry) => entry.reason),
          commitWarnings,
          postCommitStatus,
          pendingClarificationDecision: agentTurn.pendingClarificationDecision?.decision,
          pendingClarificationPersistence: agentTurn.pendingClarificationDecision?.persistence,
          pendingClarificationDecisionSummary: agentTurn.pendingClarificationDecision?.summary,
          taskExecutionDecision: agentTurn.taskExecutionDecision?.decision,
          taskExecutionTargetIssueId: agentTurn.taskExecutionDecision?.targetIssueId,
          taskExecutionTargetIssueIdentifier: agentTurn.taskExecutionDecision?.targetIssueIdentifier,
          taskExecutionSummary: agentTurn.taskExecutionDecision?.summary,
          agentIssueEvidence,
          strongAllowSet,
          weakHintSet,
          rejectionGate,
          duplicateResolutions: agentTurn.duplicateResolutions,
          missingQuerySnapshot,
          proposalCount: effectiveProposalSet.length,
        },
      },
    };
  } catch (error) {
    const pendingManagerClarification = await loadPendingManagerClarification(paths, now).catch(() => undefined);
    const threadPlanningContext = await getThreadPlanningContext(repositories.workgraph, threadKey).catch(() => undefined);
    const fallbackPendingDecision = pendingManagerClarification
      ? isPendingManagerClarificationStatusQuestion(message.text)
        ? "status_question"
        : isPendingManagerClarificationContinuation(message.text)
          ? "continue_pending"
          : undefined
      : undefined;
    const safetyFallback = buildSafetyOnlyManagerFallbackReply(message, pendingManagerClarification);
    const fallbackIntent = safetyFallback.action === "conversation"
      ? "conversation"
      : safetyFallback.action === "request"
        ? (isRunTaskRequestText(message.text)
          ? "run_task"
          : /(?:メンション(?:して|を付けて)|mention(?:して)?).*(?:送って|送信して|投稿して|メッセージ送信して)/i.test(message.text)
            ? "post_slack_message"
            : "create_work")
        : safetyFallback.action === "scheduler"
          ? (isSchedulerRunRequestText(message.text) ? "run_schedule" : "create_schedule")
          : safetyFallback.action === "progress"
            ? "update_progress"
            : safetyFallback.action === "completed"
              ? "update_completed"
              : safetyFallback.action === "blocked"
                ? "update_blocked"
                : undefined;
    await saveLastManagerAgentTurn(paths, {
      recordedAt: now.toISOString(),
      replyPath: "fallback",
      intent: fallbackIntent,
      conversationKind: safetyFallback.action === "conversation"
        ? detectFallbackConversationKind(message.text)
        : undefined,
      currentDateTimeJst: currentDateTimeInJst(now),
      pendingClarificationDecision: fallbackPendingDecision,
      pendingClarificationDecisionSummary: error instanceof Error ? error.message : String(error),
      pendingClarificationPersistence: pendingManagerClarification ? "keep" : undefined,
      proposalCount: 0,
      invalidProposalCount: 0,
      missingQuerySnapshot: false,
      technicalFailure: error instanceof Error ? error.message : String(error),
    });
    if (safetyFallback.action !== "conversation") {
      if (fallbackIntent && fallbackIntent !== "conversation") {
        await persistPendingManagerClarification({
          paths,
          intent: fallbackIntent,
          originalUserMessage: originalMessageForPendingClarification(
            pendingManagerClarification,
            fallbackPendingDecision,
            message.text,
          ),
          lastUserMessage: message.text,
          clarificationReply: safetyFallback.reply,
          missingDecisionSummary: error instanceof Error ? error.message : String(error),
          threadParentIssueId: threadPlanningContext?.parentIssue?.issueId ?? threadPlanningContext?.thread.parentIssueId,
          relatedIssueIds: unique([
            ...(threadPlanningContext?.childIssues.map((issue) => issue.issueId) ?? []),
            ...(threadPlanningContext?.linkedIssues.map((issue) => issue.issueId) ?? []),
            threadPlanningContext?.latestResolvedIssue?.issueId ?? "",
          ].filter(Boolean)),
          now,
        });
      }
    }
    return {
      handled: true,
      reply: prependLlmFailureNotice(safetyFallback.reply, error),
      diagnostics: {
        agent: {
          source: "fallback",
          toolCalls: [],
          proposalCount: 0,
          committedCommands: [],
          commitRejections: [],
          pendingClarificationDecision: fallbackPendingDecision,
          pendingClarificationPersistence: pendingManagerClarification ? "keep" : undefined,
          pendingClarificationDecisionSummary: error instanceof Error ? error.message : String(error),
          missingQuerySnapshot: false,
          technicalFailure: error instanceof Error ? error.message : String(error),
        },
        router: {
          source: "fallback",
          action: safetyFallback.action,
          technicalFailure: error instanceof Error ? error.message : String(error),
        },
      },
    };
  }
}

export async function buildManagerReview(
  config: AppConfig,
  systemPaths: SystemPaths,
  kind: ManagerReviewKind,
  repositoriesOrNow?: ManagerRepositories | Date,
  maybeNow?: Date,
): Promise<ManagerReviewResult | undefined> {
  const repositories = isManagerRepositories(repositoriesOrNow)
    ? repositoriesOrNow
    : createFileBackedManagerRepositories(systemPaths);
  const now = repositoriesOrNow instanceof Date ? repositoriesOrNow : (maybeNow ?? new Date());
  return buildManagerReviewOrchestrator({
    config,
    repositories,
    kind,
    now,
    helpers: {
      loadManagerReviewData,
      isWithinBusinessHours: (policy, candidateNow) => isWithinBusinessHours(policy, candidateNow, { toJstDate }),
      sortRiskyIssues,
      isUrgentRisk,
      shouldSuppressFollowup,
      buildReviewFollowup: (item, policy, ownerMap, existingFollowup, issueSources) => buildReviewFollowup(
        item,
        policy,
        ownerMap,
        existingFollowup,
        issueSources,
        { normalizeText },
      ),
      upsertFollowup,
      buildAwaitingFollowupPatch: (followups, followup, category, candidateNow) => buildAwaitingFollowupPatch(
        followups,
        followup,
        category,
        candidateNow,
        { nowIso },
      ),
      getPrimaryRiskCategory,
      buildIssueRiskSummary,
      formatRiskLine,
      selectReviewFollowupItem,
    },
  });
}
