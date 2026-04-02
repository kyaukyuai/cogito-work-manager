export interface RawSlackMessageEvent {
  text?: string;
  channel: string;
  user?: string;
  ts: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
  channel_type?: string;
  files?: Array<{
    id?: string;
    name: string;
    mimetype?: string;
    filetype?: string;
    url_private_download?: string;
    url_private?: string;
  }>;
}

export interface NormalizedSlackMessage {
  channelId: string;
  userId: string;
  ts: string;
  rootThreadTs: string;
  text: string;
  files: RawSlackMessageEvent["files"];
}

export type TaskIntent = "task_request" | "conversation";
export type SlackMessageIgnoreReason =
  | "ignored_non_allowed_channel"
  | "ignored_dm"
  | "ignored_bot_message"
  | "ignored_self_message"
  | "ignored_unsupported_subtype"
  | "ignored_empty_message"
  | "ignored_other_user_mention_without_bot"
  | "ignored_other_directed_message_without_bot"
  | "ignored_human_to_human_smalltalk_without_bot";

export interface SlackMessageProcessability {
  shouldProcess: boolean;
  reason?: SlackMessageIgnoreReason;
  mentionedUserIds: string[];
  hasBotMention: boolean;
}

const USER_MENTION_PATTERN = /<@([A-Z0-9]+)>/g;

function extractMentionedUserIds(text: string | undefined): string[] {
  if (!text) return [];

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

export function analyzeSlackMessageProcessability(
  event: RawSlackMessageEvent,
  botUserId: string,
  allowedChannelIds: Set<string>,
): SlackMessageProcessability {
  if (!allowedChannelIds.has(event.channel)) {
    return { shouldProcess: false, reason: "ignored_non_allowed_channel", mentionedUserIds: [], hasBotMention: false };
  }
  if (event.channel_type === "im") {
    return { shouldProcess: false, reason: "ignored_dm", mentionedUserIds: [], hasBotMention: false };
  }
  if (event.bot_id) {
    return { shouldProcess: false, reason: "ignored_bot_message", mentionedUserIds: [], hasBotMention: false };
  }
  if (!event.user || event.user === botUserId) {
    return { shouldProcess: false, reason: "ignored_self_message", mentionedUserIds: [], hasBotMention: false };
  }
  if (event.subtype !== undefined && event.subtype !== "file_share") {
    return { shouldProcess: false, reason: "ignored_unsupported_subtype", mentionedUserIds: [], hasBotMention: false };
  }

  const text = (event.text ?? "").trim();
  if (!text && (!event.files || event.files.length === 0)) {
    return { shouldProcess: false, reason: "ignored_empty_message", mentionedUserIds: [], hasBotMention: false };
  }

  const mentionedUserIds = extractMentionedUserIds(text);
  const hasBotMention = mentionedUserIds.includes(botUserId);
  const hasNonBotUserMention = mentionedUserIds.some((userId) => userId !== botUserId);
  if (hasNonBotUserMention && !hasBotMention) {
    return {
      shouldProcess: false,
      reason: "ignored_other_user_mention_without_bot",
      mentionedUserIds,
      hasBotMention,
    };
  }

  return {
    shouldProcess: true,
    mentionedUserIds,
    hasBotMention,
  };
}

export function isProcessableSlackMessage(
  event: RawSlackMessageEvent,
  botUserId: string,
  allowedChannelIds: Set<string>,
): boolean {
  return analyzeSlackMessageProcessability(event, botUserId, allowedChannelIds).shouldProcess;
}

export function normalizeSlackMessage(event: RawSlackMessageEvent): NormalizedSlackMessage {
  return {
    channelId: event.channel,
    userId: event.user ?? "",
    ts: event.ts,
    rootThreadTs: event.thread_ts ?? event.ts,
    text: (event.text ?? "").trim(),
    files: event.files ?? [],
  };
}

export function classifyTaskIntent(text: string): TaskIntent {
  const normalized = text.trim();
  if (!normalized) return "conversation";

  const taskPattern =
    /(linear|issue|イシュー|ticket|チケット|todo|タスク|登録|追加|作成|作って|確認して|一覧|完了にして|終わった|閉じて|更新して|track|create|add|open|list|check|complete|close|update)/i;

  return taskPattern.test(normalized) ? "task_request" : "conversation";
}
