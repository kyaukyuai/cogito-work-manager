import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { SystemPaths } from "../lib/system-workspace.js";
import { buildLastKnownGoodJsonPath } from "./json-file-store.js";

export const JSON_STATE_ARTIFACT_CORRUPT_WARN_AT = 3;
export const JSON_STATE_ARTIFACT_BACKUP_WARN_AT = 8;

type RecoverableJsonStateKey = "policy" | "followups" | "webhookDeliveries";

export interface JsonStateArtifactFileStatus {
  path: string;
  exists: boolean;
  sizeBytes: number | null;
  lastModifiedAt?: string;
}

export interface JsonStateArtifactWarning {
  relativePath: string;
  code: "corrupt-artifact-count-warning" | "backup-artifact-count-warning" | "missing-last-known-good";
  message: string;
}

export interface JsonStateArtifactStatus {
  key: RecoverableJsonStateKey;
  relativePath: string;
  absolutePath: string;
  mainFile: JsonStateArtifactFileStatus;
  lastKnownGood: JsonStateArtifactFileStatus;
  corruptArtifacts: {
    count: number;
    newest?: JsonStateArtifactFileStatus;
  };
  backupArtifacts: {
    count: number;
    newest?: JsonStateArtifactFileStatus;
  };
  warnings: Array<Omit<JsonStateArtifactWarning, "relativePath">>;
}

export interface JsonStateArtifactSummary {
  files: JsonStateArtifactStatus[];
  warningCount: number;
  warnings: JsonStateArtifactWarning[];
  thresholds: {
    corruptWarnAt: number;
    backupWarnAt: number;
  };
}

interface JsonStateTarget {
  key: RecoverableJsonStateKey;
  relativePath: string;
  absolutePath: string;
}

interface ArtifactCandidate extends JsonStateArtifactFileStatus {
  mtimeMs: number;
}

function buildRecoverableJsonStateTargets(paths: SystemPaths): JsonStateTarget[] {
  return [
    {
      key: "policy",
      relativePath: "policy.json",
      absolutePath: paths.policyFile,
    },
    {
      key: "followups",
      relativePath: "followups.json",
      absolutePath: paths.followupsFile,
    },
    {
      key: "webhookDeliveries",
      relativePath: "webhook-deliveries.json",
      absolutePath: paths.webhookDeliveriesFile,
    },
  ];
}

async function inspectFile(path: string): Promise<JsonStateArtifactFileStatus> {
  try {
    const metadata = await stat(path);
    return {
      path,
      exists: true,
      sizeBytes: metadata.size,
      lastModifiedAt: metadata.mtime.toISOString(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        path,
        exists: false,
        sizeBytes: null,
      };
    }
    throw error;
  }
}

async function inspectArtifactGroup(path: string, prefix: string): Promise<{
  count: number;
  newest?: JsonStateArtifactFileStatus;
}> {
  let entries: string[];
  try {
    entries = await readdir(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { count: 0 };
    }
    throw error;
  }

  const candidates: ArtifactCandidate[] = [];
  for (const entry of entries.filter((candidate) => candidate.startsWith(prefix))) {
    const fullPath = join(dirname(path), entry);
    try {
      const metadata = await stat(fullPath);
      if (!metadata.isFile()) {
        continue;
      }
      candidates.push({
        path: fullPath,
        exists: true,
        sizeBytes: metadata.size,
        lastModifiedAt: metadata.mtime.toISOString(),
        mtimeMs: metadata.mtimeMs,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  const sortedCandidates = candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const newestCandidate = sortedCandidates[0];
  return {
    count: sortedCandidates.length,
    newest: newestCandidate
      ? {
          path: newestCandidate.path,
          exists: newestCandidate.exists,
          sizeBytes: newestCandidate.sizeBytes,
          lastModifiedAt: newestCandidate.lastModifiedAt,
        }
      : undefined,
  };
}

async function inspectJsonStateArtifactTarget(target: JsonStateTarget): Promise<JsonStateArtifactStatus> {
  const lastKnownGoodPath = buildLastKnownGoodJsonPath(target.absolutePath);
  const [mainFile, lastKnownGood, corruptArtifacts, backupArtifacts] = await Promise.all([
    inspectFile(target.absolutePath),
    inspectFile(lastKnownGoodPath),
    inspectArtifactGroup(target.absolutePath, `${basename(target.absolutePath)}.corrupt-`),
    inspectArtifactGroup(target.absolutePath, `${basename(target.absolutePath)}.bak-`),
  ]);

  const warnings: JsonStateArtifactStatus["warnings"] = [];
  if (corruptArtifacts.count >= JSON_STATE_ARTIFACT_CORRUPT_WARN_AT) {
    warnings.push({
      code: "corrupt-artifact-count-warning",
      message: `${corruptArtifacts.count} corrupt artifacts present; investigate repeated JSON recovery.`,
    });
  }
  if (backupArtifacts.count >= JSON_STATE_ARTIFACT_BACKUP_WARN_AT) {
    warnings.push({
      code: "backup-artifact-count-warning",
      message: `${backupArtifacts.count} backup artifacts present; review stale retained state backups.`,
    });
  }
  if (!lastKnownGood.exists && (corruptArtifacts.count > 0 || backupArtifacts.count > 0)) {
    warnings.push({
      code: "missing-last-known-good",
      message: "No last-known-good snapshot is available for recovery fallback.",
    });
  }

  return {
    key: target.key,
    relativePath: target.relativePath,
    absolutePath: target.absolutePath,
    mainFile,
    lastKnownGood,
    corruptArtifacts,
    backupArtifacts,
    warnings,
  };
}

export async function inspectJsonStateArtifacts(paths: SystemPaths): Promise<JsonStateArtifactSummary> {
  const files = await Promise.all(buildRecoverableJsonStateTargets(paths).map(inspectJsonStateArtifactTarget));
  const warnings = files.flatMap((file) => file.warnings.map((warning) => ({
    relativePath: file.relativePath,
    code: warning.code,
    message: warning.message,
  })));
  return {
    files,
    warningCount: warnings.length,
    warnings,
    thresholds: {
      corruptWarnAt: JSON_STATE_ARTIFACT_CORRUPT_WARN_AT,
      backupWarnAt: JSON_STATE_ARTIFACT_BACKUP_WARN_AT,
    },
  };
}
