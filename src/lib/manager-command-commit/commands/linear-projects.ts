import {
  createManagedLinearProject,
  updateManagedLinearProject,
  type LinearProject,
} from "../../linear.js";
import type {
  CommitManagerCommandArgs,
  CreateProjectProposal,
  ManagerCommandHandlerResult,
  UpdateProjectProposal,
} from "../contracts.js";

function formatProjectLabel(project: LinearProject): string {
  return `Linear Project「${project.name}」`;
}

function formatProjectActionSentence(project: LinearProject, action: "created" | "updated"): string {
  return action === "created"
    ? `${formatProjectLabel(project)}を作成しました。`
    : `${formatProjectLabel(project)}を更新しました。`;
}

function formatProjectSummary(project: LinearProject, action: "created" | "updated"): string {
  const lines = [
    formatProjectActionSentence(project, action),
  ];
  if (project.url) {
    lines.push(project.url);
  }
  return lines.join("\n");
}

export async function commitCreateProjectProposal(
  args: CommitManagerCommandArgs,
  proposal: CreateProjectProposal,
): Promise<ManagerCommandHandlerResult> {
  const project = await createManagedLinearProject(
    {
      name: proposal.name,
      description: proposal.description,
      teamKeys: proposal.teamKeys,
      lead: proposal.lead,
      status: proposal.status,
      startDate: proposal.startDate,
      targetDate: proposal.targetDate,
    },
    args.env,
  );

  return {
    commandType: proposal.commandType,
    issueIds: [],
    summary: formatProjectSummary(project, "created"),
    publicReply: formatProjectActionSentence(project, "created"),
  };
}

export async function commitUpdateProjectProposal(
  args: CommitManagerCommandArgs,
  proposal: UpdateProjectProposal,
): Promise<ManagerCommandHandlerResult> {
  const project = await updateManagedLinearProject(
    {
      projectId: proposal.projectId,
      name: proposal.name,
      description: proposal.description,
      teamKeys: proposal.teamKeys,
      lead: proposal.lead,
      status: proposal.status,
      startDate: proposal.startDate,
      targetDate: proposal.targetDate,
    },
    args.env,
  );

  return {
    commandType: proposal.commandType,
    issueIds: [],
    summary: formatProjectSummary(project, "updated"),
    publicReply: formatProjectActionSentence(project, "updated"),
  };
}
