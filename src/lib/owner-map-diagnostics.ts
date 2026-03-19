import type { OwnerMap, OwnerMapEntry } from "../state/manager-state-contract.js";

export interface OwnerMapDiagnostics {
  totalEntries: number;
  mappedSlackEntries: number;
  unmappedSlackEntries: OwnerMapEntry[];
  duplicateSlackUserIds: Array<{ slackUserId: string; entryIds: string[] }>;
}

export function analyzeOwnerMap(ownerMap: OwnerMap): OwnerMapDiagnostics {
  const unmappedSlackEntries = ownerMap.entries.filter((entry) => !entry.slackUserId);
  const slackGroups = new Map<string, string[]>();

  ownerMap.entries.forEach((entry) => {
    if (!entry.slackUserId) return;
    const current = slackGroups.get(entry.slackUserId) ?? [];
    current.push(entry.id);
    slackGroups.set(entry.slackUserId, current);
  });

  const duplicateSlackUserIds = Array.from(slackGroups.entries())
    .filter(([, entryIds]) => entryIds.length >= 2)
    .map(([slackUserId, entryIds]) => ({ slackUserId, entryIds }));

  return {
    totalEntries: ownerMap.entries.length,
    mappedSlackEntries: ownerMap.entries.length - unmappedSlackEntries.length,
    unmappedSlackEntries,
    duplicateSlackUserIds,
  };
}
