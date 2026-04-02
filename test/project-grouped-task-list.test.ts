import { describe, expect, it } from "vitest";
import {
  buildProjectGroupedTaskReply,
  isExplicitProjectGroupedTaskListQuery,
  isProjectGroupedTaskListQuery,
  normalizeProjectGroupedTaskIssueFacts,
  type ProjectGroupedTaskIssueFact,
} from "../src/orchestrators/query/project-grouped-task-list.js";

function makeIssueFact(
  identifier: string,
  projectName?: string,
  title = `${identifier} title`,
): ProjectGroupedTaskIssueFact {
  return {
    identifier,
    title,
    project: projectName
      ? { id: `project-${projectName}`, name: projectName, slugId: projectName }
      : undefined,
    stateName: "Started",
  };
}

describe("project-grouped task list renderer", () => {
  it("detects explicit project-grouped task queries and follow-up continuations", () => {
    expect(isExplicitProjectGroupedTaskListQuery("<@U0ALQ3MN4RL> project ごとのタスク一覧をだして")).toBe(true);
    expect(isExplicitProjectGroupedTaskListQuery("プロジェクト別のissue一覧を見せて")).toBe(true);
    expect(isExplicitProjectGroupedTaskListQuery("タスク一覧を見せて")).toBe(false);

    expect(isProjectGroupedTaskListQuery({
      messageText: "他には？",
      lastQueryContext: {
        kind: "list-active",
        scope: "team",
        userMessage: "project ごとのタスク一覧をだして",
        replySummary: "[project-grouped-exact] exact project-grouped task list",
        issueIds: ["AIC-1"],
        shownIssueIds: ["AIC-1"],
        remainingIssueIds: ["AIC-2"],
        totalItemCount: 2,
        recordedAt: "2026-04-02T01:00:00.000Z",
      },
    })).toBe(true);
  });

  it("normalizes exact issue facts with project metadata", () => {
    expect(normalizeProjectGroupedTaskIssueFacts([
      {
        identifier: "AIC-1",
        title: "Issue 1",
        project: { id: "project-1", name: "ai-clone", slugId: "ai-clone" },
        stateName: "Started",
      },
    ])).toEqual([
      {
        identifier: "AIC-1",
        title: "Issue 1",
        project: { id: "project-1", name: "ai-clone", slugId: "ai-clone" },
        stateName: "Started",
        dueRelativeLabel: undefined,
        priorityLabel: undefined,
      },
    ]);
    expect(normalizeProjectGroupedTaskIssueFacts("invalid")).toBeUndefined();
  });

  it("renders full exact project-grouped replies when total issues stay within the full limit", () => {
    const result = buildProjectGroupedTaskReply({
      messageText: "project ごとのタスク一覧をだして",
      issues: [
        makeIssueFact("AIC-3", "operation", "Operation task"),
        makeIssueFact("AIC-1", "ai-clone", "Clone task"),
        makeIssueFact("AIC-4", undefined, "Unassigned task"),
        makeIssueFact("AIC-2", "ai-clone-collector", "Collector task"),
      ],
    });

    expect(result.reply).toContain("ai-clone（1件）");
    expect(result.reply).toContain("ai-clone-collector（1件）");
    expect(result.reply).toContain("operation（1件）");
    expect(result.reply).toContain("プロジェクト未設定（1件）");
    expect(result.reply).toContain("- AIC-1 Clone task（Started）");
    expect(result.reply).toContain("- AIC-4 Unassigned task（Started）");
    expect(result.reply).not.toContain("他");
    expect(result.issueIds).toEqual(["AIC-3", "AIC-1", "AIC-4", "AIC-2"]);
    expect(result.shownIssueIds).toEqual(["AIC-1", "AIC-2", "AIC-3", "AIC-4"]);
    expect(result.remainingIssueIds).toEqual([]);
    expect(result.totalItemCount).toBe(4);
  });

  it("renders compact exact replies with per-project limits and continuation state", () => {
    const issues: ProjectGroupedTaskIssueFact[] = [
      makeIssueFact("AIC-101", "ai-clone"),
      makeIssueFact("AIC-102", "ai-clone"),
      makeIssueFact("AIC-103", "ai-clone"),
      makeIssueFact("AIC-104", "ai-clone"),
      makeIssueFact("AIC-201", "ai-clone-collector"),
      makeIssueFact("AIC-202", "ai-clone-collector"),
      makeIssueFact("AIC-301", "operation"),
      makeIssueFact("AIC-302", "operation"),
      makeIssueFact("AIC-303", "operation"),
      makeIssueFact("AIC-304", "operation"),
      makeIssueFact("AIC-305", "operation"),
      makeIssueFact("AIC-401"),
      makeIssueFact("AIC-402"),
      makeIssueFact("AIC-403"),
    ];

    const first = buildProjectGroupedTaskReply({
      messageText: "project ごとのタスク一覧をだして",
      issues,
    });

    expect(first.reply).toContain("ai-clone（4件）");
    expect(first.reply).toContain("- AIC-101 AIC-101 title（Started）");
    expect(first.reply).toContain("- 他1件");
    expect(first.reply).toContain("operation（5件）");
    expect(first.reply).toContain("プロジェクト未設定（3件）");
    expect(first.shownIssueIds).toEqual([
      "AIC-101", "AIC-102", "AIC-103",
      "AIC-201", "AIC-202",
      "AIC-301", "AIC-302", "AIC-303",
      "AIC-401", "AIC-402", "AIC-403",
    ]);
    expect(first.remainingIssueIds).toEqual(["AIC-104", "AIC-304", "AIC-305"]);

    const second = buildProjectGroupedTaskReply({
      messageText: "他には？",
      issues,
      lastQueryContext: {
        kind: "list-active",
        scope: "team",
        userMessage: "project ごとのタスク一覧をだして",
        replySummary: first.replySummary,
        issueIds: first.issueIds,
        shownIssueIds: first.shownIssueIds,
        remainingIssueIds: first.remainingIssueIds,
        totalItemCount: first.totalItemCount,
        recordedAt: "2026-04-02T02:00:00.000Z",
      },
    });

    expect(second.reply).toContain("- AIC-104 AIC-104 title（Started）");
    expect(second.reply).toContain("- AIC-304 AIC-304 title（Started）");
    expect(second.reply).toContain("- AIC-305 AIC-305 title（Started）");
    expect(second.reply).not.toContain("AIC-101");
    expect(second.shownIssueIds).toEqual([
      "AIC-101", "AIC-102", "AIC-103",
      "AIC-201", "AIC-202",
      "AIC-301", "AIC-302", "AIC-303",
      "AIC-401", "AIC-402", "AIC-403",
      "AIC-104", "AIC-304", "AIC-305",
    ]);
    expect(second.remainingIssueIds).toEqual([]);
    expect(second.totalItemCount).toBe(14);
  });
});
