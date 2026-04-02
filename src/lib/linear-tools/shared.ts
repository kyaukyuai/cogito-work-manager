import type { AppConfig } from "../config.js";
import type { LinearCommandEnv } from "../../gateways/linear/command-runner.js";
import type { LinearIssue, LinearIssueResult, LinearListResult } from "../../gateways/linear/types.js";

export function buildLinearEnv(config: AppConfig): LinearCommandEnv {
  return {
    ...process.env,
    LINEAR_API_KEY: config.linearApiKey,
    LINEAR_WORKSPACE: config.linearWorkspace,
    LINEAR_TEAM_KEY: config.linearTeamKey,
  };
}

export function formatCreateIssueResult(result: LinearIssueResult): string {
  const lines = ["Linear issue created."];

  if (result.issueId) lines.push(`ID: ${result.issueId}`);
  if (result.title) lines.push(`Title: ${result.title}`);
  if (result.url) lines.push(`URL: ${result.url}`);

  if (!result.issueId) {
    lines.push(`CLI output: ${result.output || "(empty)"}`);
  }

  return lines.join("\n");
}

export function formatListIssuesResult(result: LinearListResult): string {
  return `Active Linear issues:\n${result.output || "(no active issues found)"}`;
}

export function formatUpdateIssueStateResult(result: LinearIssueResult, state: string): string {
  const lines = [state ? `Linear issue updated (${state}).` : "Linear issue updated."];

  if (result.issueId) lines.push(`ID: ${result.issueId}`);
  if (result.url) lines.push(`URL: ${result.url}`);
  if (result.output) lines.push(`CLI output: ${result.output}`);

  return lines.join("\n");
}

export function formatManagedIssue(issue: LinearIssue, prefix: string): string {
  const lines = [`${prefix}`];
  lines.push(`ID: ${issue.identifier}`);
  lines.push(`Title: ${issue.title}`);
  if (issue.parent?.identifier) lines.push(`Parent: ${issue.parent.identifier}`);
  if (issue.assignee?.displayName || issue.assignee?.name) {
    lines.push(`Assignee: ${issue.assignee.displayName ?? issue.assignee.name}`);
  }
  if (issue.dueDate) lines.push(`Due: ${issue.dueDate}`);
  if (issue.url) lines.push(`URL: ${issue.url}`);
  return lines.join("\n");
}
