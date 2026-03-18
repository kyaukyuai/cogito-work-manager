import type { WorkgraphRepository } from "./file-backed-workgraph-repository.js";
import type {
  WorkgraphIssueProjection,
  WorkgraphProjection,
  WorkgraphThreadProjection,
} from "./projection.js";

export interface WorkgraphIssueContext {
  issueId: string;
  title?: string;
  kind?: "parent" | "execution" | "research";
  parentIssueId?: string;
  dueDate?: string;
  assignee?: string;
  threadKeys: string[];
  lastStatus?: "progress" | "completed" | "blocked";
  lastStatusAt?: string;
  followupStatus?: "awaiting-response" | "resolved";
  lastFollowupCategory?: string;
  lastFollowupRequestedAt?: string;
  lastFollowupResolvedAt?: string;
  lastFollowupResolvedReason?: "response" | "risk-cleared" | "completed" | "answered";
}

export interface WorkgraphThreadContext {
  threadKey: string;
  sourceChannelId?: string;
  sourceThreadTs?: string;
  lastEventAt?: string;
  intakeStatus?: "needs-clarification" | "linked-existing" | "created";
  pendingClarification: boolean;
  parentIssueId?: string;
  childIssueIds: string[];
  linkedIssueIds: string[];
  planningReason?: string;
  lastResolvedIssueId?: string;
  awaitingFollowupIssueIds: string[];
  issueStatuses: Record<string, "progress" | "completed" | "blocked">;
}

export interface PendingClarificationContext extends WorkgraphThreadContext {}

export interface AwaitingFollowupContext extends WorkgraphIssueContext {
  followupStatus: "awaiting-response";
}

function mapIssueContext(issue: WorkgraphIssueProjection): WorkgraphIssueContext {
  return {
    issueId: issue.issueId,
    title: issue.title,
    kind: issue.kind,
    parentIssueId: issue.parentIssueId,
    dueDate: issue.dueDate,
    assignee: issue.assignee,
    threadKeys: [...issue.threadKeys],
    lastStatus: issue.lastStatus,
    lastStatusAt: issue.lastStatusAt,
    followupStatus: issue.followupStatus,
    lastFollowupCategory: issue.lastFollowupCategory,
    lastFollowupRequestedAt: issue.lastFollowupRequestedAt,
    lastFollowupResolvedAt: issue.lastFollowupResolvedAt,
    lastFollowupResolvedReason: issue.lastFollowupResolvedReason,
  };
}

function mapThreadContext(thread: WorkgraphThreadProjection): WorkgraphThreadContext {
  return {
    threadKey: thread.threadKey,
    sourceChannelId: thread.sourceChannelId,
    sourceThreadTs: thread.sourceThreadTs,
    lastEventAt: thread.lastEventAt,
    intakeStatus: thread.intakeStatus,
    pendingClarification: thread.pendingClarification,
    parentIssueId: thread.parentIssueId,
    childIssueIds: [...thread.childIssueIds],
    linkedIssueIds: [...thread.linkedIssueIds],
    planningReason: thread.planningReason,
    lastResolvedIssueId: thread.lastResolvedIssueId,
    awaitingFollowupIssueIds: [...thread.awaitingFollowupIssueIds],
    issueStatuses: { ...thread.issueStatuses },
  };
}

async function loadProjection(repository: WorkgraphRepository): Promise<WorkgraphProjection> {
  return repository.project();
}

export async function getThreadContext(
  repository: WorkgraphRepository,
  threadKey: string,
): Promise<WorkgraphThreadContext | undefined> {
  const projection = await loadProjection(repository);
  const thread = projection.threads[threadKey];
  return thread ? mapThreadContext(thread) : undefined;
}

export async function getIssueContext(
  repository: WorkgraphRepository,
  issueId: string,
): Promise<WorkgraphIssueContext | undefined> {
  const projection = await loadProjection(repository);
  const issue = projection.issues[issueId];
  return issue ? mapIssueContext(issue) : undefined;
}

export async function listPendingClarifications(
  repository: WorkgraphRepository,
): Promise<PendingClarificationContext[]> {
  const projection = await loadProjection(repository);
  return Object.values(projection.threads)
    .filter((thread) => thread.pendingClarification)
    .map(mapThreadContext);
}

export async function listAwaitingFollowups(
  repository: WorkgraphRepository,
): Promise<AwaitingFollowupContext[]> {
  const projection = await loadProjection(repository);
  return Object.values(projection.issues)
    .filter((issue): issue is WorkgraphIssueProjection & { followupStatus: "awaiting-response" } => (
      issue.followupStatus === "awaiting-response"
    ))
    .map((issue) => ({
      ...mapIssueContext(issue),
      followupStatus: "awaiting-response",
    }));
}
