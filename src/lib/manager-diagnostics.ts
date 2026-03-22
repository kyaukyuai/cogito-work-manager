import type { AppConfig } from "./config.js";
import {
  getLinearIssue,
  type LinearCommandEnv,
  type LinearIssue,
} from "./linear.js";
import { analyzeOwnerMap, type OwnerMapDiagnostics } from "./owner-map-diagnostics.js";
import { loadThreadQueryContinuation, type ThreadQueryContinuation } from "./query-continuation.js";
import { getRecentChannelContext, getSlackThreadContext } from "./slack-context.js";
import type { FollowupLedgerEntry } from "../state/manager-state-contract.js";
import type { ManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import { buildWorkgraphThreadKey } from "../state/workgraph/events.js";
import {
  getIssueContext,
  getLatestIssueSource,
  getThreadPlanningContext,
  listAwaitingFollowups,
  type WorkgraphIssueContext,
  type WorkgraphIssueSource,
  type WorkgraphThreadPlanningContext,
} from "../state/workgraph/queries.js";
import { buildThreadPaths } from "./thread-workspace.js";

export interface ManagerThreadDiagnostics {
  channelId: string;
  rootThreadTs: string;
  threadKey: string;
  planningContext?: WorkgraphThreadPlanningContext;
  awaitingFollowups: WorkgraphIssueContext[];
  lastQueryContext?: ThreadQueryContinuation;
  slackThreadContext: Awaited<ReturnType<typeof getSlackThreadContext>>;
  recentChannelContext: Awaited<ReturnType<typeof getRecentChannelContext>>;
  ownerMapDiagnostics: OwnerMapDiagnostics;
}

export interface ManagerIssueDiagnostics {
  issueId: string;
  issueContext?: WorkgraphIssueContext;
  latestSource?: WorkgraphIssueSource;
  followup?: FollowupLedgerEntry;
  slackThreadContext?: Awaited<ReturnType<typeof getSlackThreadContext>>;
  linearIssue?: LinearIssue | null;
}

async function loadLinearIssueBestEffort(
  issueId: string,
  env: LinearCommandEnv,
): Promise<LinearIssue | null> {
  try {
    return await getLinearIssue(issueId, env, undefined, { includeComments: true });
  } catch {
    return null;
  }
}

export async function buildManagerThreadDiagnostics(args: {
  config: AppConfig;
  repositories: Pick<ManagerRepositories, "ownerMap" | "workgraph">;
  channelId: string;
  rootThreadTs: string;
}): Promise<ManagerThreadDiagnostics> {
  const threadKey = buildWorkgraphThreadKey(args.channelId, args.rootThreadTs);
  const threadPaths = buildThreadPaths(args.config.workspaceDir, args.channelId, args.rootThreadTs);
  const [planningContext, awaitingFollowups, slackThreadContext, recentChannelContext, ownerMap, lastQueryContext] = await Promise.all([
    getThreadPlanningContext(args.repositories.workgraph, threadKey),
    listAwaitingFollowups(args.repositories.workgraph),
    getSlackThreadContext(args.config.workspaceDir, args.channelId, args.rootThreadTs, 12),
    getRecentChannelContext(args.config.workspaceDir, args.channelId, 5, 8),
    args.repositories.ownerMap.load(),
    loadThreadQueryContinuation(threadPaths),
  ]);

  const relatedIssueIds = new Set<string>([
    planningContext?.parentIssue?.issueId,
    ...(planningContext?.childIssues.map((issue) => issue.issueId) ?? []),
    ...(planningContext?.linkedIssues.map((issue) => issue.issueId) ?? []),
    planningContext?.latestResolvedIssue?.issueId,
  ].filter(Boolean) as string[]);

  return {
    channelId: args.channelId,
    rootThreadTs: args.rootThreadTs,
    threadKey,
    planningContext,
    awaitingFollowups: awaitingFollowups.filter((issue) => relatedIssueIds.has(issue.issueId)),
    lastQueryContext,
    slackThreadContext,
    recentChannelContext,
    ownerMapDiagnostics: analyzeOwnerMap(ownerMap),
  };
}

export async function buildManagerIssueDiagnostics(args: {
  config: AppConfig;
  repositories: Pick<ManagerRepositories, "followups" | "workgraph">;
  issueId: string;
  env: LinearCommandEnv;
}): Promise<ManagerIssueDiagnostics> {
  const [issueContext, latestSource, followups, linearIssue] = await Promise.all([
    getIssueContext(args.repositories.workgraph, args.issueId),
    getLatestIssueSource(args.repositories.workgraph, args.issueId),
    args.repositories.followups.load(),
    loadLinearIssueBestEffort(args.issueId, args.env),
  ]);

  const followup = followups.find((entry) => entry.issueId === args.issueId);
  const slackThreadContext = latestSource
    ? await getSlackThreadContext(
      args.config.workspaceDir,
      latestSource.channelId,
      latestSource.rootThreadTs,
      12,
    ).catch(() => undefined)
    : undefined;

  return {
    issueId: args.issueId,
    issueContext,
    latestSource,
    followup,
    slackThreadContext,
    linearIssue,
  };
}
