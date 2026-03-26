import type { OwnerMapEntry } from "../../../state/manager-state-contract.js";
import type {
  ManagerCommandHandlerResult,
  PostSlackMessageProposal,
} from "../contracts.js";
import type { CommitManagerCommandArgs } from "../contracts.js";

function hasDisallowedSlackMentionToken(text: string): boolean {
  return /<@[^>]+>|<!subteam\^[^>]+>|<#(?:C|G|D)[^>]*>|@(?:channel|here|everyone)\b/i.test(text);
}

function validatePostSlackMessageProposal(
  args: CommitManagerCommandArgs,
  proposal: PostSlackMessageProposal,
  ownerMap: { entries: OwnerMapEntry[] },
): string | undefined {
  const messageText = proposal.messageText.trim();
  if (!messageText) {
    return "Slack 投稿本文が空です。messageText を明示してください。";
  }
  if (hasDisallowedSlackMentionToken(messageText)) {
    return "本文に追加の user/group/channel mention は含められません。1 投稿 1 target のみ対応しています。";
  }
  const mappedEntry = ownerMap.entries.find((entry) => entry.slackUserId === proposal.mentionSlackUserId);
  if (!mappedEntry) {
    return "mentionSlackUserId が owner-map.json に存在しません。workspace_get_owner_map を確認してください。";
  }

  if (proposal.destination === "current-thread") {
    if (args.message.channelId.startsWith("D")) {
      return "DM へのメンション投稿はこの scope では対応していません。";
    }
    if (!args.config.slackAllowedChannelIds.has(args.message.channelId)) {
      return "この thread は許可済み channel ではないため、メンション投稿できません。";
    }
    return undefined;
  }

  if (!args.policy.controlRoomChannelId?.trim()) {
    return "control room channel が policy に設定されていません。";
  }
  if (args.policy.controlRoomChannelId.startsWith("D")) {
    return "control room を DM に設定することはできません。";
  }
  if (!args.config.slackAllowedChannelIds.has(args.policy.controlRoomChannelId)) {
    return "control room channel が許可済み channel に含まれていません。";
  }
  return undefined;
}

export async function commitPostSlackMessageProposal(
  args: CommitManagerCommandArgs,
  proposal: PostSlackMessageProposal,
): Promise<ManagerCommandHandlerResult> {
  if (!args.postSlackMessage) {
    return {
      proposal,
      reason: "Slack メンション投稿は現在利用できません。",
    };
  }

  const ownerMap = await args.repositories.ownerMap.load();
  const validationError = validatePostSlackMessageProposal(args, proposal, ownerMap);
  if (validationError) {
    return {
      proposal,
      reason: validationError,
    };
  }

  const channel = proposal.destination === "control-room-root"
    ? args.policy.controlRoomChannelId
    : args.message.channelId;
  const threadTs = proposal.destination === "current-thread"
    ? args.message.rootThreadTs
    : undefined;

  await args.postSlackMessage({
    channel,
    threadTs,
    mentionSlackUserId: proposal.mentionSlackUserId,
    messageText: proposal.messageText.trim(),
  });

  return {
    commandType: proposal.commandType,
    issueIds: [],
    summary: proposal.destination === "control-room-root"
      ? `control room に ${proposal.targetLabel} 宛てのメッセージを投稿しました。`
      : `この thread に ${proposal.targetLabel} 宛てのメッセージを投稿しました。`,
  };
}
