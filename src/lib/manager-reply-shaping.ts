import type { AppConfig } from "./config.js";
import type {
  ManagerCommittedCommand,
  ManagerIntentReport,
  ManagerProposalRejection,
  PendingClarificationDecisionReport,
} from "./manager-command-commit.js";
import type { PartialFollowupResolutionReport } from "./partial-followup-resolution.js";
import { runPartialFollowupUnmatchedTurn } from "./pi-session.js";
import type { SystemThreadContext } from "./system-thread-context.js";
import type { ThreadPaths } from "./thread-workspace.js";
import { composeSlackReply, formatSlackBullets, joinSlackSentences } from "../orchestrators/shared/slack-conversation.js";
import type { PartialFollowupUnmatchedResult } from "../planners/partial-followup-unmatched/index.js";

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function formatCommitLogs(commitSummaries: string[]): string {
  return commitSummaries
    .map((summary) => `> system log: ${summary}`)
    .join("\n");
}

function stripSlackSentenceEnding(text: string): string {
  return text.trim().replace(/[。.!！?？]+$/u, "");
}

function normalizeCommitSummaryForCompare(text: string): string {
  return text
    .replace(/<[^|>]+\|([^>]+)>/g, "$1")
    .replace(/[*_~`>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractSlackUrls(text: string): string[] {
  return Array.from(text.matchAll(/<([^|>\s]+)(?:\|[^>]+)?>/g))
    .map((match) => match[1] ?? "")
    .filter((value) => /^https?:\/\//.test(value));
}

function looksLikeFollowupSummary(summary: string): boolean {
  return /follow-up を作成しました/.test(summary);
}

function agentAlreadyCoversFollowup(agentReply: string, summary: string): boolean {
  const issueIds = Array.from(summary.matchAll(/\b([A-Z][A-Z0-9]+-\d+)\b/g))
    .map((match) => match[1] ?? "")
    .filter(Boolean);
  if (issueIds.length === 0 || !issueIds.every((issueId) => agentReply.includes(issueId))) {
    return false;
  }
  return /(確認|follow-up|フォローアップ|送[り付信]|連絡)/.test(agentReply);
}

function shouldSuppressCommitSummary(agentReply: string, summary: string): boolean {
  const summaryUrls = extractSlackUrls(summary);
  if (summaryUrls.length > 0) {
    const agentUrls = extractSlackUrls(agentReply);
    const agentCoversUrls = summaryUrls.every((url) => agentUrls.includes(url));
    if (!agentCoversUrls) {
      return false;
    }
  }

  const normalizedAgentReply = normalizeCommitSummaryForCompare(agentReply);
  const normalizedSummary = normalizeCommitSummaryForCompare(summary);
  if (!normalizedAgentReply || !normalizedSummary) {
    return false;
  }
  if (normalizedAgentReply.includes(normalizedSummary)) {
    return true;
  }
  return looksLikeFollowupSummary(summary) && agentAlreadyCoversFollowup(agentReply, summary);
}

function looksLikePreCommitAgentReply(reply: string): boolean {
  return /(提案しました|提案します|変更案です|更新します|作成します|投稿します|送信します|反映します|準備ができました|送る準備ができました)/.test(reply);
}

function buildSpecialCommitRejectionReply(
  rejection: ManagerProposalRejection,
): string | undefined {
  if (
    rejection.proposal.commandType === "update_issue_status"
    && /このメッセージでは .+ が明示されていますが、更新提案は .+ でした。更新する issue ID を明記してください。/.test(rejection.reason)
  ) {
    if (rejection.proposal.signal === "completed") {
      return `${rejection.proposal.issueId} の扱いはまだ変えていません。キャンセルするか内容修正かだけ補足してください。`;
    }
    return `${rejection.proposal.issueId} の扱いはまだ変えていません。更新したい issue ID と内容を短く補足してください。`;
  }
  if (
    rejection.proposal.commandType === "update_issue_priority"
    && (/このメッセージでは .+ が明示されていますが、更新提案は .+ でした。更新する issue ID を明記してください。/.test(rejection.reason)
      || /直近の会話では .+ を見ていましたが、更新提案は .+ でした。更新する issue ID を明記してください。/.test(rejection.reason)
      || /この thread で確認できる更新対象は .+ ですが、更新提案は .+ でした。更新する issue ID を明記してください。/.test(rejection.reason)
      || /更新対象の issue をこの thread から特定できませんでした。`AIC-123` のように issue ID を添えてください。/.test(rejection.reason)
      || /この thread には複数の issue が紐づいているため、どの issue を更新するか判断できませんでした。`AIC-123` のように issue ID を添えてください。/.test(rejection.reason))
  ) {
    return `${rejection.proposal.issueId} の優先度はまだ変えていません。どの issue の優先度を下げるかだけ、AIC-123 の形で補足してください。`;
  }
  return undefined;
}

export function buildCommitRejectionReply(
  rejections: ManagerProposalRejection[],
): string | undefined {
  if (rejections.length === 0) return undefined;
  if (rejections.length === 1) {
    const specialReply = buildSpecialCommitRejectionReply(rejections[0]);
    if (specialReply) {
      return specialReply;
    }
    return `今回は ${rejections[0]!.reason} ため、すぐには確定できませんでした。必要なら少し補足してください。`;
  }
  return composeSlackReply([
    "いくつか確認したい点があり、そのままでは確定できませんでした。",
    formatSlackBullets(rejections.map((entry) => buildSpecialCommitRejectionReply(entry) ?? entry.reason)),
    "必要なら少し補足してください。",
  ]);
}

export function isMutableIntent(
  intent: ManagerIntentReport["intent"] | undefined,
): intent is "run_task" | "create_work" | "create_schedule" | "run_schedule" | "update_progress" | "update_completed" | "update_blocked" | "update_schedule" | "delete_schedule" | "followup_resolution" | "post_slack_message" {
  return intent === "run_task"
    || intent === "create_work"
    || intent === "create_schedule"
    || intent === "run_schedule"
    || intent === "update_progress"
    || intent === "update_completed"
    || intent === "update_blocked"
    || intent === "update_schedule"
    || intent === "delete_schedule"
    || intent === "followup_resolution"
    || intent === "post_slack_message";
}

export function shouldPreferCommittedPublicReply(
  intent: ManagerIntentReport["intent"] | undefined,
): boolean {
  return intent === "update_workspace_config" || intent === "post_slack_message";
}

function extractCompactAgentFollowupSentence(agentReply: string): string | undefined {
  const sentences = agentReply
    .replace(/\n+/g, " ")
    .match(/[^。！？!?]+[。！？!?]?/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) ?? [];
  return sentences.find((sentence) => /^(次|引き続き|必要なら|まずは|残りは|続けて)/.test(sentence));
}

function agentReplyContainsUnmatchedTopicNote(agentReply: string): boolean {
  return /(対応する issue は見当たらない|対応するイシューは見当たらない|対応する issue はない|対応するイシューはない|既存 issue は見当たらない|既存イシューは見当たらない)/.test(agentReply);
}

export function buildCompactSuccessfulMutationReply(args: {
  intent: ManagerIntentReport["intent"] | undefined;
  agentReply: string;
  committed: ManagerCommittedCommand[];
  commitRejections: string[];
}): string | undefined {
  if (
    !isMutableIntent(args.intent)
    || args.intent === "create_work"
    || args.commitRejections.length > 0
    || args.committed.length !== 1
    || agentReplyContainsUnmatchedTopicNote(args.agentReply)
  ) {
    return undefined;
  }

  const committedEntry = args.committed[0];
  const publicReply = committedEntry.publicReply?.trim();
  if (!publicReply || committedEntry.issueIds.length !== 1) {
    return undefined;
  }

  const followupSentence = extractCompactAgentFollowupSentence(args.agentReply);
  if (!followupSentence) {
    return publicReply;
  }
  if (normalizeCommitSummaryForCompare(followupSentence) === normalizeCommitSummaryForCompare(publicReply)) {
    return publicReply;
  }
  return joinSlackSentences([publicReply, followupSentence]) ?? publicReply;
}

export function collectCommittedPostCommitWarnings(committed: ManagerCommittedCommand[]): string[] {
  return unique(
    committed.flatMap((entry) => entry.postCommitWarnings ?? [])
      .map((warning) => warning.trim())
      .filter(Boolean),
  );
}

export function deriveCommittedPostCommitStatus(
  committed: ManagerCommittedCommand[],
): "complete" | "partial-local-failure" | undefined {
  if (committed.length === 0) {
    return undefined;
  }
  return committed.some((entry) => entry.postCommitStatus === "partial-local-failure")
    ? "partial-local-failure"
    : "complete";
}

export function appendPostCommitWarningNotice(args: {
  intent: ManagerIntentReport["intent"] | undefined;
  reply: string;
  committed: ManagerCommittedCommand[];
  commitRejections: ManagerProposalRejection[];
}): string {
  if (!isMutableIntent(args.intent) || args.commitRejections.length > 0) {
    return args.reply;
  }
  const warnings = collectCommittedPostCommitWarnings(args.committed);
  if (warnings.length === 0) {
    return args.reply;
  }
  return composeSlackReply([
    args.reply,
    "Linear 更新自体は完了しましたが、内部記録の一部に失敗しました。必要なら diagnostics を確認してください。",
  ]);
}

export function buildGroundedCreateWorkReply(args: {
  intent: ManagerIntentReport["intent"] | undefined;
  committed: ManagerCommittedCommand[];
  commitRejections: string[];
}): string | undefined {
  if (args.intent !== "create_work" || args.commitRejections.length > 0 || args.committed.length < 2) {
    return undefined;
  }

  const supportedEntries = args.committed.filter((entry) => (
    entry.commandType === "create_issue" || entry.commandType === "link_existing_issue"
  ));
  if (supportedEntries.length !== args.committed.length) {
    return undefined;
  }
  if (supportedEntries.some((entry) => !entry.publicReply?.trim())) {
    return undefined;
  }

  const summaryLine = `${supportedEntries.length}件対応しました。`;
  const bulletLines = supportedEntries.map((entry) => `${entry.commandType === "link_existing_issue" ? "既存利用" : "新規作成"}: ${stripSlackSentenceEnding(entry.publicReply!)}`);
  return composeSlackReply([
    summaryLine,
    formatSlackBullets(bulletLines),
  ]);
}

function buildCreateWorkClarificationLines(rejected: ManagerProposalRejection[]): string[] {
  return rejected.flatMap((entry) => {
    if (entry.proposal.commandType !== "create_issue" || entry.proposal.duplicateHandling !== "clarify") {
      return [];
    }
    return [
      `「${entry.proposal.issue.title}」は近い既存 issue があるため、新規で作るか既存を使うか確認したいです。対象 issue ID か「新規で作成」と返してください。`,
    ];
  });
}

export function buildGroundedCreateWorkClarificationReply(args: {
  intent: ManagerIntentReport["intent"] | undefined;
  committed: ManagerCommittedCommand[];
  rejected: ManagerProposalRejection[];
  pendingClarificationPersistence: PendingClarificationDecisionReport["persistence"] | undefined;
}): string | undefined {
  if (
    args.intent !== "create_work"
    || args.committed.length === 0
    || args.pendingClarificationPersistence !== "replace"
  ) {
    return undefined;
  }

  const supportedEntries = args.committed.filter((entry) => (
    entry.commandType === "create_issue" || entry.commandType === "link_existing_issue"
  ));
  if (supportedEntries.length !== args.committed.length) {
    return undefined;
  }
  if (supportedEntries.some((entry) => !entry.publicReply?.trim())) {
    return undefined;
  }

  const clarificationLines = buildCreateWorkClarificationLines(args.rejected);
  if (clarificationLines.length === 0) {
    return undefined;
  }

  const replyParts = [
    `${supportedEntries.length}件対応しました。`,
    formatSlackBullets(supportedEntries.map((entry) => (
      `${entry.commandType === "link_existing_issue" ? "既存利用" : "新規作成"}: ${stripSlackSentenceEnding(entry.publicReply!)}`
    ))),
  ];

  if (clarificationLines.length === 1) {
    replyParts.push(`残り1件だけ確認です。${clarificationLines[0]}`);
  } else {
    replyParts.push("残りは確認したい点があります。");
    replyParts.push(formatSlackBullets(clarificationLines));
  }

  return composeSlackReply(replyParts);
}

export function buildPartialSuccessfulMutationReply(args: {
  intent: ManagerIntentReport["intent"] | undefined;
  committed: ManagerCommittedCommand[];
  commitRejections: ManagerProposalRejection[];
}): string | undefined {
  if (
    !isMutableIntent(args.intent)
    || args.intent === "create_work"
    || args.committed.length === 0
    || args.commitRejections.length === 0
  ) {
    return undefined;
  }

  const successLines = args.committed
    .map((entry) => entry.publicReply?.trim() || entry.summary.trim())
    .filter(Boolean);
  if (successLines.length === 0) {
    return undefined;
  }

  const successReply = successLines.length === 1
    ? successLines[0]
    : composeSlackReply([
        `${successLines.length}件反映しました。`,
        formatSlackBullets(successLines.map((line) => stripSlackSentenceEnding(line))),
      ]);
  const rejectionReply = buildCommitRejectionReply(args.commitRejections);
  return composeSlackReply([successReply, rejectionReply].filter(Boolean));
}

export function buildPartialFollowupSuccessReply(args: {
  intent: ManagerIntentReport["intent"] | undefined;
  committed: ManagerCommittedCommand[];
  commitRejections: ManagerProposalRejection[];
  partialFollowupResolutionReport: PartialFollowupResolutionReport | undefined;
}): string | undefined {
  if (
    !isMutableIntent(args.intent)
    || args.committed.length === 0
    || args.commitRejections.length > 0
    || !args.partialFollowupResolutionReport
    || args.partialFollowupResolutionReport.unmatchedTopics.length === 0
  ) {
    return undefined;
  }

  const committedIssueIds = new Set(args.committed.flatMap((entry) => entry.issueIds));
  const matchedIssueIds = args.partialFollowupResolutionReport.matchedIssueIds
    .filter((issueId) => committedIssueIds.has(issueId));
  if (matchedIssueIds.length === 0) {
    return undefined;
  }

  const successLines = args.committed
    .map((entry) => entry.publicReply?.trim() || entry.summary.trim())
    .filter(Boolean);
  if (successLines.length === 0) {
    return undefined;
  }

  const successReply = successLines.length === 1
    ? successLines[0]
    : composeSlackReply([
        `${successLines.length}件反映しました。`,
        formatSlackBullets(successLines.map((line) => stripSlackSentenceEnding(line))),
      ]);
  const unmatchedTopics = args.partialFollowupResolutionReport.unmatchedTopics;
  const unmatchedReply = unmatchedTopics.length === 1
    ? `「${unmatchedTopics[0]}」に対応する既存 issue は見当たらないため、必要なら別 issue として起票してください。`
    : composeSlackReply([
        "既存 issue が見当たらない項目があります。",
        formatSlackBullets(unmatchedTopics.map((topic) => `${topic}: 必要なら別 issue として起票してください`)),
      ]);
  return composeSlackReply([successReply, unmatchedReply]);
}

export async function resolvePartialFollowupResolutionForReply(args: {
  config: AppConfig;
  paths: ThreadPaths;
  message: {
    channelId: string;
    rootThreadTs: string;
    messageTs: string;
    text: string;
  };
  intent: ManagerIntentReport["intent"] | undefined;
  committed: ManagerCommittedCommand[];
  commitRejections: ManagerProposalRejection[];
  partialFollowupResolutionReport: PartialFollowupResolutionReport | undefined;
  systemThreadContext: SystemThreadContext | undefined;
  logger?: Pick<Console, "info" | "warn">;
}): Promise<PartialFollowupResolutionReport | undefined> {
  if (!isMutableIntent(args.intent) || args.committed.length === 0 || args.commitRejections.length > 0) {
    return args.partialFollowupResolutionReport;
  }
  if (args.partialFollowupResolutionReport?.unmatchedTopics.length) {
    return args.partialFollowupResolutionReport;
  }
  if (!args.systemThreadContext || args.systemThreadContext.issueRefs.length === 0) {
    return args.partialFollowupResolutionReport;
  }

  const committedIssueIds = unique(args.committed.flatMap((entry) => entry.issueIds))
    .filter((issueId) => /^AIC-\d+$/.test(issueId));
  if (committedIssueIds.length === 0) {
    return args.partialFollowupResolutionReport;
  }

  let fallbackResult: PartialFollowupUnmatchedResult;
  try {
    fallbackResult = await runPartialFollowupUnmatchedTurn(args.config, args.paths, {
      messageText: args.message.text,
      committedIssueIds,
      referencedIssues: args.systemThreadContext.issueRefs.map((entry) => ({
        issueId: entry.issueId,
        titleHint: entry.titleHint,
        role: entry.role,
      })),
      taskKey: `${args.message.channelId}-${args.message.rootThreadTs}-${args.message.messageTs}-partial-followup-unmatched`,
    });
  } catch (error) {
    args.logger?.warn("Partial follow-up unmatched fallback failed", {
      channelId: args.message.channelId,
      threadTs: args.message.rootThreadTs,
      messageTs: args.message.messageTs,
      error: error instanceof Error ? error.message : String(error),
    });
    return args.partialFollowupResolutionReport;
  }

  if (fallbackResult.unmatchedTopics.length === 0) {
    return args.partialFollowupResolutionReport;
  }

  const matchedIssueIds = fallbackResult.matchedIssueIds
    .filter((issueId) => committedIssueIds.includes(issueId));
  if (matchedIssueIds.length === 0) {
    return args.partialFollowupResolutionReport;
  }

  args.logger?.info("Recovered partial follow-up unmatched topics via fallback planner", {
    channelId: args.message.channelId,
    threadTs: args.message.rootThreadTs,
    messageTs: args.message.messageTs,
    matchedIssueIds,
    unmatchedTopics: fallbackResult.unmatchedTopics,
  });

  return {
    matchedIssueIds,
    unmatchedTopics: fallbackResult.unmatchedTopics,
    summary: fallbackResult.reasoningSummary,
  };
}

export function mergeAgentReplyWithCommit(args: {
  agentReply: string;
  commitSummaries: string[];
  commitRejections: ManagerProposalRejection[];
  preferCommittedPublicReply?: boolean;
  preferRejectionReply?: boolean;
}): string {
  const paragraphs: string[] = [];
  const normalizedAgentReply = args.agentReply.trim();
  const visibleCommitSummaries = normalizedAgentReply
    ? args.commitSummaries.filter((summary) => !shouldSuppressCommitSummary(normalizedAgentReply, summary))
    : args.commitSummaries;
  const rejectionReply = buildCommitRejectionReply(args.commitRejections);
  if (args.preferRejectionReply && rejectionReply) {
    return rejectionReply;
  }
  const shouldUseCommitSummaryAsPrimaryReply = args.preferCommittedPublicReply
    && visibleCommitSummaries.length > 0
    && (!normalizedAgentReply || looksLikePreCommitAgentReply(normalizedAgentReply));
  if (shouldUseCommitSummaryAsPrimaryReply) {
    paragraphs.push(...visibleCommitSummaries);
    if (rejectionReply) {
      paragraphs.push(rejectionReply);
    }
    return composeSlackReply(paragraphs);
  }

  if (normalizedAgentReply) {
    paragraphs.push(normalizedAgentReply);
  }
  if (visibleCommitSummaries.length > 0) {
    if (normalizedAgentReply) {
      paragraphs.push(formatCommitLogs(visibleCommitSummaries));
    } else {
      paragraphs.push(...visibleCommitSummaries);
    }
  }
  if (rejectionReply) {
    paragraphs.push(rejectionReply);
  }

  return composeSlackReply(paragraphs.filter(Boolean));
}
