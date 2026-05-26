import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ZodError, z } from "zod";

const CORRUPT_STATE_ARTIFACT_RETENTION_DAYS = 14;
const CORRUPT_STATE_ARTIFACT_MAX_FILES = 5;
const NAMED_BACKUP_STATE_ARTIFACT_RETENTION_DAYS = 30;
const NAMED_BACKUP_STATE_ARTIFACT_MAX_FILES = 10;

function buildStateTimestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function buildAtomicTempPath(path: string): string {
  return join(
    dirname(path),
    `.${basename(path)}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`,
  );
}

function buildCorruptBackupPath(path: string): string {
  return `${path}.corrupt-${buildStateTimestamp()}-${randomUUID()}`;
}

interface StateArtifactCandidate {
  path: string;
  mtimeMs: number;
}

interface StateArtifactRetentionPolicy {
  maxFiles: number;
  maxAgeDays: number;
}

export async function writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = buildAtomicTempPath(path);
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function buildLastKnownGoodJsonPath(path: string): string {
  return `${path}.last-known-good`;
}

function shouldRetainStateArtifact(
  candidateIndex: number,
  candidate: StateArtifactCandidate,
  policy: StateArtifactRetentionPolicy,
  now = Date.now(),
): boolean {
  if (candidateIndex === 0) {
    return true;
  }
  if (candidateIndex >= policy.maxFiles) {
    return false;
  }
  const cutoff = now - (policy.maxAgeDays * 24 * 60 * 60 * 1000);
  return candidate.mtimeMs >= cutoff;
}

async function pruneStateArtifactGroup(
  path: string,
  prefix: string,
  policy: StateArtifactRetentionPolicy,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  const candidates: StateArtifactCandidate[] = [];
  for (const entry of entries.filter((candidate) => candidate.startsWith(prefix))) {
    const fullPath = join(dirname(path), entry);
    try {
      const metadata = await stat(fullPath);
      if (!metadata.isFile()) {
        continue;
      }
      candidates.push({
        path: fullPath,
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
  const staleCandidates = sortedCandidates.filter((candidate, index) => !shouldRetainStateArtifact(index, candidate, policy));
  await Promise.all(staleCandidates.map((candidate) => rm(candidate.path, { force: true }).catch(() => undefined)));
}

export async function pruneJsonStateArtifacts(path: string): Promise<void> {
  const filename = basename(path);
  await pruneStateArtifactGroup(path, `${filename}.corrupt-`, {
    maxFiles: CORRUPT_STATE_ARTIFACT_MAX_FILES,
    maxAgeDays: CORRUPT_STATE_ARTIFACT_RETENTION_DAYS,
  });
  await pruneStateArtifactGroup(path, `${filename}.bak-`, {
    maxFiles: NAMED_BACKUP_STATE_ARTIFACT_MAX_FILES,
    maxAgeDays: NAMED_BACKUP_STATE_ARTIFACT_RETENTION_DAYS,
  });
}

export async function readValidatedJsonFile<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
): Promise<z.output<S> | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return schema.parse(JSON.parse(raw) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    return undefined;
  }
}

export interface LoadJsonFileOptions<S extends z.ZodTypeAny> {
  path: string;
  schema: S;
  defaultValue: z.output<S>;
  recoverOnInvalid?: boolean;
  onRecoverInvalid?: (details: JsonFileRecoveryDetails) => void | Promise<void>;
  onValidValue?: (value: z.output<S>) => void | Promise<void>;
  recoverValue?: (args: {
    path: string;
    schema: S;
    defaultValue: z.output<S>;
    raw: string;
    parseError: SyntaxError | ZodError;
    parsedValue?: unknown;
  }) => Promise<RecoveredJsonValue<z.output<S>> | undefined>;
}

export interface JsonFileRecoveryDetails {
  path: string;
  backupPath?: string;
  errorType: "syntax" | "schema";
  errorMessage: string;
  parsedValue?: unknown;
  restoredValue?: unknown;
  restoredFrom?: "last-known-good" | "backup" | "default";
  restoredPath?: string;
}

export interface RecoveredJsonValue<T> {
  value: T;
  restoredFrom: "last-known-good" | "backup" | "default";
  restoredPath?: string;
}

async function backupInvalidJsonFile(path: string, raw: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const backupPath = buildCorruptBackupPath(path);
  await writeFile(backupPath, raw, "utf8");
  await pruneJsonStateArtifacts(path).catch(() => undefined);
  return backupPath;
}

function shouldRecoverInvalidJsonFile(error: unknown, recoverOnInvalid: boolean): boolean {
  if (!recoverOnInvalid) {
    return false;
  }
  return error instanceof SyntaxError || error instanceof ZodError;
}

function buildRecoveryDetails(path: string, error: unknown, backupPath?: string): JsonFileRecoveryDetails {
  return {
    path,
    backupPath,
    errorType: error instanceof SyntaxError ? "syntax" : "schema",
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}

export function emitJsonStateRecoveryWarning(details: JsonFileRecoveryDetails): void {
  console.warn(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "warn",
    message: "Recovered invalid JSON state file",
    path: details.path,
    backupPath: details.backupPath ?? null,
    errorType: details.errorType,
    error: details.errorMessage,
  }));
}

export async function loadJsonFile<S extends z.ZodTypeAny>({
  path,
  schema,
  defaultValue,
  recoverOnInvalid = false,
  onRecoverInvalid,
  onValidValue,
  recoverValue,
}: LoadJsonFileOptions<S>): Promise<z.output<S>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultValue;
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const value = schema.parse(parsed);
    await onValidValue?.(value);
    return value;
  } catch (error) {
    if (!shouldRecoverInvalidJsonFile(error, recoverOnInvalid)) {
      throw error;
    }
    const backupPath = await backupInvalidJsonFile(path, raw).catch(() => undefined);
    const parsedValue = error instanceof ZodError
      ? (() => {
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          return undefined;
        }
      })()
      : undefined;
    const recoveredValue = await recoverValue?.({
      path,
      schema,
      defaultValue,
      raw,
      parseError: error as SyntaxError | ZodError,
      parsedValue,
    });
    const nextValue = recoveredValue?.value ?? defaultValue;
    await writeJsonFileAtomic(path, nextValue);
    await onValidValue?.(nextValue);
    const recoveryDetails = buildRecoveryDetails(path, error, backupPath);
    recoveryDetails.parsedValue = parsedValue;
    recoveryDetails.restoredValue = nextValue;
    recoveryDetails.restoredFrom = recoveredValue?.restoredFrom ?? "default";
    recoveryDetails.restoredPath = recoveredValue?.restoredPath;
    await onRecoverInvalid?.(recoveryDetails);
    return nextValue;
  }
}
