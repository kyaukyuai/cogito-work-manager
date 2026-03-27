import { describe, expect, it } from "vitest";
import { extractDuplicateResolutionSummaries } from "../src/lib/manager-command-commit.js";

describe("manager agent reports", () => {
  it("extracts duplicate resolution summaries from resolved candidate tool calls", () => {
    const summaries = extractDuplicateResolutionSummaries([
      {
        toolName: "linear_resolve_duplicate_candidates",
        details: {
          extraQueries: ["角井 chatgpt 招待"],
          finalCandidates: [
            {
              identifier: "AIC-61",
              title: "金澤さんのChatGPTプロジェクトに角井さんを招待してもらう",
            },
          ],
          assessment: {
            assessmentStatus: "fuzzy",
            recommendedAction: "clarify",
            reasonSummary: "既存 issue は近いですが対象者が不足しています。",
            missingSlots: ["角井"],
          },
        },
      },
    ]);

    expect(summaries).toEqual([
      {
        assessmentStatus: "fuzzy",
        recommendedAction: "clarify",
        reasonSummary: "既存 issue は近いですが対象者が不足しています。",
        extraQueries: ["角井 chatgpt 招待"],
        finalCandidateIds: ["AIC-61"],
      },
    ]);
  });

  it("ignores malformed duplicate resolution details", () => {
    const summaries = extractDuplicateResolutionSummaries([
      {
        toolName: "linear_resolve_duplicate_candidates",
        details: {
          assessment: {
            assessmentStatus: "invalid",
            recommendedAction: "clarify",
          },
        },
      },
      {
        toolName: "linear_search_issues",
        details: {
          assessment: {
            assessmentStatus: "exact",
            recommendedAction: "link_existing",
            reasonSummary: "ignored",
          },
        },
      },
    ]);

    expect(summaries).toEqual([]);
  });
});
