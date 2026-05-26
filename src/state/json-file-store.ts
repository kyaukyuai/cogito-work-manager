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
}

async function backupInvalidJsonFile(path: string, raw: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(buildCorruptBackupPath(path), raw, "utf8");
}

function shouldRecoverInvalidJsonFile(error: unknown, recoverOnInvalid: boolean): boolean {
  if (!recoverOnInvalid) {
    return false;
  }
  return error instanceof SyntaxError || error instanceof ZodError;
}

export async function loadJsonFile<S extends z.ZodTypeAny>({
  path,
  schema,
  defaultValue,
  recoverOnInvalid = false,
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
    await backupInvalidJsonFile(path, raw).catch(() => undefined);
    await writeJsonFileAtomic(path, defaultValue);
    return defaultValue;
  }
}
