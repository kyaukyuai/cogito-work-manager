import type { LinearIssue } from "../../lib/linear.js";

type SlackIssueLabel = Pick<LinearIssue, "identifier" | "title"> & { url?: string | null };
const SLACK_OUTBOUND_MENTION_CAPABILITY_QUERY_PATTERN = /(?:(?<target><@[^>]+>|@?[^\s、,。!?？]+)\s*に\s*)?(?:メンション|mention)(?:[^。\n\r]*?)(?:できる|できます|可能|送れる|送信できる)(?:の)?[？?]*$/i;
const SLACK_OUTBOUND_POST_REQUEST_SIGNAL_PATTERN = /(?:メンション(?:して|を付けて)|mention(?:して)?).*(?:送って|送信して|投稿して|メッセージ送信して)/i;
const SLACK_CONTROL_ROOM_PATTERN = /(?:control\s*room|control-room|コントロールルーム)/i;

export interface SlackCapabilityQueryFacts {
  type: "slack-outbound-mention";
  targetLabel?: string;
  supported: true;
  requestedOperationLabel: string;
  supportSummary: string;
  limitationSummary: string;
}

export interface SlackOutboundPostRequestHint {
  destination: "current-thread" | "control-room-root";
}

function cleanCapabilityTargetLabel(value: string | undefined): string | undefined {
  const normalized = value
    ?.trim()
    .replace(/^[「"'`]+|[」"'`]+$/g, "")
    .trim();
  return normalized || undefined;
}

export function detectSlackCapabilityQuery(text: string): SlackCapabilityQueryFacts | undefined {
  const normalized = text.trim();
  if (!normalized) return undefined;

  const mentionMatch = normalized.match(SLACK_OUTBOUND_MENTION_CAPABILITY_QUERY_PATTERN);
  if (!mentionMatch) {
    return undefined;
  }

  return {
    type: "slack-outbound-mention",
    targetLabel: cleanCapabilityTargetLabel(mentionMatch.groups?.target),
    supported: true,
    requestedOperationLabel: "任意ユーザーへのメンション付きメッセージ送信",
    supportSummary: "明示依頼なら、owner-map に slackUserId がある相手へ 1 件だけメンション投稿できます。",
    limitationSummary: "別系統として review / heartbeat の follow-up では必要なときだけ担当者をメンションしますが、これは内部通知用です。任意メッセージ送信として使えるのは既定でこの thread、明示時のみ control room root です。DM、任意 channel、複数 target、追加 mention はできません。",
  };
}

export function buildSlackCapabilityReply(facts: SlackCapabilityQueryFacts): string {
  const targetPrefix = facts.targetLabel ? `${facts.targetLabel} への` : "任意ユーザーへの";
  return `${targetPrefix}メンション付きメッセージ送信は限定的に対応しています。${facts.supportSummary} ${facts.limitationSummary}`;
}

export function detectSlackOutboundPostRequest(text: string): SlackOutboundPostRequestHint | undefined {
  const normalized = text.trim();
  if (!normalized) return undefined;
  if (!SLACK_OUTBOUND_POST_REQUEST_SIGNAL_PATTERN.test(normalized)) {
    return undefined;
  }
  return {
    destination: SLACK_CONTROL_ROOM_PATTERN.test(normalized)
      ? "control-room-root"
      : "current-thread",
  };
}

export function truncateSlackText(text: string, maxLength = 80): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function buildSlackTargetLabel(
  issue: SlackIssueLabel,
  maxLength = 80,
): string {
  const label = `${issue.identifier} ${truncateSlackText(issue.title, maxLength)}`;
  return issue.url ? `<${issue.url}|${label}>` : label;
}

function joinNaturalLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  if (labels.length === 2) return `${labels[0]} と ${labels[1]}`;
  return `${labels.slice(0, -1).join("、")}、${labels[labels.length - 1]}`;
}

export function formatSlackIssueListSentence(args: {
  subject: string;
  issues: SlackIssueLabel[];
  limit?: number;
  titleMaxLength?: number;
}): string | undefined {
  if (args.issues.length === 0) return undefined;
  const limit = args.limit ?? 2;
  const titleMaxLength = args.titleMaxLength ?? 80;
  const visible = args.issues
    .slice(0, limit)
    .map((issue) => buildSlackTargetLabel(issue, titleMaxLength));
  const overflow = args.issues.length > limit ? ` ほか${args.issues.length - limit}件あります。` : "";
  return `${args.subject}${joinNaturalLabels(visible)} です。${overflow}`;
}

export function formatSlackBullets(lines: Array<string | undefined>): string | undefined {
  const visible = lines
    .map((line) => line?.trim())
    .filter((line): line is string => Boolean(line));
  if (visible.length === 0) return undefined;
  return visible.map((line) => (line.startsWith("- ") ? line : `- ${line}`)).join("\n");
}

export function joinSlackSentences(sentences: Array<string | undefined>): string | undefined {
  const visible = sentences
    .map((sentence) => sentence?.trim())
    .filter((sentence): sentence is string => Boolean(sentence));
  if (visible.length === 0) return undefined;
  return visible.join(" ");
}

export function composeSlackReply(paragraphs: Array<string | undefined>): string {
  return paragraphs
    .map((paragraph) => paragraph?.trim())
    .filter((paragraph): paragraph is string => Boolean(paragraph))
    .join("\n\n");
}

export function formatSlackThreadReference(reference: string, label = "こちら"): string {
  if (/^https?:\/\//.test(reference)) {
    return `<${reference}|${label}>`;
  }
  return reference;
}
