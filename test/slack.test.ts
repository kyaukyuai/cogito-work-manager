import { describe, expect, it } from "vitest";
import {
  analyzeSlackMessageProcessability,
  classifyTaskIntent,
  isProcessableSlackMessage,
  normalizeSlackMessage,
} from "../src/lib/slack.js";

describe("slack helpers", () => {
  const allowed = new Set(["C123"]);
  it("accepts a normal user message in an allowed channel", () => {
    expect(
      isProcessableSlackMessage(
        {
          channel: "C123",
          user: "U123",
          ts: "123.456",
          text: "タスク追加して",
        },
        "UBOT",
        allowed,
      ),
    ).toBe(true);
  });

  it("rejects messages from non-allowed channels", () => {
    expect(
      isProcessableSlackMessage(
        {
          channel: "C999",
          user: "U123",
          ts: "123.456",
          text: "hello",
        },
        "UBOT",
        allowed,
      ),
    ).toBe(false);
  });

  it("rejects bot messages and unsupported subtypes", () => {
    expect(
      isProcessableSlackMessage(
        {
          channel: "C123",
          user: "UBOT",
          ts: "123.456",
          text: "hello",
        },
        "UBOT",
        allowed,
      ),
    ).toBe(false);

    expect(
      isProcessableSlackMessage(
        {
          channel: "C123",
          user: "U123",
          ts: "123.456",
          text: "edited",
          subtype: "message_changed",
        },
        "UBOT",
        allowed,
      ),
    ).toBe(false);
  });

  it("rejects non-bot user mentions when Cogito is not mentioned", () => {
    const analysis = analyzeSlackMessageProcessability(
      {
        channel: "C123",
        user: "U123",
        ts: "123.456",
        text: "<@U456> 契約書ですがこちらご確認頂けますと！",
      },
      "UBOT",
      allowed,
    );

    expect(analysis.shouldProcess).toBe(false);
    expect(analysis.reason).toBe("ignored_other_user_mention_without_bot");
    expect(analysis.mentionedUserIds).toEqual(["U456"]);
  });

  it("allows other-user mentions when Cogito is also mentioned", () => {
    expect(
      isProcessableSlackMessage(
        {
          channel: "C123",
          user: "U123",
          ts: "123.456",
          text: "<@UBOT> <@U456> に確認依頼を送って",
        },
        "UBOT",
        allowed,
      ),
    ).toBe(true);
  });

  it("normalizes root thread timestamp", () => {
    expect(
      normalizeSlackMessage({
        channel: "C123",
        user: "U123",
        ts: "200.001",
        text: "hello",
      }).rootThreadTs,
    ).toBe("200.001");

    expect(
      normalizeSlackMessage({
        channel: "C123",
        user: "U123",
        ts: "200.002",
        thread_ts: "200.001",
        text: "reply",
      }).rootThreadTs,
    ).toBe("200.001");
  });

  it("classifies explicit task intent", () => {
    expect(classifyTaskIntent("明日の会議準備のタスクを追加して")).toBe("task_request");
    expect(classifyTaskIntent("ログイン修復の issue を作って")).toBe("task_request");
    expect(classifyTaskIntent("こんにちは")).toBe("conversation");
  });
});
