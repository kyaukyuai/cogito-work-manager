import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  execLinear,
  execLinearJson,
  type LinearCommandEnv,
} from "./command-runner.js";
import type {
  CreateIssueInput,
  GetLinearIssueOptions,
  LinearBatchCreateFailureDetails,
  LinearBatchCreateFailureStep,
  LinearBlockedUpdateResult,
  LinearCycle,
  LinearIssue,
  LinearIssueProject,
  LinearIssueResult,
  LinearLabel,
  LinearListResult,
  LinearTeam,
  LinearUser,
  LinearWorkflowState,
  ManagedCreateIssueBatchInput,
  ManagedCreateIssueBatchResult,
  ManagedCreateIssueInput,
  ManagedUpdateIssueInput,
  RiskPolicy,
  SearchIssuesInput,
  UpdateIssueInput,
} from "./types.js";

interface CliIssueState {
  id?: string;
  name?: string;
  color?: string;
  type?: string | null;
}

interface CliIssueUser {
  id?: string;
  name?: string | null;
  displayName?: string | null;
  email?: string | null;
  initials?: string | null;
  active?: boolean;
  description?: string | null;
  timezone?: string | null;
  lastSeen?: string | null;
  statusEmoji?: string | null;
  statusLabel?: string | null;
  guest?: boolean;
  isAssignable?: boolean;
}

interface CliIssueLabel {
  id?: string | null;
  name?: string | null;
}

interface CliIssueRef {
  id?: string;
  identifier?: string;
  title?: string;
  url?: string | null;
  dueDate?: string | null;
  state?: CliIssueState | null;
}

interface CliIssueProject {
  id?: string | null;
  name?: string | null;
  slugId?: string | null;
}

interface CliIssuePayload extends CliIssueRef {
  description?: string | null;
  createdAt?: string | null;
  completedAt?: string | null;
  stateName?: string | null;
  priority?: number | null;
  priorityLabel?: string | null;
  updatedAt?: string | null;
  creator?: CliIssueUser | null;
  assignee?: CliIssueUser | null;
  labels?: CliIssueLabel[] | null;
  project?: CliIssueProject | null;
  cycle?: {
    id?: string;
    number?: number | null;
    name?: string | null;
    startsAt?: string | null;
    endsAt?: string | null;
  } | null;
  parent?: CliIssueRef | null;
  children?: CliIssueRef[] | { nodes?: CliIssueRef[] } | null;
  relations?: unknown;
  comments?: Array<{
    id?: string;
    body?: string | null;
    createdAt?: string | null;
    user?: CliIssueUser | null;
  }> | null;
}

interface CliRelationListPayload {
  issue?: CliIssueRef;
  outgoing?: Array<{
    id?: string | null;
    type?: string | null;
    issue?: CliIssueRef | null;
  }>;
  incoming?: Array<{
    id?: string | null;
    type?: string | null;
    issue?: CliIssueRef | null;
  }>;
}

interface CliTeamMembersPayload {
  team?: string;
  members?: CliIssueUser[];
}

interface CliTeamPayload {
  id?: string | null;
  key?: string | null;
  name?: string | null;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  archivedAt?: string | null;
}

interface CliIssueParentPayload {
  issue?: CliIssueRef;
  parent?: CliIssueRef | null;
}

interface CliIssueChildrenPayload {
  issue?: CliIssueRef;
  children?: CliIssueRef[];
}

interface CliCommentPayload {
  id?: string;
  body?: string;
  url?: string | null;
}

interface CliBatchCreatePayload {
  parent?: CliIssuePayload;
  children?: CliIssuePayload[];
}

interface CliJsonErrorEnvelope {
  success: false;
  error?: {
    type?: string;
    message?: string;
    suggestion?: string | null;
    context?: string | null;
    details?: Record<string, unknown>;
  };
}

interface BatchIssueSpec {
  title: string;
  description: string;
  assignee?: string;
  dueDate?: string;
  priority?: number;
  state?: string;
}

interface LinearDescriptionArgOptions {
  descriptionFilePath?: string;
}

interface LinearCommentArgOptions {
  bodyFilePath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function toNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return toStringOrUndefined(value);
}

function toNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requireEnv(env: LinearCommandEnv, key: "LINEAR_API_KEY" | "LINEAR_TEAM_KEY"): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function ensureLinearAuthConfigured(env: LinearCommandEnv): void {
  const hasApiKey = Boolean(env.LINEAR_API_KEY?.trim());
  const hasWorkspace = Boolean(env.LINEAR_WORKSPACE?.trim());

  if (!hasApiKey && !hasWorkspace) {
    throw new Error("Linear authentication is not configured. Set LINEAR_API_KEY or LINEAR_WORKSPACE-backed credentials.");
  }
}

function workspaceArgs(env: LinearCommandEnv): string[] {
  if (env.LINEAR_API_KEY?.trim()) return [];
  const workspace = env.LINEAR_WORKSPACE?.trim();
  return workspace ? ["-w", workspace] : [];
}

function hasMultilineLinearText(text: string | undefined): boolean {
  return Boolean(text && /[\r\n]/.test(text));
}

function toIssueRef(raw: unknown): Pick<LinearIssue, "id" | "identifier" | "title" | "url"> | undefined {
  if (!isRecord(raw)) return undefined;
  const id = toStringOrUndefined(raw.id);
  const identifier = toStringOrUndefined(raw.identifier);
  const title = toStringOrUndefined(raw.title);
  if (!id || !identifier || !title) return undefined;
  return {
    id,
    identifier,
    title,
    url: toNullableString(raw.url) ?? undefined,
  };
}

function normalizeLinearUser(raw: unknown): LinearUser | undefined {
  if (!isRecord(raw)) return undefined;
  const id = toStringOrUndefined(raw.id);
  if (!id) return undefined;
  return {
    id,
    name: toNullableString(raw.name),
    displayName: toNullableString(raw.displayName),
    email: toNullableString(raw.email),
  };
}

function normalizeLinearState(raw: unknown): LinearWorkflowState | undefined {
  if (!isRecord(raw)) return undefined;
  const name = toStringOrUndefined(raw.name);
  if (!name) return undefined;
  return {
    id: toStringOrUndefined(raw.id) ?? name,
    name,
    type: toNullableString(raw.type),
  };
}

function normalizeLinearStateFromIssuePayload(rawIssue: Record<string, unknown>): LinearWorkflowState | null {
  const normalizedState = normalizeLinearState(rawIssue.state);
  if (normalizedState) {
    return normalizedState;
  }

  const additiveStateName = toNullableString(rawIssue.stateName);
  const partialState = isRecord(rawIssue.state) ? rawIssue.state : undefined;
  const partialStateId = toStringOrUndefined(partialState?.id);
  const partialStateType = toNullableString(partialState?.type);
  if (!additiveStateName) {
    return null;
  }

  return {
    id: partialStateId ?? additiveStateName,
    name: additiveStateName,
    type: partialStateType ?? null,
  };
}

function normalizeLinearCycle(raw: unknown): LinearCycle | undefined {
  if (!isRecord(raw)) return undefined;

  const id = toStringOrUndefined(raw.id);
  const number = toNumberOrUndefined(raw.number);
  const name = toNullableString(raw.name);
  const startsAt = toNullableString(raw.startsAt);
  const endsAt = toNullableString(raw.endsAt);

  if (!id && number == null && !name) {
    return undefined;
  }

  return {
    id,
    number,
    name,
    startsAt,
    endsAt,
  };
}

function normalizeLinearComment(raw: unknown): NonNullable<LinearIssue["comments"]>[number] | undefined {
  if (!isRecord(raw)) return undefined;
  const id = toStringOrUndefined(raw.id);
  const body = toStringOrUndefined(raw.body);
  if (!id || !body) return undefined;
  const user = normalizeLinearUser(raw.user);
  return {
    id,
    body,
    createdAt: toNullableString(raw.createdAt),
    user: user
      ? {
          name: user.name ?? undefined,
          displayName: user.displayName ?? undefined,
        }
      : null,
  };
}

function normalizeLinearLabel(raw: unknown): LinearLabel | undefined {
  if (!isRecord(raw)) return undefined;
  const id = toNullableString(raw.id);
  const name = toNullableString(raw.name);
  if (!id && !name) return undefined;
  return { id, name };
}

function normalizeLinearIssueProject(raw: unknown): LinearIssueProject | undefined {
  if (!isRecord(raw)) return undefined;
  const id = toNullableString(raw.id);
  const name = toNullableString(raw.name);
  const slugId = toNullableString(raw.slugId);
  if (!id && !name && !slugId) {
    return undefined;
  }
  return {
    id,
    name,
    slugId,
  };
}

function deriveLatestActionKind(body: string): LinearIssue["latestActionKind"] {
  const trimmed = body.trim();
  if (trimmed.startsWith("## Progress update")) return "progress";
  if (trimmed.startsWith("## Blocked update")) return "blocked";
  if (trimmed.startsWith("## Slack source")) return "slack-source";
  return "other";
}

function normalizeEmbeddedRelations(raw: unknown): Pick<LinearIssue, "relations" | "inverseRelations"> {
  if (!isRecord(raw)) {
    return { relations: [], inverseRelations: [] };
  }

  const relations: NonNullable<LinearIssue["relations"]> = [];
  const inverseRelations: NonNullable<LinearIssue["inverseRelations"]> = [];

  const pushOutgoing = (items: unknown, type: string) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!isRecord(item)) continue;
      const relatedIssue = toIssueRef(item);
      if (!relatedIssue) continue;
      relations.push({
        id: toNullableString(item.relationId) ?? toNullableString(item.id) ?? undefined,
        type,
        relatedIssue,
      });
    }
  };

  const pushIncoming = (items: unknown, type: string) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!isRecord(item)) continue;
      const issue = toIssueRef(item);
      if (!issue) continue;
      inverseRelations.push({
        id: toNullableString(item.relationId) ?? toNullableString(item.id) ?? undefined,
        type,
        issue,
      });
    }
  };

  pushOutgoing(raw.blocks, "blocks");
  pushOutgoing(raw.related, "related");
  pushIncoming(raw.blockedBy, "blocked-by");
  pushIncoming(raw.duplicatedBy, "duplicate");

  const duplicateOf = toIssueRef(raw.duplicateOf);
  if (duplicateOf) {
    relations.push({
      id: isRecord(raw.duplicateOf) ? toNullableString(raw.duplicateOf.relationId) ?? undefined : undefined,
      type: "duplicate",
      relatedIssue: duplicateOf,
    });
  }

  return { relations, inverseRelations };
}

export function normalizeRelationListPayload(raw: unknown): Pick<LinearIssue, "relations" | "inverseRelations"> {
  if (!isRecord(raw)) {
    return { relations: [], inverseRelations: [] };
  }

  const relations = Array.isArray(raw.outgoing)
    ? raw.outgoing
      .map((item) => {
        if (!isRecord(item)) return undefined;
        return {
          id: toNullableString(item.id) ?? undefined,
          type: toNullableString(item.type) ?? undefined,
          relatedIssue: toIssueRef(item.issue),
        };
      })
      .filter((item) => item?.relatedIssue) as NonNullable<LinearIssue["relations"]>
    : [];

  const inverseRelations = Array.isArray(raw.incoming)
    ? raw.incoming
      .map((item) => {
        if (!isRecord(item)) return undefined;
        return {
          id: toNullableString(item.id) ?? undefined,
          type: toNullableString(item.type) ?? undefined,
          issue: toIssueRef(item.issue),
        };
      })
      .filter((item) => item?.issue) as NonNullable<LinearIssue["inverseRelations"]>
    : [];

  return { relations, inverseRelations };
}

export function normalizeTeamMembersPayload(raw: unknown): LinearUser[] {
  if (!isRecord(raw) || !Array.isArray(raw.members)) return [];
  return raw.members.map((member) => normalizeLinearUser(member)).filter(Boolean) as LinearUser[];
}

export function normalizeTeamListPayload(raw: unknown): LinearTeam[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((team) => {
      if (!isRecord(team)) return undefined;
      const key = toNullableString(team.key) ?? undefined;
      const name = toNullableString(team.name) ?? undefined;
      if (!key && !name) return undefined;
      return {
        id: toNullableString(team.id) ?? undefined,
        key,
        name,
        description: toNullableString(team.description) ?? undefined,
        color: toNullableString(team.color) ?? undefined,
        icon: toNullableString(team.icon) ?? undefined,
        archivedAt: toNullableString(team.archivedAt) ?? undefined,
      } satisfies LinearTeam;
    })
    .filter(Boolean) as LinearTeam[];
}

export function normalizeLinearIssuePayload(raw: unknown): LinearIssue | undefined {
  if (!isRecord(raw)) return undefined;

  const id = toStringOrUndefined(raw.id);
  const identifier = toStringOrUndefined(raw.identifier);
  const title = toStringOrUndefined(raw.title);
  if (!id || !identifier || !title) return undefined;

  const childrenSource = Array.isArray(raw.children)
    ? raw.children
    : isRecord(raw.children) && Array.isArray(raw.children.nodes)
      ? raw.children.nodes
      : [];

  const children = childrenSource.map((child) => toIssueRef(child)).filter(Boolean) as NonNullable<LinearIssue["children"]>;
  const embeddedRelations = normalizeEmbeddedRelations(raw.relations);
  const comments = Array.isArray(raw.comments)
    ? raw.comments.map((comment) => normalizeLinearComment(comment)).filter(Boolean) as NonNullable<LinearIssue["comments"]>
    : [];
  const latestComment = [...comments].sort((left, right) => {
    return Date.parse(right.createdAt ?? "") - Date.parse(left.createdAt ?? "");
  })[0];

  const normalizedState = normalizeLinearStateFromIssuePayload(raw);

  return {
    id,
    identifier,
    title,
    url: toNullableString(raw.url),
    description: toNullableString(raw.description),
    createdAt: toNullableString(raw.createdAt),
    completedAt: toNullableString(raw.completedAt),
    dueDate: toNullableString(raw.dueDate),
    priority: toNumberOrUndefined(raw.priority),
    priorityLabel: toNullableString(raw.priorityLabel),
    cycle: normalizeLinearCycle(raw.cycle) ?? null,
    updatedAt: toNullableString(raw.updatedAt),
    creator: normalizeLinearUser(raw.creator) ?? null,
    assignee: normalizeLinearUser(raw.assignee) ?? null,
    labels: Array.isArray(raw.labels)
      ? raw.labels.map((label) => normalizeLinearLabel(label)).filter(Boolean) as LinearLabel[]
      : [],
    state: normalizedState,
    project: normalizeLinearIssueProject(raw.project) ?? null,
    parent: toIssueRef(raw.parent) ?? null,
    children,
    relations: embeddedRelations.relations,
    inverseRelations: embeddedRelations.inverseRelations,
    comments,
    latestActionKind: latestComment ? deriveLatestActionKind(latestComment.body) : undefined,
    latestActionAt: latestComment?.createdAt ?? null,
  };
}

function formatIssueResultOutput(issue: LinearIssue, action: string): string {
  const lines = [`${action}: ${issue.identifier}`];
  lines.push(issue.title);
  if (issue.url) lines.push(issue.url);
  return lines.join("\n");
}

async function resolveAssigneeSpecifier(
  env: LinearCommandEnv,
  assignee: string | undefined,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const normalized = assignee?.trim();
  if (!normalized) return undefined;
  if (normalized.toLowerCase() === "self") return "self";

  const lowered = normalized.toLowerCase();
  const members = await listLinearTeamMembers(env, signal).catch(() => []);
  const exact = members.find((member) => {
    return [member.name, member.displayName, member.email, member.id]
      .filter(Boolean)
      .some((candidate) => candidate?.toLowerCase() === lowered);
  });

  return exact?.name ?? exact?.email ?? exact?.displayName ?? normalized;
}

function buildManagedCreateIssueArgs(
  input: ManagedCreateIssueInput,
  env: LinearCommandEnv = process.env,
  assignee?: string,
  options: LinearDescriptionArgOptions = {},
): string[] {
  ensureLinearAuthConfigured(env);
  const title = input.title.trim();
  const description = input.description.trim();
  const teamKey = requireEnv(env, "LINEAR_TEAM_KEY");

  if (!title) throw new Error("Issue title is required");
  if (!description) throw new Error("Issue description is required");

  const args = [
    "issue",
    "create",
    ...workspaceArgs(env),
    "--no-interactive",
    "--title",
    title,
    "--team",
    teamKey,
    "--json",
  ];

  if (options.descriptionFilePath?.trim()) {
    args.push("--description-file", options.descriptionFilePath.trim());
  } else {
    args.push("--description", description);
  }

  if (input.state?.trim()) args.push("--state", input.state.trim());
  if (input.dueDate?.trim()) args.push("--due-date", input.dueDate.trim());
  if (input.project?.trim()) args.push("--project", input.project.trim());
  if (input.priority != null) args.push("--priority", String(input.priority));
  if (assignee?.trim()) args.push("--assignee", assignee.trim());
  if (input.parent?.trim()) args.push("--parent", input.parent.trim());

  return args;
}

function buildManagedUpdateIssueArgs(
  input: ManagedUpdateIssueInput,
  env: LinearCommandEnv = process.env,
  assignee?: string,
  options: LinearDescriptionArgOptions = {},
): string[] {
  ensureLinearAuthConfigured(env);
  const issueId = input.issueId.trim();
  if (!issueId) throw new Error("Issue ID is required");

  const args = ["issue", "update", ...workspaceArgs(env), issueId, "--json"];

  if (input.title?.trim()) args.push("--title", input.title.trim());
  if (input.description?.trim()) {
    if (options.descriptionFilePath?.trim()) {
      args.push("--description-file", options.descriptionFilePath.trim());
    } else {
      args.push("--description", input.description.trim());
    }
  }
  if (input.state?.trim()) args.push("--state", input.state.trim());
  if (input.dueDate?.trim()) args.push("--due-date", input.dueDate.trim());
  if (input.clearDueDate) args.push("--clear-due-date");
  if (input.priority != null) args.push("--priority", String(input.priority));
  if (assignee?.trim()) args.push("--assignee", assignee.trim());
  if (input.parent?.trim()) args.push("--parent", input.parent.trim());
  if (input.parent === null) {
    throw new Error("Clearing parent relationships is not supported by linear-cli v2.4.0");
  }

  if (args.length === 4 + workspaceArgs(env).length) {
    throw new Error("At least one update field is required");
  }

  return args;
}

function buildBatchIssueSpec(input: ManagedCreateIssueInput, assignee?: string): BatchIssueSpec {
  const title = input.title.trim();
  const description = input.description.trim();
  if (!title) throw new Error("Issue title is required");
  if (!description) throw new Error("Issue description is required");

  return {
    title,
    description,
    assignee: assignee?.trim() || undefined,
    dueDate: input.dueDate?.trim() || undefined,
    priority: input.priority,
    state: input.state?.trim() || undefined,
  };
}

export function buildCreateIssueArgs(
  input: CreateIssueInput,
  env: LinearCommandEnv = process.env,
  options: LinearDescriptionArgOptions = {},
): string[] {
  ensureLinearAuthConfigured(env);
  const title = input.title.trim();
  const description = input.description.trim();
  const teamKey = requireEnv(env, "LINEAR_TEAM_KEY");

  if (!title) {
    throw new Error("Issue title is required");
  }
  if (!description) {
    throw new Error("Issue description is required");
  }

  const args = ["issue", "create", "--no-interactive", "--title", title];
  if (options.descriptionFilePath?.trim()) {
    args.push("--description-file", options.descriptionFilePath.trim());
  } else {
    args.push("--description", description);
  }
  args.push(...workspaceArgs(env), "--team", teamKey);

  if (input.state?.trim()) {
    args.push("--state", input.state.trim());
  }

  if (input.dueDate?.trim()) {
    args.push("--due-date", input.dueDate.trim());
  }

  if (input.project?.trim()) {
    args.push("--project", input.project.trim());
  }

  return args;
}

export function buildListActiveIssuesArgs(limit = 20, env: LinearCommandEnv = process.env): string[] {
  ensureLinearAuthConfigured(env);
  const teamKey = requireEnv(env, "LINEAR_TEAM_KEY");
  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 20;

  return [
    "issue",
    "list",
    "--all-assignees",
    "--limit",
    String(normalizedLimit),
    "--no-pager",
    "--sort",
    "manual",
    "-s",
    "unstarted",
    "-s",
    "started",
    ...workspaceArgs(env),
    "--team",
    teamKey,
  ];
}

export function buildUpdateIssueArgs(input: UpdateIssueInput, env: LinearCommandEnv = process.env): string[] {
  ensureLinearAuthConfigured(env);

  const issueId = input.issueId.trim();
  if (!issueId) {
    throw new Error("Issue ID is required");
  }

  const workspace = workspaceArgs(env);
  const args = ["issue", "update", ...workspace, issueId];
  const state = input.state?.trim();
  const dueDate = input.dueDate?.trim();

  if (state) {
    args.push("--state", state);
  }

  if (dueDate) {
    args.push("--due-date", dueDate);
  }

  if (input.clearDueDate) {
    args.push("--clear-due-date");
  }

  if (args.length === 3 + workspace.length) {
    throw new Error("At least one update field is required");
  }

  return args;
}

export function buildIssueUrlArgs(issueId: string, env: LinearCommandEnv = process.env): string[] {
  const trimmed = issueId.trim();
  if (!trimmed) {
    throw new Error("Issue ID is required");
  }

  return ["issue", "url", ...workspaceArgs(env), trimmed];
}

export function buildGetIssueArgs(
  issueId: string,
  env: LinearCommandEnv = process.env,
  options: GetLinearIssueOptions = {},
): string[] {
  const trimmed = issueId.trim();
  if (!trimmed) throw new Error("Issue ID is required");
  const args = ["issue", "view", ...workspaceArgs(env), trimmed, "--json"];
  if (!options.includeComments) {
    args.push("--no-comments");
  }
  return args;
}

export function buildSearchIssuesArgs(input: SearchIssuesInput, env: LinearCommandEnv = process.env): string[] {
  ensureLinearAuthConfigured(env);
  const teamKey = requireEnv(env, "LINEAR_TEAM_KEY");
  const query = input.query.trim();
  const limit = Number.isFinite(input.limit) && input.limit != null && input.limit >= 0 ? Math.trunc(input.limit) : 10;
  if (!query) throw new Error("Search query is required");

  const args = [
    "issue",
    "list",
    "--json",
    "--no-pager",
    "--limit",
    String(limit),
    "--sort",
    "manual",
    ...workspaceArgs(env),
    "--team",
    teamKey,
  ];

  if (input.allAssignees ?? true) {
    args.push("--all-assignees");
  }

  if (input.allStates) {
    args.push("--all-states");
  } else {
    const states = input.states?.length ? input.states : ["triage", "backlog", "unstarted", "started"];
    for (const state of states) {
      args.push("-s", state);
    }
  }

  args.push("--query", query);

  if (input.parent?.trim()) args.push("--parent", input.parent.trim());
  if (input.priority != null) args.push("--priority", String(input.priority));
  if (input.updatedBefore?.trim()) args.push("--updated-before", input.updatedBefore.trim());
  if (input.dueBefore?.trim()) args.push("--due-before", input.dueBefore.trim());

  return args;
}

export function buildIssueCommentAddArgs(
  issueId: string,
  body: string,
  env: LinearCommandEnv = process.env,
  options: LinearCommentArgOptions = {},
): string[] {
  const trimmedIssueId = issueId.trim();
  const trimmedBody = body.trim();
  if (!trimmedIssueId) throw new Error("Issue ID is required");
  if (!trimmedBody) throw new Error("Comment body is required");

  if (options.bodyFilePath?.trim()) {
    return ["issue", "comment", "add", ...workspaceArgs(env), trimmedIssueId, "--body-file", options.bodyFilePath.trim(), "--json"];
  }

  return ["issue", "comment", "add", ...workspaceArgs(env), trimmedIssueId, "--body", trimmedBody, "--json"];
}

async function withTemporaryLinearTextFile<T>(
  prefix: string,
  fileName: string,
  content: string,
  action: (filePath: string) => Promise<T>,
): Promise<T> {
  const tempDir = await mkdtemp(join(tmpdir(), prefix));
  const filePath = join(tempDir, fileName);
  try {
    await writeFile(filePath, content, "utf8");
    return await action(filePath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function buildIssueRelationAddArgs(
  issueId: string,
  relationType: "blocks" | "blocked-by",
  relatedIssueId: string,
  env: LinearCommandEnv = process.env,
): string[] {
  const from = issueId.trim();
  const to = relatedIssueId.trim();
  if (!from || !to) throw new Error("Issue IDs are required");
  return ["issue", "relation", "add", ...workspaceArgs(env), from, relationType, to, "--json"];
}

export function buildIssueRelationListArgs(issueId: string, env: LinearCommandEnv = process.env): string[] {
  const trimmed = issueId.trim();
  if (!trimmed) throw new Error("Issue ID is required");
  return ["issue", "relation", "list", ...workspaceArgs(env), trimmed, "--json"];
}

export function buildTeamMembersArgs(env: LinearCommandEnv = process.env): string[] {
  ensureLinearAuthConfigured(env);
  const teamKey = requireEnv(env, "LINEAR_TEAM_KEY");
  return ["team", "members", ...workspaceArgs(env), teamKey, "--json"];
}

export function buildTeamListArgs(env: LinearCommandEnv = process.env): string[] {
  ensureLinearAuthConfigured(env);
  return ["team", "list", ...workspaceArgs(env), "--json"];
}

export function buildIssueParentArgs(issueId: string, env: LinearCommandEnv = process.env): string[] {
  const trimmed = issueId.trim();
  if (!trimmed) throw new Error("Issue ID is required");
  return ["issue", "parent", ...workspaceArgs(env), trimmed, "--json"];
}

export function buildIssueChildrenArgs(issueId: string, env: LinearCommandEnv = process.env): string[] {
  const trimmed = issueId.trim();
  if (!trimmed) throw new Error("Issue ID is required");
  return ["issue", "children", ...workspaceArgs(env), trimmed, "--json"];
}

export function buildCreateBatchArgs(
  filePath: string,
  env: LinearCommandEnv = process.env,
  options: { project?: string } = {},
): string[] {
  if (!filePath.trim()) throw new Error("Batch file path is required");
  const args = ["issue", "create-batch", ...workspaceArgs(env), "--file", filePath];
  if (options.project?.trim()) {
    args.push("--project", options.project.trim());
  }
  args.push("--json");
  return args;
}

async function loadIssueRelations(
  issueId: string,
  env: LinearCommandEnv,
  signal?: AbortSignal,
): Promise<Pick<LinearIssue, "relations" | "inverseRelations">> {
  const payload = await execLinearJson<CliRelationListPayload>(buildIssueRelationListArgs(issueId, env), env, signal);
  return normalizeRelationListPayload(payload);
}

export async function createLinearIssue(
  input: CreateIssueInput,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearIssueResult> {
  const issue = await createManagedLinearIssue(input, env, signal);
  return {
    issueId: issue.identifier,
    title: issue.title,
    url: issue.url ?? undefined,
    output: formatIssueResultOutput(issue, "Created issue"),
  };
}

export async function listActiveLinearIssues(
  limit = 20,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearListResult> {
  const listed = await execLinear(buildListActiveIssuesArgs(limit, env), env, signal);
  return {
    output: listed.combined,
  };
}

export async function updateLinearIssue(
  input: UpdateIssueInput,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearIssueResult> {
  const issue = await updateManagedLinearIssue(input, env, signal);
  return {
    issueId: issue.identifier,
    title: issue.title,
    url: issue.url ?? undefined,
    output: formatIssueResultOutput(issue, "Updated issue"),
  };
}

export async function getLinearIssue(
  issueId: string,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
  options: GetLinearIssueOptions = {},
): Promise<LinearIssue> {
  const payload = await execLinearJson<CliIssuePayload>(buildGetIssueArgs(issueId, env, options), env, signal);
  const issue = normalizeLinearIssuePayload(payload);
  if (!issue) {
    throw new Error(`Issue not found: ${issueId}`);
  }
  return issue;
}

export async function getLinearIssueParent(
  issueId: string,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<Pick<LinearIssue, "id" | "identifier" | "title" | "url"> | null> {
  const payload = await execLinearJson<CliIssueParentPayload>(buildIssueParentArgs(issueId, env), env, signal);
  return toIssueRef(payload.parent) ?? null;
}

export async function getLinearIssueChildren(
  issueId: string,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<Array<Pick<LinearIssue, "id" | "identifier" | "title" | "url">>> {
  const payload = await execLinearJson<CliIssueChildrenPayload>(buildIssueChildrenArgs(issueId, env), env, signal);
  return Array.isArray(payload.children)
    ? payload.children.map((child) => toIssueRef(child)).filter(Boolean) as Array<Pick<LinearIssue, "id" | "identifier" | "title" | "url">>
    : [];
}

export async function searchLinearIssues(
  input: SearchIssuesInput,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearIssue[]> {
  ensureLinearAuthConfigured(env);
  const query = input.query.trim();
  if (!query) {
    return [];
  }

  const payload = await execLinearJson<CliIssuePayload[]>(buildSearchIssuesArgs(input, env), env, signal);
  return payload.map((issue) => normalizeLinearIssuePayload(issue)).filter(Boolean) as LinearIssue[];
}

export async function createManagedLinearIssue(
  input: ManagedCreateIssueInput,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearIssue> {
  const assignee = await resolveAssigneeSpecifier(env, input.assignee, signal);
  const executeCreate = async (descriptionFilePath?: string) =>
    execLinearJson<CliIssuePayload>(
      buildManagedCreateIssueArgs(input, env, assignee, { descriptionFilePath }),
      env,
      signal,
    );
  const payload = hasMultilineLinearText(input.description)
    ? await withTemporaryLinearTextFile(
        "cogito-work-manager-linear-create-",
        "description.md",
        input.description.trim(),
        (descriptionFilePath) => executeCreate(descriptionFilePath),
      )
    : await executeCreate();
  const issue = normalizeLinearIssuePayload(payload);
  if (!issue) {
    throw new Error("Linear issue creation returned no issue");
  }
  return issue;
}

export async function createManagedLinearIssueBatch(
  input: ManagedCreateIssueBatchInput,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<ManagedCreateIssueBatchResult> {
  ensureLinearAuthConfigured(env);
  const teamKey = requireEnv(env, "LINEAR_TEAM_KEY");
  const tempDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-batch-"));
  const batchFilePath = join(tempDir, "issue-batch.json");

  try {
    const parentAssignee = await resolveAssigneeSpecifier(env, input.parent.assignee, signal);
    const children = await Promise.all(
      input.children.map(async (child) => buildBatchIssueSpec(child, await resolveAssigneeSpecifier(env, child.assignee, signal))),
    );

    const batchPayload = {
      team: teamKey,
      parent: buildBatchIssueSpec(input.parent, parentAssignee),
      children,
    };

    await writeFile(batchFilePath, JSON.stringify(batchPayload, null, 2), "utf8");

    let payload: CliBatchCreatePayload;
    try {
      const result = await execLinear(
        buildCreateBatchArgs(batchFilePath, env, { project: input.parent.project }),
        env,
        signal,
      );
      const raw = result.stdout || result.stderr;
      if (!raw) {
        throw new Error("linear command returned empty JSON output");
      }
      payload = JSON.parse(raw) as CliBatchCreatePayload;
    } catch (error) {
      const raw = error instanceof Error && "stdout" in error
        ? ((error as Error & { stdout?: string; stderr?: string; combined?: string }).stdout
          || (error as Error & { stdout?: string; stderr?: string; combined?: string }).stderr
          || (error as Error & { stdout?: string; stderr?: string; combined?: string }).combined
          || error.message)
        : (error instanceof Error ? error.message : String(error));
      const failure = parseLinearBatchCreateFailure(raw);
      if (failure) {
        throw Object.assign(new Error(failure.message), failure);
      }
      throw error;
    }

    const parent = normalizeLinearIssuePayload(payload.parent);
    if (!parent) {
      throw new Error("Linear issue batch creation returned no parent issue");
    }

    const normalizedChildren = Array.isArray(payload.children)
      ? payload.children.map((child) => normalizeLinearIssuePayload(child)).filter(Boolean) as LinearIssue[]
      : [];

    return {
      parent,
      children: normalizedChildren,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function updateManagedLinearIssue(
  input: ManagedUpdateIssueInput,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearIssue> {
  const comment = input.comment?.trim();
  const updateInput = comment ? { ...input, comment: undefined } : input;
  const assignee = await resolveAssigneeSpecifier(env, input.assignee, signal);
  const executeUpdate = async (descriptionFilePath?: string) =>
    execLinearJson<CliIssuePayload>(
      buildManagedUpdateIssueArgs(updateInput, env, assignee, { descriptionFilePath }),
      env,
      signal,
    );

  const hasUpdateFields = Boolean(
    updateInput.title?.trim()
      || updateInput.description?.trim()
      || updateInput.state?.trim()
      || updateInput.dueDate?.trim()
      || updateInput.clearDueDate
      || input.assignee?.trim()
      || updateInput.priority != null
      || updateInput.parent?.trim()
      || updateInput.parent === null,
  );

  let issue: LinearIssue | undefined;
  if (hasUpdateFields) {
    const payload = hasMultilineLinearText(updateInput.description)
      ? await withTemporaryLinearTextFile(
          "cogito-work-manager-linear-update-",
          "description.md",
          updateInput.description!.trim(),
          (descriptionFilePath) => executeUpdate(descriptionFilePath),
        )
      : await executeUpdate();
    issue = normalizeLinearIssuePayload(payload);
    if (!issue) {
      throw new Error("Linear issue update returned no issue");
    }
  }

  if (comment) {
    await addLinearComment(input.issueId, comment, env, signal);
  }

  if (!issue) {
    issue = await getLinearIssue(input.issueId, env, signal);
  }
  return issue;
}

export async function assignLinearIssue(
  issueId: string,
  assignee: string,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearIssue> {
  return updateManagedLinearIssue({ issueId, assignee }, env, signal);
}

export async function updateLinearIssueState(
  issueId: string,
  state: string,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearIssue> {
  return updateManagedLinearIssue({ issueId, state }, env, signal);
}

export async function updateLinearIssueStateWithComment(
  issueId: string,
  state: string,
  comment: string,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearIssue> {
  const issue = await updateManagedLinearIssue({ issueId, state }, env, signal);
  await addLinearComment(issueId, comment, env, signal);
  return issue;
}

export async function addLinearComment(
  issueId: string,
  body: string,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<{ id: string; url?: string | null; body: string }> {
  const executeComment = async (bodyFilePath?: string) =>
    execLinearJson<CliCommentPayload>(
      buildIssueCommentAddArgs(issueId, body, env, { bodyFilePath }),
      env,
      signal,
    );
  const payload = hasMultilineLinearText(body)
    ? await withTemporaryLinearTextFile(
        "cogito-work-manager-linear-comment-",
        "comment.md",
        body.trim(),
        (bodyFilePath) => executeComment(bodyFilePath),
      )
    : await executeComment();
  const id = toStringOrUndefined(payload.id);
  if (!id) {
    throw new Error("Failed to add Linear comment");
  }
  return {
    id,
    url: toNullableString(payload.url),
    body: toStringOrUndefined(payload.body) ?? body,
  };
}

export async function addLinearProgressComment(
  issueId: string,
  body: string,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<{ id: string; url?: string | null; body: string }> {
  return addLinearComment(issueId, `## Progress update\n${body.trim()}`, env, signal);
}

export async function markLinearIssueBlocked(
  issueId: string,
  body: string,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearBlockedUpdateResult> {
  const comment = await addLinearComment(issueId, `## Blocked update\n${body.trim()}`, env, signal);
  try {
    const issue = await updateManagedLinearIssue({ issueId, state: "blocked" }, env, signal);
    return {
      issue,
      commentId: comment.id,
      blockedStateApplied: true,
    };
  } catch {
    const issue = await getLinearIssue(issueId, env, signal);
    return {
      issue,
      commentId: comment.id,
      blockedStateApplied: false,
    };
  }
}

export async function addLinearRelation(
  issueId: string,
  relationType: "blocks" | "blocked-by",
  relatedIssueId: string,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<void> {
  await execLinearJson(buildIssueRelationAddArgs(issueId, relationType, relatedIssueId, env), env, signal);
}

export async function listLinearTeamMembers(
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearUser[]> {
  ensureLinearAuthConfigured(env);
  const payload = await execLinearJson<CliTeamMembersPayload>(buildTeamMembersArgs(env), env, signal);
  return normalizeTeamMembersPayload(payload);
}

export async function listLinearTeams(
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearTeam[]> {
  const payload = await execLinearJson<CliTeamPayload[]>(buildTeamListArgs(env), env, signal);
  return normalizeTeamListPayload(payload);
}

export async function listOpenLinearIssues(
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
  options?: { limit?: number },
): Promise<LinearIssue[]> {
  ensureLinearAuthConfigured(env);
  const teamKey = requireEnv(env, "LINEAR_TEAM_KEY");
  const payload = await execLinearJson<CliIssuePayload[]>(
    [
      "issue",
      "list",
      "--json",
      "--no-pager",
      "--limit",
      "0",
      "--sort",
      "manual",
      "--all-states",
      "--all-assignees",
      ...workspaceArgs(env),
      "--team",
      teamKey,
    ],
    env,
    signal,
  );

  const candidates = payload
    .map((issue) => normalizeLinearIssuePayload(issue))
    .filter(Boolean)
    .filter((issue) => {
      const stateName = issue?.state?.name?.toLowerCase() ?? "";
      return stateName !== "done" && stateName !== "completed" && stateName !== "canceled";
    }) as LinearIssue[];

  const requestedLimit = typeof options?.limit === "number" && Number.isFinite(options.limit)
    ? Math.max(0, Math.floor(options.limit))
    : undefined;
  const selected = requestedLimit == null
    ? candidates
    : candidates.slice(0, requestedLimit);

  const enriched = await Promise.all(
    selected.map(async (issue) => {
      const relationData = await loadIssueRelations(issue.identifier, env, signal).catch(() => ({
        relations: issue.relations ?? [],
        inverseRelations: issue.inverseRelations ?? [],
      }));
      return {
        ...issue,
        relations: relationData.relations,
        inverseRelations: relationData.inverseRelations,
      };
    }),
  );

  return enriched;
}

export async function listRiskyLinearIssues(
  _policy: RiskPolicy,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearIssue[]> {
  return listOpenLinearIssues(env, signal);
}

function normalizeLinearBatchFailureStep(raw: unknown): LinearBatchCreateFailureStep | undefined {
  if (!isRecord(raw)) return undefined;
  const stage = toStringOrUndefined(raw.stage);
  const index = toNumberOrUndefined(raw.index);
  const total = toNumberOrUndefined(raw.total);
  const title = toStringOrUndefined(raw.title);
  if (!stage && index == null && total == null && !title) {
    return undefined;
  }
  return { stage, index, total, title };
}

export function parseLinearBatchCreateFailure(raw: string): LinearBatchCreateFailureDetails | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.success !== false) return undefined;

    const envelope = parsed as unknown as CliJsonErrorEnvelope;
    const error = isRecord(envelope.error) ? envelope.error : undefined;
    const details = isRecord(error?.details) ? error.details : undefined;
    const command = toStringOrUndefined(details?.command);
    const context = toNullableString(error?.context);
    if (command !== "issue.create-batch" && context !== "Failed to create issue batch") {
      return undefined;
    }

    const createdIdentifiers = Array.isArray(details?.createdIdentifiers)
      ? details.createdIdentifiers.map((value) => toStringOrUndefined(value)).filter(Boolean) as string[]
      : [];

    return {
      message: toStringOrUndefined(error?.message) ?? "Failed to create issue batch",
      suggestion: toNullableString(error?.suggestion) ?? null,
      context,
      createdIdentifiers,
      createdCount: toNumberOrUndefined(details?.createdCount),
      failedStep: normalizeLinearBatchFailureStep(details?.failedStep),
      retryHint: toStringOrUndefined(details?.retryHint),
    };
  } catch {
    return undefined;
  }
}
