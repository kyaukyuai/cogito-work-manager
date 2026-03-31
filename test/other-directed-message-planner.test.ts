import { describe, expect, it } from "vitest";
import {
  buildOtherDirectedMessagePrompt,
  parseOtherDirectedMessageReply,
  runOtherDirectedMessageTurnWithExecutor,
} from "../src/planners/other-directed-message/index.js";

const baseInput = {
  messageText: "田平さん、契約書ですがこちらご確認ください。",
  recentThreadEntries: [
    {
      userId: "U123",
      text: "法務確認のフローをこの thread で進めます。",
    },
  ],
  ownerEntries: [
    {
      entryId: "m.tahira",
      linearAssignee: "m.tahira@opt.ne.jp",
      keywords: ["田平", "田平誠人"],
      slackUserId: "U456",
    },
  ],
  assistantName: "コギト",
  workspaceAgents: "Keep replies short.",
  workspaceMemory: "Contract-review threads often map to AIC-55.",
};

describe("other-directed-message planner", () => {
  it("builds a classifier prompt with schema and owner candidates", () => {
    const prompt = buildOtherDirectedMessagePrompt(baseInput);

    expect(prompt).toContain('"classification":"to_other_person"|"to_cogito"|"unclear"');
    expect(prompt).toContain("selectedOwnerEntryId must be omitted");
    expect(prompt).toContain("Assistant name: コギト");
    expect(prompt).toContain("Latest Slack message:");
    expect(prompt).toContain("田平さん、契約書ですがこちらご確認ください。");
    expect(prompt).toContain("Recent thread context");
    expect(prompt).toContain("法務確認のフローをこの thread で進めます。");
    expect(prompt).toContain("Owner-map entries:");
    expect(prompt).toContain("entryId: m.tahira");
    expect(prompt).toContain("keywords: 田平, 田平誠人");
  });

  it("parses valid classifier replies", () => {
    const parsed = parseOtherDirectedMessageReply(
      '{"classification":"to_other_person","confidence":0.83,"selectedOwnerEntryId":"m.tahira","reasoningSummary":"The message is directed to Tahira-san."}',
      ["m.tahira"],
    );

    expect(parsed).toEqual({
      classification: "to_other_person",
      confidence: 0.83,
      selectedOwnerEntryId: "m.tahira",
      reasoningSummary: "The message is directed to Tahira-san.",
    });
  });

  it("rejects selectedOwnerEntryId values outside the provided candidates", () => {
    expect(() => parseOtherDirectedMessageReply(
      '{"classification":"to_other_person","confidence":0.83,"selectedOwnerEntryId":"unknown","reasoningSummary":"The message is directed elsewhere."}',
      ["m.tahira"],
    )).toThrow("selectedOwnerEntryId must be one of the provided owner candidates");
  });

  it("supports to_cogito and unclear outcomes without a selected owner", async () => {
    await expect(
      runOtherDirectedMessageTurnWithExecutor(
        async () => '{"classification":"to_cogito","confidence":0.88,"reasoningSummary":"This is an assistant-directed request."}',
        baseInput,
      ),
    ).resolves.toEqual({
      classification: "to_cogito",
      confidence: 0.88,
      reasoningSummary: "This is an assistant-directed request.",
      selectedOwnerEntryId: undefined,
    });

    await expect(
      runOtherDirectedMessageTurnWithExecutor(
        async () => '{"classification":"unclear","confidence":0.44,"reasoningSummary":"The direction is ambiguous."}',
        baseInput,
      ),
    ).resolves.toEqual({
      classification: "unclear",
      confidence: 0.44,
      reasoningSummary: "The direction is ambiguous.",
      selectedOwnerEntryId: undefined,
    });
  });

  it("allows to_other_person without a selected owner", async () => {
    await expect(
      runOtherDirectedMessageTurnWithExecutor(
        async () => '{"classification":"to_other_person","confidence":0.73,"reasoningSummary":"The message is directed to another person, but the owner map does not identify them safely."}',
        baseInput,
      ),
    ).resolves.toEqual({
      classification: "to_other_person",
      confidence: 0.73,
      reasoningSummary: "The message is directed to another person, but the owner map does not identify them safely.",
      selectedOwnerEntryId: undefined,
    });
  });
});
