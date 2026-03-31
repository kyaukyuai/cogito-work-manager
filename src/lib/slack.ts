import type { OwnerMap } from "../state/manager-state-contract.js";

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
  | "ignored_other_directed_message_without_bot";

export interface SlackMessageProcessability {
  shouldProcess: boolean;
  reason?: SlackMessageIgnoreReason;
  mentionedUserIds: string[];
  hasBotMention: boolean;
}

export interface PlainTextOtherDirectedResolution {
  entryId: string;
  label: string;
  slackUserId?: string;
  matchSource: "id" | "linearAssignee" | "keyword";
}

export type PlainTextOtherDirectedSignalFamily = "line-opener" | "directed-verb" | "repeated-target";

export interface PlainTextOtherDirectedOwnerCandidate extends PlainTextOtherDirectedResolution {
  matchedSignalFamilies: PlainTextOtherDirectedSignalFamily[];
}

export interface PlainTextOtherDirectedCandidateExtraction {
  signalFamilies: PlainTextOtherDirectedSignalFamily[];
  ownerCandidates: PlainTextOtherDirectedOwnerCandidate[];
}

const USER_MENTION_PATTERN = /<@([A-Z0-9]+)>/g;
const HONORIFIC_PATTERN = "(?:さん|君|くん|さま|様|殿|氏)?";
const REQUIRED_HONORIFIC_PATTERN = "(?:さん|君|くん|さま|様|殿|氏)";
const COORDINATION_VERB_PATTERN = "(?:確認|共有|送付|送信|依頼|お願い|対応|見て|回して|知らせて)";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeComparableText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function stripSlackMentions(text: string): string {
  return text.replace(/<@[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function buildComparableLabels(ownerMap: OwnerMap): PlainTextOtherDirectedResolution[] {
  const resolutions: PlainTextOtherDirectedResolution[] = [];
  for (const entry of ownerMap.entries) {
    const candidates: Array<{ value: string; matchSource: PlainTextOtherDirectedResolution["matchSource"] }> = [
      { value: entry.id, matchSource: "id" },
      { value: entry.linearAssignee, matchSource: "linearAssignee" },
      ...entry.keywords.map((keyword) => ({ value: keyword, matchSource: "keyword" as const })),
    ];
    for (const candidate of candidates) {
      const label = normalizeComparableText(candidate.value);
      if (!label) continue;
      resolutions.push({
        entryId: entry.id,
        label,
        slackUserId: entry.slackUserId,
        matchSource: candidate.matchSource,
      });
    }
  }
  return resolutions;
}

function buildHonorificAwareLabelPattern(label: string): string {
  return `${escapeRegExp(label)}${HONORIFIC_PATTERN}`;
}

function uniqueSignalFamilies(value: Iterable<PlainTextOtherDirectedSignalFamily>): PlainTextOtherDirectedSignalFamily[] {
  return Array.from(new Set(value));
}

function extractGenericSignalFamilies(text: string): PlainTextOtherDirectedSignalFamily[] {
  const normalized = normalizeComparableText(stripSlackMentions(text));
  if (!normalized) {
    return [];
  }

  const detected = new Set<PlainTextOtherDirectedSignalFamily>();
  const firstNonEmptyLine = text
    .split(/\r?\n/)
    .map((line) => normalizeComparableText(stripSlackMentions(line)))
    .find(Boolean);
  if (firstNonEmptyLine && new RegExp(`^[^\\s、,，。.!！?？]{1,30}${REQUIRED_HONORIFIC_PATTERN}(?:[、,，。.!！?？\\s]|$)`, "i").test(firstNonEmptyLine)) {
    detected.add("line-opener");
  }

  if (new RegExp(`[^\\s、,，。.!！?？]{1,30}${REQUIRED_HONORIFIC_PATTERN}\\s*(?:に|へ)[^\\n\\r]*${COORDINATION_VERB_PATTERN}`, "i").test(normalized)) {
    detected.add("directed-verb");
  }

  const repeatedMatches = Array.from(
    normalized.matchAll(new RegExp(`([^\\s、,，。.!！?？]{1,30})${REQUIRED_HONORIFIC_PATTERN}`, "ig")),
  ).map((match) => match[1]?.toLowerCase()).filter((value): value is string => Boolean(value));
  const repeatedCounts = new Map<string, number>();
  for (const label of repeatedMatches) {
    repeatedCounts.set(label, (repeatedCounts.get(label) ?? 0) + 1);
  }
  if (Array.from(repeatedCounts.values()).some((count) => count >= 2) && new RegExp(COORDINATION_VERB_PATTERN, "i").test(normalized)) {
    detected.add("repeated-target");
  }

  return Array.from(detected);
}

function matchResolutionSignalFamilies(
  text: string,
  resolution: PlainTextOtherDirectedResolution,
): PlainTextOtherDirectedSignalFamily[] {
  const normalized = normalizeComparableText(stripSlackMentions(text));
  if (!normalized) {
    return [];
  }

  const detected = new Set<PlainTextOtherDirectedSignalFamily>();
  const firstNonEmptyLine = text
    .split(/\r?\n/)
    .map((line) => normalizeComparableText(stripSlackMentions(line)))
    .find(Boolean);
  const labelPattern = buildHonorificAwareLabelPattern(resolution.label);
  if (firstNonEmptyLine && new RegExp(`^${labelPattern}(?:[、,，。.!！?？\\s]|$)`, "i").test(firstNonEmptyLine)) {
    detected.add("line-opener");
  }

  if (new RegExp(`${labelPattern}\\s*(?:に|へ)[^\\n\\r]*${COORDINATION_VERB_PATTERN}`, "i").test(normalized)) {
    detected.add("directed-verb");
  }

  const repeatedMatches = normalized.match(new RegExp(labelPattern, "ig")) ?? [];
  if (repeatedMatches.length >= 2 && new RegExp(COORDINATION_VERB_PATTERN, "i").test(normalized)) {
    detected.add("repeated-target");
  }

  return Array.from(detected);
}

export function extractPlainTextOtherDirectedCandidates(
  text: string,
  ownerMap?: OwnerMap,
): PlainTextOtherDirectedCandidateExtraction | undefined {
  const normalized = normalizeComparableText(stripSlackMentions(text));
  if (!normalized) {
    return undefined;
  }

  const signalFamilies = new Set<PlainTextOtherDirectedSignalFamily>(extractGenericSignalFamilies(text));
  const ownerCandidatesByEntryId = new Map<string, PlainTextOtherDirectedOwnerCandidate>();

  for (const resolution of ownerMap ? buildComparableLabels(ownerMap) : []) {
    const matchedSignalFamilies = matchResolutionSignalFamilies(text, resolution);
    if (matchedSignalFamilies.length === 0) {
      continue;
    }
    for (const family of matchedSignalFamilies) {
      signalFamilies.add(family);
    }
    const existing = ownerCandidatesByEntryId.get(resolution.entryId);
    if (existing) {
      existing.matchedSignalFamilies = uniqueSignalFamilies([
        ...existing.matchedSignalFamilies,
        ...matchedSignalFamilies,
      ]);
      continue;
    }
    ownerCandidatesByEntryId.set(resolution.entryId, {
      ...resolution,
      matchedSignalFamilies: matchedSignalFamilies,
    });
  }

  if (signalFamilies.size === 0) {
    return undefined;
  }

  return {
    signalFamilies: Array.from(signalFamilies),
    ownerCandidates: Array.from(ownerCandidatesByEntryId.values()),
  };
}

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
