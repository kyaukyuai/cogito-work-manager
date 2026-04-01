import { describe, expect, it } from "vitest";
import {
  buildPartialFollowupUnmatchedPrompt,
  parsePartialFollowupUnmatchedReply,
  runPartialFollowupUnmatchedTurnWithExecutor,
} from "../src/planners/partial-followup-unmatched/index.js";

const baseInput = {
  messageText: "取得すべきmtg定例の名前と議事録連携は、後回しになりました",
  committedIssueIds: ["AIC-87"],
  referencedIssues: [
    { issueId: "AIC-86", titleHint: "役員チャンネル招待", role: "related" as const },
    { issueId: "AIC-87", titleHint: "収集すべきMTG定例名", role: "primary" as const },
  ],
  workspaceAgents: "Keep replies short.",
  workspaceMemory: "Review thread follow-ups may mention multiple subtopics in one sentence.",
};

describe("partial-followup-unmatched planner", () => {
  it("builds a prompt that asks for unmatched follow-up subtopics", () => {
    const prompt = buildPartialFollowupUnmatchedPrompt(baseInput);

    expect(prompt).toContain('"matchedIssueIds":string[]');
    expect(prompt).toContain('"unmatchedTopics":string[]');
    expect(prompt).toContain("If a separate noun phrase or workstream is not clearly covered");
    expect(prompt).toContain("Committed issue IDs: AIC-87");
    expect(prompt).toContain("AIC-86");
    expect(prompt).toContain("収集すべきMTG定例名");
  });

  it("parses valid unmatched-topic replies", () => {
    const parsed = parsePartialFollowupUnmatchedReply(
      '{"matchedIssueIds":["AIC-87"],"unmatchedTopics":["議事録連携"],"reasoningSummary":"Meeting-notes integration is not covered by the referenced issue titles."}',
      ["AIC-87"],
    );

    expect(parsed).toEqual({
      matchedIssueIds: ["AIC-87"],
      unmatchedTopics: ["議事録連携"],
      reasoningSummary: "Meeting-notes integration is not covered by the referenced issue titles.",
    });
  });

  it("rejects matchedIssueIds outside the committed issue set", () => {
    expect(() => parsePartialFollowupUnmatchedReply(
      '{"matchedIssueIds":["AIC-55"],"unmatchedTopics":["議事録連携"],"reasoningSummary":"Wrong issue."}',
      ["AIC-87"],
    )).toThrow("matchedIssueIds must be chosen from committedIssueIds");
  });

  it("allows an empty unmatchedTopics array when nothing is missing", async () => {
    await expect(
      runPartialFollowupUnmatchedTurnWithExecutor(
        async () => '{"matchedIssueIds":["AIC-87"],"unmatchedTopics":[],"reasoningSummary":"All meaningful subtopics are covered by AIC-87."}',
        baseInput,
      ),
    ).resolves.toEqual({
      matchedIssueIds: ["AIC-87"],
      unmatchedTopics: [],
      reasoningSummary: "All meaningful subtopics are covered by AIC-87.",
    });
  });
});
