import { writeFile } from "node:fs/promises";
import { applyPersonalizationObservations, type PersonalizationObservationInput } from "../../personalization-commit.js";
import { buildSystemPaths } from "../../system-workspace.js";
import type { OwnerMapEntry } from "../../../state/manager-state-contract.js";
import type {
  ManagerCommandProposal,
  ManagerCommandHandlerResult,
  ManagerCommittedCommand,
  ManagerProposalRejection,
  ReplaceWorkspaceTextFileProposal,
  UpdateOwnerMapProposal,
  UpdateWorkspaceMemoryProposal,
} from "../contracts.js";
import type { CommitManagerCommandArgs } from "../contracts.js";

function isProjectScopedWorkspaceMemoryCategory(category: UpdateWorkspaceMemoryProposal["entries"][number]["category"]): boolean {
  return category === "project-overview"
    || category === "members-and-roles"
    || category === "roadmap-and-milestones";
}

function looksLikeIssueLevelRoadmapText(text: string): boolean {
  return /AIC-\d+/i.test(text)
    || /\b(?:Backlog|In Progress|In Review|Done|Blocked|Canceled|Cancelled)\b/i.test(text)
    || /(?:現在|今日中|今週|今月|進捗)\b/.test(text)
    || /\b\d+%\b/.test(text);
}

function normalizeWorkspaceTextContent(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function resolveWorkspaceTextFilePath(
  workspaceDir: string,
  target: ReplaceWorkspaceTextFileProposal["target"],
): string {
  const systemPaths = buildSystemPaths(workspaceDir);
  return target === "agenda-template"
    ? systemPaths.agendaTemplateFile
    : systemPaths.heartbeatPromptFile;
}

function normalizeOwnerMapStringList(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
}

export function buildOwnerMapPreviewSummaryLine(proposal: UpdateOwnerMapProposal): string {
  if (proposal.operation === "set-default-owner") {
    return `defaultOwner を ${proposal.defaultOwner} に変更`;
  }
  if (proposal.operation === "delete-entry") {
    return `entry ${proposal.entryId} を削除`;
  }
  return `entry ${proposal.entryId} を追加/更新`;
}

export function buildOwnerMapPreviewReply(
  proposals: UpdateOwnerMapProposal[],
): string {
  const lines = proposals.map(buildOwnerMapPreviewSummaryLine);
  return [
    "owner-map.json の変更案です。",
    ...lines.map((line) => `- ${line}`),
    "この内容でよければ「はい」か「適用して」、取り消すなら「キャンセル」と返信してください。",
  ].join("\n");
}

export function validateUpdateOwnerMapProposal(
  proposal: UpdateOwnerMapProposal,
): string | undefined {
  if (proposal.operation === "set-default-owner") {
    if (!proposal.defaultOwner) {
      return "set-default-owner では defaultOwner が必要です。";
    }
    if (
      proposal.entryId
      || proposal.linearAssignee
      || proposal.slackUserId
      || proposal.domains
      || proposal.keywords
      || proposal.primary !== undefined
    ) {
      return "set-default-owner では defaultOwner 以外の項目は使えません。";
    }
    return undefined;
  }

  if (!proposal.entryId) {
    return "entryId を明示してください。";
  }

  if (proposal.operation === "delete-entry") {
    if (
      proposal.defaultOwner
      || proposal.linearAssignee
      || proposal.slackUserId
      || proposal.domains
      || proposal.keywords
      || proposal.primary !== undefined
    ) {
      return "delete-entry では entryId 以外の項目は使えません。";
    }
    return undefined;
  }

  if (!proposal.linearAssignee) {
    return "upsert-entry では linearAssignee が必要です。";
  }
  if (proposal.defaultOwner) {
    return "upsert-entry では defaultOwner は使えません。";
  }
  return undefined;
}

function applyOwnerMapProposal(
  ownerMap: {
    defaultOwner: string;
    entries: OwnerMapEntry[];
  },
  proposal: UpdateOwnerMapProposal,
): {
  nextOwnerMap: {
    defaultOwner: string;
    entries: OwnerMapEntry[];
  };
  summary: string;
} | ManagerProposalRejection {
  if (proposal.operation === "set-default-owner") {
    return {
      nextOwnerMap: {
        ...ownerMap,
        defaultOwner: proposal.defaultOwner!,
      },
      summary: `owner-map.json を更新しました。defaultOwner を ${proposal.defaultOwner} に変更しました。`,
    };
  }

  if (proposal.operation === "delete-entry") {
    const exists = ownerMap.entries.some((entry) => entry.id === proposal.entryId);
    if (!exists) {
      return {
        proposal,
        reason: `${proposal.entryId} は owner-map に存在しません。`,
      };
    }
    return {
      nextOwnerMap: {
        ...ownerMap,
        entries: ownerMap.entries.filter((entry) => entry.id !== proposal.entryId),
      },
      summary: `owner-map.json を更新しました。entry ${proposal.entryId} を削除しました。`,
    };
  }

  const nextEntry: OwnerMapEntry = {
    id: proposal.entryId!,
    linearAssignee: proposal.linearAssignee!,
    slackUserId: proposal.slackUserId,
    domains: normalizeOwnerMapStringList(proposal.domains),
    keywords: normalizeOwnerMapStringList(proposal.keywords),
    primary: proposal.primary ?? false,
  };
  return {
    nextOwnerMap: {
      ...ownerMap,
      entries: [
        ...ownerMap.entries.filter((entry) => entry.id !== proposal.entryId),
        nextEntry,
      ].sort((left, right) => left.id.localeCompare(right.id)),
    },
    summary: `owner-map.json を更新しました。entry ${proposal.entryId} を追加/更新しました。`,
  };
}

export async function commitUpdateWorkspaceMemoryProposal(
  args: CommitManagerCommandArgs,
  proposal: UpdateWorkspaceMemoryProposal,
): Promise<ManagerCommandHandlerResult> {
  const invalidRoadmapEntry = proposal.entries.find((entry) =>
    entry.category === "roadmap-and-milestones"
    && looksLikeIssueLevelRoadmapText(`${entry.summary} ${entry.canonicalText}`));

  if (invalidRoadmapEntry) {
    return {
      proposal,
      reason: "roadmap-and-milestones must contain project-level milestones only, not issue-level due dates or current status",
    };
  }

  const observations: PersonalizationObservationInput[] = proposal.entries.map((entry) => ({
    kind: "preference_or_fact",
    source: "explicit",
    category: entry.category,
    projectName: entry.projectName,
    summary: entry.summary,
    canonicalText: entry.canonicalText,
    confidence: 1,
  }));
  const ledger = await args.repositories.personalization.load();
  const result = await applyPersonalizationObservations({
    paths: buildSystemPaths(args.config.workspaceDir),
    ledger,
    observations,
    now: args.now,
  });
  await args.repositories.personalization.save(result.ledger);

  const source = proposal.sourceLabel?.trim();
  return {
    commandType: proposal.commandType,
    issueIds: [],
    summary: source
      ? `Workspace MEMORY を更新しました。${source} から ${proposal.entries.length} 件を反映しました。`
      : `Workspace MEMORY を更新しました。${proposal.entries.length} 件を反映しました。`,
  };
}

export async function commitReplaceWorkspaceTextFileProposal(
  args: CommitManagerCommandArgs,
  proposal: ReplaceWorkspaceTextFileProposal,
): Promise<ManagerCommittedCommand> {
  const path = resolveWorkspaceTextFilePath(args.config.workspaceDir, proposal.target);
  await writeFile(path, normalizeWorkspaceTextContent(proposal.content), "utf8");
  return {
    commandType: proposal.commandType,
    issueIds: [],
    summary: proposal.target === "agenda-template"
      ? "AGENDA_TEMPLATE.md を更新しました。"
      : "HEARTBEAT.md を更新しました。",
  };
}

export async function commitUpdateOwnerMapProposal(
  args: CommitManagerCommandArgs,
  proposal: UpdateOwnerMapProposal,
): Promise<ManagerCommandHandlerResult> {
  const validationError = validateUpdateOwnerMapProposal(proposal);
  if (validationError) {
    return {
      proposal,
      reason: validationError,
    };
  }
  const ownerMap = await args.repositories.ownerMap.load();
  const result = applyOwnerMapProposal(ownerMap, proposal);
  if ("reason" in result) {
    return result;
  }
  await args.repositories.ownerMap.save(result.nextOwnerMap);
  return {
    commandType: proposal.commandType,
    issueIds: [],
    summary: result.summary,
  };
}

export function getWorkspaceConfigTarget(
  proposal: ManagerCommandProposal,
): "agenda-template" | "heartbeat-prompt" | "owner-map" | undefined {
  if (proposal.commandType === "replace_workspace_text_file") {
    return proposal.target;
  }
  if (proposal.commandType === "update_owner_map") {
    return "owner-map";
  }
  return undefined;
}
