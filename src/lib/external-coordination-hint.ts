import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppConfig } from "./config.js";
import {
  resolveLinearDuplicateCandidates,
  type DuplicateRecallPlannerExecutor,
} from "./linear-duplicate-resolution.js";
import { runDuplicateRecallTurn } from "./pi-session.js";
import { getSlackThreadContext } from "./slack-context.js";
import type { ThreadPaths } from "./thread-workspace.js";

export interface ExternalCoordinationHint {
  issueId: string;
  issueTitle?: string;
  targetSlackUserId: string;
  sourceMessageTs: string;
  sourceUserId: string;
  requestText: string;
  attachmentNames: string[];
  resolutionSummary: string;
  recordedAt: string;
}

export interface ExternalCoordinationHintDiagnostic {
  level: "info" | "warn";
  message: string;
}

export interface ResolveExternalCoordinationHintArgs {
  config: AppConfig;
  paths: ThreadPaths;
  channelId: string;
  rootThreadTs: string;
  sourceMessageTs: string;
  sourceUserId: string;
  targetSlackUserIds: string[];
  requestText: string;
  attachments?: Array<{
    name: string;
    previewText?: string;
  }>;
}

export interface ResolveExternalCoordinationHintResult {
  hint?: ExternalCoordinationHint;
  diagnostics: ExternalCoordinationHintDiagnostic[];
}

function buildExternalCoordinationHintPath(paths: ThreadPaths): string {
  return join(paths.scratchDir, "external-coordination-hint.json");
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeExternalCoordinationHint(value: unknown): ExternalCoordinationHint | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const issueId = normalizeString(record.issueId);
  const targetSlackUserId = normalizeString(record.targetSlackUserId);
  const sourceMessageTs = normalizeString(record.sourceMessageTs);
  const sourceUserId = normalizeString(record.sourceUserId);
  const requestText = normalizeString(record.requestText);
  const resolutionSummary = normalizeString(record.resolutionSummary);
  const recordedAt = normalizeString(record.recordedAt);
  if (!issueId || !targetSlackUserId || !sourceMessageTs || !sourceUserId || !requestText || !resolutionSummary || !recordedAt) {
    return undefined;
  }

  return {
    issueId,
    issueTitle: normalizeString(record.issueTitle),
    targetSlackUserId,
    sourceMessageTs,
    sourceUserId,
    requestText,
    attachmentNames: normalizeStringArray(record.attachmentNames),
    resolutionSummary,
    recordedAt,
  };
}

function stripSlackUserMentions(text: string): string {
  return text.replace(/<@[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function buildLinearEnv(config: AppConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LINEAR_API_KEY: config.linearApiKey,
    LINEAR_WORKSPACE: config.linearWorkspace,
    LINEAR_TEAM_KEY: config.linearTeamKey,
  };
}

function buildExternalCoordinationResolverText(args: {
  requestText: string;
  attachments?: Array<{ name: string; previewText?: string }>;
  recentThreadTexts: string[];
}): string {
  const sanitizedRequest = stripSlackUserMentions(args.requestText);
  const attachmentNames = (args.attachments ?? [])
    .map((attachment) => attachment.name.trim())
    .filter(Boolean);
  const attachmentPreviews = (args.attachments ?? [])
    .map((attachment) => attachment.previewText?.trim())
    .filter((preview): preview is string => Boolean(preview));
  const recentThreadText = args.recentThreadTexts
    .map((text) => stripSlackUserMentions(text))
    .map((text) => text.trim())
    .filter(Boolean)
    .slice(-6)
    .join("\n");

  return [
    sanitizedRequest ? `Coordination request:\n${sanitizedRequest}` : undefined,
    attachmentNames.length > 0 ? `Attachment names:\n${attachmentNames.join("\n")}` : undefined,
    attachmentPreviews.length > 0 ? `Attachment previews:\n${attachmentPreviews.join("\n\n")}` : undefined,
    recentThreadText ? `Recent thread context:\n${recentThreadText}` : undefined,
  ].filter(Boolean).join("\n\n");
}

export async function loadExternalCoordinationHint(
  paths: ThreadPaths,
): Promise<ExternalCoordinationHint | undefined> {
  try {
    const raw = await readFile(buildExternalCoordinationHintPath(paths), "utf8");
    return normalizeExternalCoordinationHint(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function saveExternalCoordinationHint(
  paths: ThreadPaths,
  hint: ExternalCoordinationHint,
): Promise<void> {
  await mkdir(dirname(buildExternalCoordinationHintPath(paths)), { recursive: true });
  await writeFile(
    buildExternalCoordinationHintPath(paths),
    `${JSON.stringify(hint, null, 2)}\n`,
    "utf8",
  );
}

export async function clearExternalCoordinationHint(paths: ThreadPaths): Promise<void> {
  try {
    await rm(buildExternalCoordinationHintPath(paths), { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export async function resolveExternalCoordinationHint(
  args: ResolveExternalCoordinationHintArgs,
  deps?: {
    getSlackThreadContext?: typeof getSlackThreadContext;
    runDuplicateRecallTurn?: DuplicateRecallPlannerExecutor;
  },
): Promise<ResolveExternalCoordinationHintResult> {
  const diagnostics: ExternalCoordinationHintDiagnostic[] = [];
  const targetSlackUserIds = Array.from(new Set(args.targetSlackUserIds.map((value) => value.trim()).filter(Boolean)));
  if (targetSlackUserIds.length !== 1) {
    diagnostics.push({
      level: "info",
      message: "Skipped external coordination hint because the target Slack user was not unique",
    });
    return { diagnostics };
  }

  const recentThread = await (deps?.getSlackThreadContext ?? getSlackThreadContext)(
    args.config.workspaceDir,
    args.channelId,
    args.rootThreadTs,
    8,
  ).catch(() => undefined);
  const resolverText = buildExternalCoordinationResolverText({
    requestText: args.requestText,
    attachments: args.attachments,
    recentThreadTexts: (recentThread?.entries ?? []).map((entry) => entry.text ?? ""),
  });
  if (!resolverText.trim()) {
    diagnostics.push({
      level: "info",
      message: "Skipped external coordination hint because the resolver input was empty",
    });
    return { diagnostics };
  }

  const resolved = await resolveLinearDuplicateCandidates(
    {
      text: resolverText,
      taskKey: `${args.channelId}-${args.rootThreadTs}-external-coordination`,
    },
    buildLinearEnv(args.config),
    undefined,
    {
      runDuplicateRecallTurn: deps?.runDuplicateRecallTurn
        ?? ((input) => runDuplicateRecallTurn(args.config, args.paths, input)),
    },
  );

  if (
    resolved.assessment.assessmentStatus !== "exact"
    || resolved.assessment.recommendedAction !== "link_existing"
    || !resolved.assessment.selectedIssueId
  ) {
    diagnostics.push({
      level: "info",
      message: `External coordination hint not saved (${resolved.assessment.assessmentStatus}/${resolved.assessment.recommendedAction})`,
    });
    return { diagnostics };
  }

  const selectedCandidate = resolved.finalCandidates.find(
    (candidate) => candidate.identifier === resolved.assessment.selectedIssueId,
  ) ?? resolved.initialCandidates.find(
    (candidate) => candidate.identifier === resolved.assessment.selectedIssueId,
  );

  return {
    hint: {
      issueId: resolved.assessment.selectedIssueId,
      issueTitle: selectedCandidate?.title,
      targetSlackUserId: targetSlackUserIds[0]!,
      sourceMessageTs: args.sourceMessageTs,
      sourceUserId: args.sourceUserId,
      requestText: stripSlackUserMentions(args.requestText) || args.requestText.trim(),
      attachmentNames: (args.attachments ?? []).map((attachment) => attachment.name).filter(Boolean),
      resolutionSummary: resolved.assessment.reasonSummary,
      recordedAt: new Date().toISOString(),
    },
    diagnostics,
  };
}
