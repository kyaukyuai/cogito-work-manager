import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ZodError, z } from "zod";

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

export interface LoadJsonFileOptions<S extends z.ZodTypeAny> {
  path: string;
  schema: S;
  defaultValue: z.output<S>;
  recoverOnInvalid?: boolean;
  onRecoverInvalid?: (details: JsonFileRecoveryDetails) => void;
}

export interface JsonFileRecoveryDetails {
  path: string;
  backupPath?: string;
  errorType: "syntax" | "schema";
  errorMessage: string;
}

async function backupInvalidJsonFile(path: string, raw: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const backupPath = buildCorruptBackupPath(path);
  await writeFile(backupPath, raw, "utf8");
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
    return schema.parse(parsed);
  } catch (error) {
    if (!shouldRecoverInvalidJsonFile(error, recoverOnInvalid)) {
      throw error;
    }
    const backupPath = await backupInvalidJsonFile(path, raw).catch(() => undefined);
    await writeJsonFileAtomic(path, defaultValue);
    onRecoverInvalid?.(buildRecoveryDetails(path, error, backupPath));
    return defaultValue;
  }
}
