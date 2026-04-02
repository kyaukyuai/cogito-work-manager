import { Type } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AppConfig } from "../config.js";
import type { ManagerRepositories } from "../../state/repositories/file-backed-manager-repositories.js";
import { buildSystemPaths, readAgendaTemplate, readHeartbeatInstructions } from "../system-workspace.js";
import { analyzeOwnerMap } from "../owner-map-diagnostics.js";
import type { OwnerMap } from "../../state/manager-state-contract.js";

function formatJsonDetails(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function formatOwnerMapText(ownerMap: OwnerMap): string {
  const diagnostics = analyzeOwnerMap(ownerMap);
  return [
    "Owner map summary:",
    `- defaultOwner: ${ownerMap.defaultOwner}`,
    `- entries: ${ownerMap.entries.map((entry) => entry.id).join(", ") || "(none)"}`,
    `- duplicateSlackMappings: ${diagnostics.duplicateSlackUserIds.length > 0
      ? diagnostics.duplicateSlackUserIds
        .map((entry) => `${entry.slackUserId} -> ${entry.entryIds.join(", ")}`)
        .join(" | ")
      : "(none)"}`,
    `- unmappedEntries: ${diagnostics.unmappedSlackEntries.length > 0
      ? diagnostics.unmappedSlackEntries.map((entry) => entry.id).join(", ")
      : "(none)"}`,
    "",
    "Owner map JSON:",
    formatJsonDetails(ownerMap),
  ].join("\n");
}

export function createWorkspaceReadTools(
  config: AppConfig,
  repositories: Pick<ManagerRepositories, "ownerMap">,
): ToolDefinition[] {
  const systemPaths = buildSystemPaths(config.workspaceDir);

  return [
    {
      name: "workspace_get_agenda_template",
      label: "Workspace Get Agenda Template",
      description: "Read the current AGENDA_TEMPLATE.md contents. Read-only.",
      promptSnippet: "Use this before proposing any AGENDA_TEMPLATE.md update or replacement so you can preserve the intended structure.",
      parameters: Type.Object({}),
      async execute() {
        const content = await readAgendaTemplate(systemPaths);
        return {
          content: [{ type: "text", text: content ?? "(empty agenda template)" }],
          details: { content: content ?? "" },
        };
      },
    },
    {
      name: "workspace_get_heartbeat_prompt",
      label: "Workspace Get HEARTBEAT Prompt",
      description: "Read the current HEARTBEAT.md contents. Read-only.",
      promptSnippet: "Use this before proposing any HEARTBEAT.md update or replacement so you inspect the current prompt first.",
      parameters: Type.Object({}),
      async execute() {
        const content = await readHeartbeatInstructions(systemPaths);
        return {
          content: [{ type: "text", text: content ?? "(empty heartbeat prompt)" }],
          details: { content: content ?? "" },
        };
      },
    },
    {
      name: "workspace_get_owner_map",
      label: "Workspace Get Owner Map",
      description: "Read owner-map.json with both raw JSON and duplicate or unmapped-entry diagnostics. Read-only.",
      promptSnippet: "Use this before proposing owner-map changes so you inspect the current default owner and entries first.",
      parameters: Type.Object({}),
      async execute() {
        const ownerMap = await repositories.ownerMap.load();
        const diagnostics = analyzeOwnerMap(ownerMap);
        return {
          content: [{ type: "text", text: formatOwnerMapText(ownerMap) }],
          details: {
            ownerMap,
            summary: {
              defaultOwner: ownerMap.defaultOwner,
              entryIds: ownerMap.entries.map((entry) => entry.id),
              duplicateSlackMappings: diagnostics.duplicateSlackUserIds,
              unmappedEntryIds: diagnostics.unmappedSlackEntries.map((entry) => entry.id),
            },
          },
        };
      },
    },
  ];
}
