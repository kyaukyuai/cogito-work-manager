import { describe, expect, it } from "vitest";
import {
  buildCreateIssueArgs,
  buildIssueUrlArgs,
  buildListActiveIssuesArgs,
  buildUpdateIssueArgs,
} from "../src/lib/linear.js";

describe("linear command builders", () => {
  it("creates issue args with fixed team and without workspace when api key is set", () => {
    const args = buildCreateIssueArgs(
      {
        title: "Smoke test",
        description: "# Summary\n- test",
      },
      {
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "KYA",
      },
    );

    expect(args).toContain("--team");
    expect(args).toContain("KYA");
    expect(args).not.toContain("-w");
    expect(args).toContain("--description");
  });

  it("passes due date during issue creation when provided", () => {
    const args = buildCreateIssueArgs(
      {
        title: "Prepare meeting",
        description: "# Summary\n- prepare",
        dueDate: "2026-03-20",
      },
      {
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_TEAM_KEY: "KYA",
      },
    );

    expect(args).toContain("--due-date");
    expect(args).toContain("2026-03-20");
  });

  it("falls back to workspace args when api key is absent", () => {
    const args = buildListActiveIssuesArgs(10, {
      LINEAR_WORKSPACE: "kyaukyuai",
      LINEAR_TEAM_KEY: "KYA",
      LINEAR_API_KEY: "",
    });

    expect(args).toContain("-w");
    expect(args).toContain("kyaukyuai");
    expect(args).toContain("--team");
    expect(args).toContain("KYA");
  });

  it("lists active issues with stable sort and state filters", () => {
    const args = buildListActiveIssuesArgs(10, {
      LINEAR_API_KEY: "lin_api_test",
      LINEAR_TEAM_KEY: "KYA",
    });

    expect(args.slice(0, 3)).toEqual(["issue", "list", "--all-assignees"]);
    expect(args).toContain("--sort");
    expect(args).toContain("manual");
    expect(args).toContain("unstarted");
    expect(args).toContain("started");
  });

  it("updates issue state with the expected update command", () => {
    const args = buildUpdateIssueArgs(
      {
        issueId: "KYA-123",
        state: "completed",
      },
      {
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_TEAM_KEY: "KYA",
      },
    );

    expect(args).toEqual(["issue", "update", "KYA-123", "--state", "completed"]);
  });

  it("updates due date and supports clearing it", () => {
    const setArgs = buildUpdateIssueArgs(
      {
        issueId: "KYA-123",
        dueDate: "2026-03-20",
      },
      {
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_TEAM_KEY: "KYA",
      },
    );
    const clearArgs = buildUpdateIssueArgs(
      {
        issueId: "KYA-123",
        clearDueDate: true,
      },
      {
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_TEAM_KEY: "KYA",
      },
    );

    expect(setArgs).toEqual(["issue", "update", "KYA-123", "--due-date", "2026-03-20"]);
    expect(clearArgs).toEqual(["issue", "update", "KYA-123", "--clear-due-date"]);
  });

  it("builds issue url args", () => {
    const args = buildIssueUrlArgs("KYA-123", {
      LINEAR_API_KEY: "lin_api_test",
    });

    expect(args).toEqual(["issue", "url", "KYA-123"]);
  });
});
