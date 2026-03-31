import { describe, expect, it } from "vitest";
import {
  analyzeSlackMessageProcessability,
  classifyTaskIntent,
  extractPlainTextOtherDirectedCandidates,
  isProcessableSlackMessage,
  normalizeSlackMessage,
} from "../src/lib/slack.js";

describe("slack helpers", () => {
  const allowed = new Set(["C123"]);
  const ownerMap = {
    defaultOwner: "kyaukyuai",
    entries: [
      {
        id: "m.tahira",
        domains: [],
        keywords: ["田平", "田平誠人"],
        linearAssignee: "m.tahira@opt.ne.jp",
        slackUserId: "U456",
        primary: false,
      },
      {
        id: "kyaukyuai",
        domains: [],
        keywords: ["金澤"],
        linearAssignee: "kyaukyuai",
        slackUserId: "U789",
        primary: true,
      },
    ],
  } as const;

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

  it("extracts plain-text direct-address owner candidates when the owner-map target is unique", () => {
    const detected = extractPlainTextOtherDirectedCandidates(
      "田平さん、契約書ですがこちらご確認ください。",
      ownerMap,
    );

    expect(detected).toEqual(
      expect.objectContaining({
        signalFamilies: expect.arrayContaining(["line-opener"]),
        ownerCandidates: [
          expect.objectContaining({
            entryId: "m.tahira",
            slackUserId: "U456",
            matchedSignalFamilies: expect.arrayContaining(["line-opener"]),
          }),
        ],
      }),
    );
  });

  it("extracts directed-verb signal families when the owner-map target is unique", () => {
    const detected = extractPlainTextOtherDirectedCandidates(
      "契約書の最新版です。田平 に確認お願いします。",
      ownerMap,
    );

    expect(detected?.signalFamilies).toContain("directed-verb");
    expect(detected?.ownerCandidates[0]?.entryId).toBe("m.tahira");
  });

  it("keeps coarse signal extraction even when owner-map resolution is ambiguous", () => {
    const ambiguousOwnerMap = {
      defaultOwner: "kyaukyuai",
      entries: [
        ownerMap.entries[0],
        {
          id: "tahira-secondary",
          domains: [],
          keywords: ["田平"],
          linearAssignee: "other.tahira",
          slackUserId: "U999",
          primary: false,
        },
      ],
    } as const;

    const detected = extractPlainTextOtherDirectedCandidates(
      "田平さん、こちら確認お願いします。",
      ambiguousOwnerMap,
    );

    expect(detected?.signalFamilies).toContain("line-opener");
    expect(detected?.ownerCandidates.map((candidate) => candidate.entryId)).toEqual(
      expect.arrayContaining(["m.tahira", "tahira-secondary"]),
    );
  });

  it("extracts generic direct-address signals even when no owner-map match exists", () => {
    const detected = extractPlainTextOtherDirectedCandidates(
      "山田さん、こちら確認お願いします。",
      ownerMap,
    );

    expect(detected?.signalFamilies).toContain("line-opener");
    expect(detected?.ownerCandidates).toEqual([]);
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
