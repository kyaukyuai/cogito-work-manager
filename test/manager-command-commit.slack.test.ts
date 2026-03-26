import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitManagerCommandProposals } from "../src/lib/manager-command-commit.js";
import {
  buildLinearTestEnv,
  cleanupManagerCommandCommitTestContext,
  createManagerCommandCommitTestContext,
  type ManagerCommandCommitTestContext,
} from "./manager-command-commit-test-support.js";

describe("manager command commit slack", () => {
  let testContext: ManagerCommandCommitTestContext;

  beforeEach(async () => {
    testContext = await createManagerCommandCommitTestContext();
  });

  afterEach(async () => {
    await cleanupManagerCommandCommitTestContext(testContext.workspaceDir);
  });

  it("posts one Slack mention message into the current thread", async () => {
    const postSlackMessage = vi.fn().mockResolvedValue({
      text: "@U01L86BCA9X こんにちは",
      ts: "123.456",
    });

    const result = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "post_slack_message",
          destination: "current-thread",
          mentionSlackUserId: "U01L86BCA9X",
          targetLabel: "kyaukyuai",
          messageText: "こんにちは",
          reasonSummary: "明示依頼されたメンション投稿です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-slack-post",
        messageTs: "msg-slack-post-1",
        userId: "U1",
        text: "kyaukyuai にメンションして、こんにちはと送って",
      },
      now: new Date("2026-03-26T08:00:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
      postSlackMessage,
    });

    expect(result.committed).toHaveLength(1);
    expect(result.committed[0]?.summary).toBe("この thread に kyaukyuai 宛てのメッセージを投稿しました。");
    expect(postSlackMessage).toHaveBeenCalledWith({
      channel: "C0ALAMDRB9V",
      threadTs: "thread-slack-post",
      mentionSlackUserId: "U01L86BCA9X",
      messageText: "こんにちは",
    });
  });

  it("posts one Slack mention message to control room root when explicitly requested", async () => {
    const postSlackMessage = vi.fn().mockResolvedValue({
      text: "@U01L86BCA9X control room で確認お願いします",
      ts: "123.457",
    });

    const result = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "post_slack_message",
          destination: "control-room-root",
          mentionSlackUserId: "U01L86BCA9X",
          targetLabel: "kyaukyuai",
          messageText: "control room で確認お願いします",
          reasonSummary: "control room への明示投稿依頼です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-slack-post-root",
        messageTs: "msg-slack-post-root-1",
        userId: "U1",
        text: "control room に kyaukyuai へ確認お願いしますと送って",
      },
      now: new Date("2026-03-26T08:01:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
      postSlackMessage,
    });

    expect(result.committed).toHaveLength(1);
    expect(result.committed[0]?.summary).toBe("control room に kyaukyuai 宛てのメッセージを投稿しました。");
    expect(postSlackMessage).toHaveBeenCalledWith({
      channel: "C0ALAMDRB9V",
      threadTs: undefined,
      mentionSlackUserId: "U01L86BCA9X",
      messageText: "control room で確認お願いします",
    });
  });

  it("rejects Slack mention posts with invalid target, body, or destination", async () => {
    const postSlackMessage = vi.fn();

    const missingTarget = await commitManagerCommandProposals({
      config: { ...testContext.config, slackAllowedChannelIds: new Set(["COTHER"]) },
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "post_slack_message",
          destination: "current-thread",
          mentionSlackUserId: "UUNKNOWN",
          targetLabel: "unknown",
          messageText: "こんにちは",
          reasonSummary: "owner-map に無い target です。",
        },
      ],
      message: {
        channelId: "D123",
        rootThreadTs: "thread-slack-post-reject",
        messageTs: "msg-slack-post-reject-1",
        userId: "U1",
        text: "メンションして送って",
      },
      now: new Date("2026-03-26T08:02:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
      postSlackMessage,
    });

    const extraMention = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "post_slack_message",
          destination: "current-thread",
          mentionSlackUserId: "U01L86BCA9X",
          targetLabel: "kyaukyuai",
          messageText: "<@U02OTHER> も見てください",
          reasonSummary: "追加 mention を含む投稿です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-slack-post-reject-2",
        messageTs: "msg-slack-post-reject-2",
        userId: "U1",
        text: "kyaukyuai にメンションして送って",
      },
      now: new Date("2026-03-26T08:02:30.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
      postSlackMessage,
    });

    const emptyBody = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "post_slack_message",
          destination: "current-thread",
          mentionSlackUserId: "U01L86BCA9X",
          targetLabel: "kyaukyuai",
          messageText: "   ",
          reasonSummary: "空本文です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-slack-post-reject-3",
        messageTs: "msg-slack-post-reject-3",
        userId: "U1",
        text: "kyaukyuai にメンションして送って",
      },
      now: new Date("2026-03-26T08:02:45.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
      postSlackMessage,
    });

    const invalidDestination = await commitManagerCommandProposals({
      config: { ...testContext.config, slackAllowedChannelIds: new Set(["COTHER"]) },
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "post_slack_message",
          destination: "current-thread",
          mentionSlackUserId: "U01L86BCA9X",
          targetLabel: "kyaukyuai",
          messageText: "こんにちは",
          reasonSummary: "許可外 channel です。",
        },
      ],
      message: {
        channelId: "D123",
        rootThreadTs: "thread-slack-post-reject-4",
        messageTs: "msg-slack-post-reject-4",
        userId: "U1",
        text: "kyaukyuai にメンションして送って",
      },
      now: new Date("2026-03-26T08:02:55.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
      postSlackMessage,
    });

    expect(missingTarget.committed).toEqual([]);
    expect(missingTarget.rejected).toHaveLength(1);
    expect(missingTarget.rejected[0]?.reason).toContain("owner-map.json");
    expect(extraMention.committed).toEqual([]);
    expect(extraMention.rejected).toHaveLength(1);
    expect(extraMention.rejected[0]?.reason).toContain("追加の user/group/channel mention");
    expect(emptyBody.committed).toEqual([]);
    expect(emptyBody.rejected).toHaveLength(1);
    expect(emptyBody.rejected[0]?.reason).toContain("本文が空");
    expect(invalidDestination.committed).toEqual([]);
    expect(invalidDestination.rejected).toHaveLength(1);
    expect(invalidDestination.rejected[0]?.reason).toContain("DM");
    expect(postSlackMessage).not.toHaveBeenCalled();
  });
});
