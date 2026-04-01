import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  appendThreadLog,
  buildThreadPaths,
  ensureThreadWorkspace,
  type ThreadPaths,
} from "./thread-workspace.js";

export const systemThreadContextSourceKindSchema = z.enum([
  "review",
  "heartbeat",
  "scheduler",
  "webhook",
]);

export const systemThreadIssueRefSchema = z.object({
  issueId: z.string().trim().min(1),
  titleHint: z.string().trim().min(1).optional(),
  role: z.enum(["primary", "related"]).optional(),
});

export const systemThreadContextReportSchema = z.object({
  sourceKind: systemThreadContextSourceKindSchema,
  issueRefs: z.array(systemThreadIssueRefSchema).default([]),
  summary: z.string().trim().min(1).optional(),
});

export const systemThreadContextSchema = systemThreadContextReportSchema.extend({
  rootPostedTs: z.string().trim().min(1),
  recordedAt: z.string().trim().min(1),
});

export type SystemThreadIssueRef = z.infer<typeof systemThreadIssueRefSchema>;
export type SystemThreadContextReport = z.infer<typeof systemThreadContextReportSchema>;
export type SystemThreadContext = z.infer<typeof systemThreadContextSchema>;

function buildSystemThreadContextPath(paths: ThreadPaths): string {
  return join(paths.scratchDir, "system-thread-context.json");
}

async function readJsonFile<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    const result = schema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function removeFile(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export async function loadSystemThreadContext(
  paths: ThreadPaths,
): Promise<SystemThreadContext | undefined> {
  return readJsonFile(buildSystemThreadContextPath(paths), systemThreadContextSchema);
}

export async function saveSystemThreadContext(
  paths: ThreadPaths,
  context: SystemThreadContext,
): Promise<void> {
  await writeJsonFile(buildSystemThreadContextPath(paths), context);
}

export async function clearSystemThreadContext(paths: ThreadPaths): Promise<void> {
  await removeFile(buildSystemThreadContextPath(paths));
}

export async function persistSystemRootSlackThread(args: {
  workspaceDir: string;
  channelId: string;
  rootPostedTs: string;
  postedText: string;
  report?: SystemThreadContextReport;
  recordedAt?: string;
}): Promise<void> {
  const actualThreadPaths = buildThreadPaths(args.workspaceDir, args.channelId, args.rootPostedTs);
  await ensureThreadWorkspace(actualThreadPaths);
  await appendThreadLog(actualThreadPaths, {
    type: "assistant",
    ts: args.rootPostedTs,
    threadTs: args.rootPostedTs,
    text: args.postedText,
  });

  if (!args.report || args.report.issueRefs.length === 0) {
    return;
  }

  await saveSystemThreadContext(actualThreadPaths, {
    ...args.report,
    rootPostedTs: args.rootPostedTs,
    recordedAt: args.recordedAt ?? new Date().toISOString(),
  });
}
