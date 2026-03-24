import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type {
  PersonalizationLedgerEntry,
} from "../state/manager-state-contract.js";
import type { SystemPaths } from "./system-workspace.js";

export interface PersonalizationObservationInput {
  kind: "operating_rule" | "preference_or_fact";
  source: "explicit" | "inferred";
  category: "workflow" | "reply-style" | "priority" | "terminology" | "people-and-projects" | "preferences" | "context";
  summary: string;
  canonicalText: string;
  confidence: number;
}

export type PersonalizationUpdateCommand =
  | {
    commandType: "update_workspace_agents";
    entries: PersonalizationLedgerEntry[];
  }
  | {
    commandType: "update_workspace_memory";
    entries: PersonalizationLedgerEntry[];
  };

export interface PersonalizationCommitResult {
  ledger: PersonalizationLedgerEntry[];
  promoted: PersonalizationLedgerEntry[];
  updatedFiles: Array<"agents" | "memory">;
}

const INFERRED_PROMOTION_EVIDENCE_COUNT = 2;
const INFERRED_PROMOTION_CONFIDENCE = 0.8;
const GENERATED_START = "<!-- COGITO AUTO-GENERATED START -->";
const GENERATED_END = "<!-- COGITO AUTO-GENERATED END -->";

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function buildObservationKey(observation: {
  targetFile: "agents" | "memory";
  summary: string;
}): string {
  return `${observation.targetFile}:${normalizeText(observation.summary).toLowerCase()}`;
}

function determineTargetFile(kind: PersonalizationObservationInput["kind"]): "agents" | "memory" {
  return kind === "operating_rule" ? "agents" : "memory";
}

function upsertObservation(
  ledger: PersonalizationLedgerEntry[],
  observation: PersonalizationObservationInput,
  nowIso: string,
): {
  nextLedger: PersonalizationLedgerEntry[];
  promotedEntry?: PersonalizationLedgerEntry;
} {
  const targetFile = determineTargetFile(observation.kind);
  const nextLedger = [...ledger];
  const observationKey = buildObservationKey({ targetFile, summary: observation.summary });
  const sameKeyEntries = nextLedger.filter((entry) =>
    entry.status !== "rejected"
    && entry.status !== "superseded"
    && buildObservationKey(entry) === observationKey);
  const exactExisting = sameKeyEntries.find((entry) => normalizeText(entry.canonicalText) === normalizeText(observation.canonicalText));

  if (exactExisting) {
    exactExisting.evidenceCount += 1;
    exactExisting.lastSeenAt = nowIso;
    exactExisting.confidence = Math.max(exactExisting.confidence, observation.confidence);
    if (
      exactExisting.status === "candidate"
      && (exactExisting.source === "explicit"
        || (exactExisting.evidenceCount >= INFERRED_PROMOTION_EVIDENCE_COUNT && exactExisting.confidence >= INFERRED_PROMOTION_CONFIDENCE))
    ) {
      exactExisting.status = "promoted";
      return { nextLedger, promotedEntry: exactExisting };
    }
    return { nextLedger, promotedEntry: exactExisting.status === "promoted" ? exactExisting : undefined };
  }

  for (const entry of sameKeyEntries) {
    entry.status = "superseded";
    entry.lastSeenAt = nowIso;
  }

  const nextEntry: PersonalizationLedgerEntry = {
    id: randomUUID(),
    kind: observation.kind,
    source: observation.source,
    category: observation.category,
    summary: observation.summary,
    canonicalText: observation.canonicalText,
    confidence: observation.confidence,
    evidenceCount: 1,
    lastSeenAt: nowIso,
    status: observation.source === "explicit"
      ? "promoted"
      : (observation.confidence >= INFERRED_PROMOTION_CONFIDENCE ? "candidate" : "candidate"),
    targetFile,
  };

  if (
    nextEntry.source === "inferred"
    && !(nextEntry.evidenceCount >= INFERRED_PROMOTION_EVIDENCE_COUNT && nextEntry.confidence >= INFERRED_PROMOTION_CONFIDENCE)
  ) {
    nextEntry.status = "candidate";
  }

  nextLedger.push(nextEntry);
  return {
    nextLedger,
    promotedEntry: nextEntry.status === "promoted" ? nextEntry : undefined,
  };
}

function renderAgents(entries: PersonalizationLedgerEntry[]): string {
  const sections: Array<{ heading: string; category: PersonalizationLedgerEntry["category"] }> = [
    { heading: "## Workflow Rules", category: "workflow" },
    { heading: "## Reply Style", category: "reply-style" },
    { heading: "## Priority Rules", category: "priority" },
  ];
  return sections
    .map(({ heading, category }) => {
      const lines = entries
        .filter((entry) => entry.category === category)
        .map((entry) => `- ${entry.canonicalText}`)
        .sort((a, b) => a.localeCompare(b, "ja"));
      return lines.length > 0 ? [heading, ...lines].join("\n") : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function renderMemory(entries: PersonalizationLedgerEntry[]): string {
  const sections: Array<{ heading: string; category: PersonalizationLedgerEntry["category"] }> = [
    { heading: "## Terminology", category: "terminology" },
    { heading: "## People and Projects", category: "people-and-projects" },
    { heading: "## Preferences", category: "preferences" },
    { heading: "## Context", category: "context" },
  ];
  return sections
    .map(({ heading, category }) => {
      const lines = entries
        .filter((entry) => entry.category === category)
        .map((entry) => `- ${entry.canonicalText}`)
        .sort((a, b) => a.localeCompare(b, "ja"));
      return lines.length > 0 ? [heading, ...lines].join("\n") : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function mergeGeneratedBlock(existing: string, generatedBody: string): string {
  const startIndex = existing.indexOf(GENERATED_START);
  const endIndex = existing.indexOf(GENERATED_END);

  const before = startIndex >= 0 ? existing.slice(0, startIndex).trimEnd() : existing.trimEnd();
  const after = startIndex >= 0 && endIndex >= 0
    ? existing.slice(endIndex + GENERATED_END.length).trimStart()
    : "";
  const sections = [
    before,
    generatedBody.trim()
      ? `${GENERATED_START}\n${generatedBody.trim()}\n${GENERATED_END}`
      : "",
    after,
  ].filter(Boolean);
  return sections.length > 0 ? `${sections.join("\n\n")}\n` : "\n";
}

async function writeGeneratedPersonalizationFile(path: string, rendered: string): Promise<void> {
  let existing = "\n";
  try {
    existing = await readFile(path, "utf8");
  } catch {
    existing = "\n";
  }
  await writeFile(path, mergeGeneratedBlock(existing, rendered), "utf8");
}

export async function commitPersonalizationUpdates(
  paths: SystemPaths,
  commands: PersonalizationUpdateCommand[],
): Promise<Array<"agents" | "memory">> {
  const updatedFiles: Array<"agents" | "memory"> = [];

  for (const command of commands) {
    if (command.commandType === "update_workspace_agents") {
      await writeGeneratedPersonalizationFile(
        paths.workspaceAgentsFile,
        renderAgents(command.entries),
      );
      updatedFiles.push("agents");
      continue;
    }

    await writeGeneratedPersonalizationFile(
      paths.memoryFile,
      renderMemory(command.entries),
    );
    updatedFiles.push("memory");
  }

  return updatedFiles;
}

export async function applyPersonalizationObservations(args: {
  paths: SystemPaths;
  ledger: PersonalizationLedgerEntry[];
  observations: PersonalizationObservationInput[];
  now: Date;
}): Promise<PersonalizationCommitResult> {
  let nextLedger = [...args.ledger];
  const promoted = new Map<string, PersonalizationLedgerEntry>();

  for (const observation of args.observations) {
    const result = upsertObservation(nextLedger, observation, args.now.toISOString());
    nextLedger = result.nextLedger;
    if (result.promotedEntry) {
      promoted.set(result.promotedEntry.id, result.promotedEntry);
    }
  }

  const promotedAgents = nextLedger.filter((entry) => entry.status === "promoted" && entry.targetFile === "agents");
  const promotedMemory = nextLedger.filter((entry) => entry.status === "promoted" && entry.targetFile === "memory");
  const commands: PersonalizationUpdateCommand[] = [];

  if (promotedAgents.length > 0) {
    commands.push({
      commandType: "update_workspace_agents",
      entries: promotedAgents,
    });
  }
  if (promotedMemory.length > 0) {
    commands.push({
      commandType: "update_workspace_memory",
      entries: promotedMemory,
    });
  }

  const updatedFiles = await commitPersonalizationUpdates(args.paths, commands);

  return {
    ledger: nextLedger,
    promoted: Array.from(promoted.values()),
    updatedFiles,
  };
}

export function stripGeneratedPersonalizationMarkers(value: string): string {
  return value
    .split("\n")
    .filter((line) => line.trim() !== GENERATED_START && line.trim() !== GENERATED_END)
    .join("\n");
}
