import { describe, expect, it } from "vitest";
import {
  extractAgentIssueEvidence,
  extractDuplicateResolutionSummaries,
  extractPendingConfirmationRequest,
  extractPartialFollowupResolutionReport,
} from "../src/lib/manager-command-commit.js";

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

  it("extracts partial follow-up resolution reports", () => {
    const report = extractPartialFollowupResolutionReport([
      {
        toolName: "report_partial_followup_resolution",
        details: {
          partialFollowupResolutionReport: {
            matchedIssueIds: ["AIC-87"],
            unmatchedTopics: ["議事録連携"],
            summary: "AIC-87 is matched but meeting-notes integration has no existing issue.",
          },
        },
      },
    ]);

    expect(report).toEqual({
      matchedIssueIds: ["AIC-87"],
      unmatchedTopics: ["議事録連携"],
      summary: "AIC-87 is matched but meeting-notes integration has no existing issue.",
    });
  });

  it("ignores malformed partial follow-up resolution reports", () => {
    const report = extractPartialFollowupResolutionReport([
      {
        toolName: "report_partial_followup_resolution",
        details: {
          partialFollowupResolutionReport: {
            matchedIssueIds: ["not-an-issue-id"],
            unmatchedTopics: ["議事録連携", "議事録連携"],
          },
        },
      },
    ]);

    expect(report).toBeUndefined();
  });

  it("extracts exact issue-read evidence for commit validation", () => {
    const evidence = extractAgentIssueEvidence([
      {
        toolName: "linear_search_issues",
        details: [{ identifier: "AIC-9" }],
      },
      {
        toolName: "linear_get_issue_facts",
        details: {
          identifier: "AIC-103",
          title: "FFS 活用の返答最適化",
        },
      },
      {
        toolName: "linear_resolve_duplicate_candidates",
        details: {
          extraQueries: [],
          finalCandidates: [{ identifier: "AIC-105", title: "requester profile 反映" }],
          assessment: {
            assessmentStatus: "exact",
            recommendedAction: "link_existing",
            selectedIssueId: "AIC-105",
            reasonSummary: "deterministic duplicate recall で安全な既存 issue が 1 件に絞れました。",
            missingSlots: [],
          },
        },
      },
    ]);

    expect(evidence).toEqual([
      {
        issueId: "AIC-103",
        source: "linear_get_issue_facts",
        summary: "FFS 活用の返答最適化",
      },
      {
        issueId: "AIC-105",
        source: "duplicate_exact_reuse",
        summary: "deterministic duplicate recall で安全な既存 issue が 1 件に絞れました。",
      },
    ]);
  });

  it("extracts generic pending confirmation requests", () => {
    const request = extractPendingConfirmationRequest([
      {
        toolName: "request_manager_confirmation",
        details: {
          pendingConfirmationRequest: {
            kind: "mutation",
            previewReply: "AIC-105 に requester profile 資料を紐づける案です。進めるなら「こちらでお願いします」と返信してください。",
            previewSummaryLines: ["AIC-105 に requester profile 資料を関連づけ"],
            proposals: [
              {
                commandType: "add_comment",
                issueId: "AIC-105",
                body: "requester-profiles-review.pdf を参照資料として追加",
                reasonSummary: "requester profile PDF の反映",
              },
            ],
            persistence: "replace",
          },
        },
      },
    ]);

    expect(request).toEqual({
      kind: "mutation",
      previewReply: "AIC-105 に requester profile 資料を紐づける案です。進めるなら「こちらでお願いします」と返信してください。",
      previewSummaryLines: ["AIC-105 に requester profile 資料を関連づけ"],
      proposals: [
        {
          commandType: "add_comment",
          issueId: "AIC-105",
          body: "requester-profiles-review.pdf を参照資料として追加",
          reasonSummary: "requester profile PDF の反映",
        },
      ],
      persistence: "replace",
    });
  });
});
