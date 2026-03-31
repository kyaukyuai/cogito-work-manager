import { describe, expect, it } from "vitest";
import {
  buildOtherDirectedMessagePrompt,
  parseOtherDirectedMessageReply,
  runOtherDirectedMessageTurnWithExecutor,
} from "../src/planners/other-directed-message/index.js";

const baseInput = {
  messageText: "田平さん、契約書ですがこちらご確認ください。",
  signalFamilies: ["line-opener", "directed-verb"] as const,
  ownerCandidates: [
    {
      entryId: "m.tahira",
      label: "田平",
      slackUserId: "U456",
      matchSource: "keyword" as const,
      matchedSignalFamilies: ["line-opener", "directed-verb"] as const,
    },
  ],
  workspaceAgents: "Keep replies short.",
  workspaceMemory: "Contract-review threads often map to AIC-55.",
};

describe("other-directed-message planner", () => {
  it("builds a classifier prompt with schema and owner candidates", () => {
    const prompt = buildOtherDirectedMessagePrompt(baseInput);

    expect(prompt).toContain('"classification":"to_other_person"|"to_cogito"|"unclear"');
    expect(prompt).toContain("selectedOwnerEntryId must be omitted");
    expect(prompt).toContain("Latest Slack message:");
    expect(prompt).toContain("田平さん、契約書ですがこちらご確認ください。");
    expect(prompt).toContain("Owner-map candidates:");
    expect(prompt).toContain("entryId: m.tahira");
    expect(prompt).toContain("matchedSignalFamilies: line-opener, directed-verb");
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
});
