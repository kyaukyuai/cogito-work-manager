import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitManagerCommandProposals } from "../src/lib/manager-command-commit.js";
import {
  buildLinearTestEnv,
  cleanupManagerCommandCommitTestContext,
  createManagerCommandCommitTestContext,
  type ManagerCommandCommitTestContext,
} from "./manager-command-commit-test-support.js";

describe("manager command commit dispatcher", () => {
  let testContext: ManagerCommandCommitTestContext;

  beforeEach(async () => {
    testContext = await createManagerCommandCommitTestContext();
  });

  afterEach(async () => {
    await cleanupManagerCommandCommitTestContext(testContext.workspaceDir);
  });

  it("rejects create proposals that omit required decision fields", async () => {
    const result = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "create_issue",
          planningReason: "single-issue",
          issue: {
            title: "曖昧な create",
            description: "## Slack source\n曖昧です",
          },
          reasonSummary: "create したいです。",
        } as unknown as Parameters<typeof commitManagerCommandProposals>[0]["proposals"][number],
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-missing-decisions",
        messageTs: "msg-missing-decisions-1",
        userId: "U1",
        text: "issue を作って",
      },
      now: new Date("2026-03-23T00:08:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.committed).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain("判断に必要な項目が不足");
    expect(result.rejected[0]?.reason).toContain("threadParentHandling");
  });

  it("rejects multiple Slack mention posts in one turn", async () => {
    const postSlackMessage = vi.fn();

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
          reasonSummary: "1件目",
        },
        {
          commandType: "post_slack_message",
          destination: "current-thread",
          mentionSlackUserId: "U01L86BCA9X",
          targetLabel: "kyaukyuai",
          messageText: "もう1件",
          reasonSummary: "2件目",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-slack-post-multi",
        messageTs: "msg-slack-post-multi-1",
        userId: "U1",
        text: "2件送って",
      },
      now: new Date("2026-03-26T08:03:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
      postSlackMessage,
    });

    expect(result.committed).toEqual([]);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected[0]?.reason).toContain("1 turn で 1 件ずつ");
    expect(postSlackMessage).not.toHaveBeenCalled();
  });

  it("rejects mixed workspace config targets in one turn", async () => {
    const result = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "replace_workspace_text_file",
          target: "agenda-template",
          content: "## 議題\n- 共有",
          reasonSummary: "agenda template の更新です。",
        },
        {
          commandType: "update_owner_map",
          operation: "set-default-owner",
          defaultOwner: "y.kakui",
          reasonSummary: "default owner の更新です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-workspace-config-mixed",
        messageTs: "msg-workspace-config-mixed-1",
        userId: "U1",
        text: "agenda と owner-map を両方変えて",
      },
      now: new Date("2026-03-26T01:04:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    expect(result.committed).toEqual([]);
    expect(result.pendingConfirmation).toBeUndefined();
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected[0]?.reason).toContain("1 target");
  });
});
