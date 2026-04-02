import {
  execLinear,
  execLinearJson,
  type LinearCommandEnv,
} from "./command-runner.js";
import type {
  CreateProjectInput,
  LinearProject,
  LinearProjectIssueSummary,
  LinearProjectStatus,
  LinearProjectTeam,
  LinearProjectUser,
  ListProjectsInput,
  UpdateProjectInput,
} from "../../lib/linear.js";

interface CliProjectStatus {
  id?: string | null;
  name?: string | null;
  color?: string | null;
  type?: string | null;
}

interface CliProjectUser {
  id?: string | null;
  name?: string | null;
  displayName?: string | null;
  email?: string | null;
}

interface CliProjectTeam {
  id?: string | null;
  key?: string | null;
  name?: string | null;
}

interface CliProjectIssueSummary {
  total?: number | null;
  completed?: number | null;
  started?: number | null;
  unstarted?: number | null;
  backlog?: number | null;
  triage?: number | null;
  canceled?: number | null;
}

interface CliProjectPayload {
  id?: string | null;
  slugId?: string | null;
  name?: string | null;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  url?: string | null;
  status?: CliProjectStatus | null;
  creator?: CliProjectUser | null;
  lead?: CliProjectUser | null;
  priority?: number | null;
  health?: string | null;
  startDate?: string | null;
  targetDate?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  canceledAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  teams?: Array<CliProjectTeam | string> | null;
  issueSummary?: CliProjectIssueSummary | null;
  lastUpdate?: {
    body?: string | null;
    createdAt?: string | null;
  } | null;
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

function normalizeLinearProjectUser(raw: unknown): LinearProjectUser | undefined {
  if (!isRecord(raw)) return undefined;
  const id = toNullableString(raw.id);
  const name = toNullableString(raw.name);
  const displayName = toNullableString(raw.displayName);
  const email = toNullableString(raw.email);
  if (!id && !name && !displayName && !email) {
    return undefined;
  }
  return { id, name, displayName, email };
}

function normalizeLinearProjectStatus(raw: unknown): LinearProjectStatus | undefined {
  if (!isRecord(raw)) return undefined;
  const name = toStringOrUndefined(raw.name);
  if (!name) return undefined;
  return {
    id: toNullableString(raw.id),
    name,
    type: toNullableString(raw.type),
    color: toNullableString(raw.color),
  };
}

function normalizeLinearProjectTeam(raw: unknown): LinearProjectTeam | undefined {
  if (typeof raw === "string" && raw.trim()) {
    return { key: raw.trim() };
  }
  if (!isRecord(raw)) return undefined;
  const id = toNullableString(raw.id);
  const key = toNullableString(raw.key);
  const name = toNullableString(raw.name);
  if (!id && !key && !name) {
    return undefined;
  }
  return { id, key, name };
}

function normalizeLinearProjectIssueSummary(raw: unknown): LinearProjectIssueSummary | undefined {
  if (!isRecord(raw)) return undefined;
  const summary: LinearProjectIssueSummary = {
    total: toNumberOrUndefined(raw.total),
    completed: toNumberOrUndefined(raw.completed),
    started: toNumberOrUndefined(raw.started),
    unstarted: toNumberOrUndefined(raw.unstarted),
    backlog: toNumberOrUndefined(raw.backlog),
    triage: toNumberOrUndefined(raw.triage),
    canceled: toNumberOrUndefined(raw.canceled),
  };
  return Object.values(summary).some((value) => value != null) ? summary : undefined;
}

function resolveProjectTeamKeys(
  teamKeys: string[] | undefined,
  env: LinearCommandEnv,
): string[] {
  const normalized = (teamKeys ?? [])
    .map((teamKey) => teamKey.trim())
    .filter(Boolean);
  if (normalized.length > 0) {
    return Array.from(new Set(normalized));
  }
  return [requireEnv(env, "LINEAR_TEAM_KEY")];
}

function matchesProjectQuery(project: LinearProject, query: string | undefined): boolean {
  const normalized = query?.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  const haystack = [
    project.id,
    project.slugId,
    project.name,
    project.description,
    project.status?.name,
    project.lead?.name,
    project.lead?.displayName,
    ...(project.teams ?? []).flatMap((team) => [team.key, team.name, team.id]),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return haystack.includes(normalized);
}

export function normalizeLinearProjectPayload(raw: unknown): LinearProject | undefined {
  if (!isRecord(raw)) return undefined;

  const id = toStringOrUndefined(raw.id);
  const name = toStringOrUndefined(raw.name);
  if (!id || !name) return undefined;

  return {
    id,
    slugId: toNullableString(raw.slugId),
    name,
    description: toNullableString(raw.description),
    icon: toNullableString(raw.icon),
    color: toNullableString(raw.color),
    url: toNullableString(raw.url),
    status: normalizeLinearProjectStatus(raw.status) ?? null,
    creator: normalizeLinearProjectUser(raw.creator) ?? null,
    lead: normalizeLinearProjectUser(raw.lead) ?? null,
    priority: toNumberOrUndefined(raw.priority) ?? null,
    health: toNullableString(raw.health) ?? null,
    startDate: toNullableString(raw.startDate),
    targetDate: toNullableString(raw.targetDate),
    startedAt: toNullableString(raw.startedAt),
    completedAt: toNullableString(raw.completedAt),
    canceledAt: toNullableString(raw.canceledAt),
    createdAt: toNullableString(raw.createdAt),
    updatedAt: toNullableString(raw.updatedAt),
    teams: Array.isArray(raw.teams)
      ? raw.teams.map((team) => normalizeLinearProjectTeam(team)).filter(Boolean) as LinearProjectTeam[]
      : [],
    issueSummary: normalizeLinearProjectIssueSummary(raw.issueSummary) ?? null,
    lastUpdate: isRecord(raw.lastUpdate)
      ? {
          body: toNullableString(raw.lastUpdate.body) ?? null,
          createdAt: toNullableString(raw.lastUpdate.createdAt) ?? null,
        }
      : null,
  };
}

export function buildListProjectsArgs(
  input: ListProjectsInput = {},
  env: LinearCommandEnv = process.env,
): string[] {
  ensureLinearAuthConfigured(env);
  const args = ["project", "list", ...workspaceArgs(env), "--json", "--no-pager"];
  if (input.allTeams) {
    args.push("--all-teams");
  } else if (input.team?.trim()) {
    args.push("--team", input.team.trim());
  } else if (env.LINEAR_TEAM_KEY?.trim()) {
    args.push("--team", env.LINEAR_TEAM_KEY.trim());
  } else {
    args.push("--all-teams");
  }
  if (input.status?.trim()) {
    args.push("--status", input.status.trim());
  }
  return args;
}

export function buildGetProjectArgs(
  projectIdOrSlug: string,
  env: LinearCommandEnv = process.env,
): string[] {
  const trimmed = projectIdOrSlug.trim();
  if (!trimmed) throw new Error("Project ID or slug is required");
  return ["project", "view", ...workspaceArgs(env), trimmed, "--json"];
}

export function buildCreateProjectArgs(
  input: CreateProjectInput,
  env: LinearCommandEnv = process.env,
): string[] {
  ensureLinearAuthConfigured(env);
  const name = input.name.trim();
  if (!name) {
    throw new Error("Project name is required");
  }
  const args = ["project", "create", ...workspaceArgs(env), "--name", name, "--json"];
  if (input.description?.trim()) args.push("--description", input.description.trim());
  for (const teamKey of resolveProjectTeamKeys(input.teamKeys, env)) {
    args.push("--team", teamKey);
  }
  if (input.lead?.trim()) args.push("--lead", input.lead.trim());
  if (input.status?.trim()) args.push("--status", input.status.trim());
  if (input.startDate?.trim()) args.push("--start-date", input.startDate.trim());
  if (input.targetDate?.trim()) args.push("--target-date", input.targetDate.trim());
  return args;
}

export function buildUpdateProjectArgs(
  input: UpdateProjectInput,
  env: LinearCommandEnv = process.env,
): string[] {
  ensureLinearAuthConfigured(env);
  const projectId = input.projectId.trim();
  if (!projectId) {
    throw new Error("Project ID is required");
  }
  const args = ["project", "update", ...workspaceArgs(env), projectId];
  if (input.name?.trim()) args.push("--name", input.name.trim());
  if (input.description?.trim()) args.push("--description", input.description.trim());
  if (input.status?.trim()) args.push("--status", input.status.trim());
  if (input.lead?.trim()) args.push("--lead", input.lead.trim());
  if (input.startDate?.trim()) args.push("--start-date", input.startDate.trim());
  if (input.targetDate?.trim()) args.push("--target-date", input.targetDate.trim());
  for (const teamKey of (input.teamKeys ?? []).map((team) => team.trim()).filter(Boolean)) {
    args.push("--team", teamKey);
  }
  if (args.length === 3 + workspaceArgs(env).length) {
    throw new Error("At least one project update field is required");
  }
  return args;
}

export async function listLinearProjects(
  input: ListProjectsInput = {},
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearProject[]> {
  ensureLinearAuthConfigured(env);
  const payload = await execLinearJson<CliProjectPayload[]>(buildListProjectsArgs(input, env), env, signal);
  const projects = payload
    .map((project) => normalizeLinearProjectPayload(project))
    .filter((project): project is LinearProject => project != null)
    .filter((project) => matchesProjectQuery(project, input.query));
  const limit = Number.isFinite(input.limit) && input.limit != null && input.limit >= 0
    ? Math.trunc(input.limit)
    : undefined;
  return typeof limit === "number" ? projects.slice(0, limit) : projects;
}

export async function getLinearProject(
  projectIdOrSlug: string,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearProject> {
  const payload = await execLinearJson<CliProjectPayload>(buildGetProjectArgs(projectIdOrSlug, env), env, signal);
  const project = normalizeLinearProjectPayload(payload);
  if (!project) {
    throw new Error(`Project not found: ${projectIdOrSlug}`);
  }
  return project;
}

export async function createManagedLinearProject(
  input: CreateProjectInput,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearProject> {
  const payload = await execLinearJson<CliProjectPayload>(buildCreateProjectArgs(input, env), env, signal);
  const project = normalizeLinearProjectPayload(payload);
  if (!project) {
    throw new Error("Linear project creation returned no project");
  }
  return project;
}

export async function updateManagedLinearProject(
  input: UpdateProjectInput,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearProject> {
  await execLinear(buildUpdateProjectArgs(input, env), env, signal);
  return getLinearProject(input.projectId, env, signal);
}
