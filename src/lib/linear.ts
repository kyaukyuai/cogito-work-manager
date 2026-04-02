import {
  compareLinearCliVersions,
  extractLinearCliVersion,
  parseLinearCliCapabilitiesPayload,
  REQUIRED_LINEAR_CLI_VERSION,
  validateLinearCliCapabilities,
} from "../gateways/linear/capabilities.js";
import {
  execLinear,
  LINEAR_CLI_WRITE_TIMEOUT_MS,
  LINEAR_COMMAND_TIMEOUT_MS,
  LinearCommandError,
  LinearCommandTimeoutError,
  type LinearCommandEnv,
} from "../gateways/linear/command-runner.js";

export {
  buildCreateProjectArgs,
  buildGetProjectArgs,
  buildListProjectsArgs,
  buildUpdateProjectArgs,
  createManagedLinearProject,
  getLinearProject,
  listLinearProjects,
  normalizeLinearProjectPayload,
  updateManagedLinearProject,
} from "../gateways/linear/projects.js";

export {
  addLinearComment,
  addLinearProgressComment,
  addLinearRelation,
  assignLinearIssue,
  buildCreateBatchArgs,
  buildCreateIssueArgs,
  buildGetIssueArgs,
  buildIssueChildrenArgs,
  buildIssueCommentAddArgs,
  buildIssueParentArgs,
  buildIssueRelationAddArgs,
  buildIssueRelationListArgs,
  buildIssueUrlArgs,
  buildListActiveIssuesArgs,
  buildSearchIssuesArgs,
  buildTeamMembersArgs,
  buildUpdateIssueArgs,
  createLinearIssue,
  createManagedLinearIssue,
  createManagedLinearIssueBatch,
  getLinearIssue,
  getLinearIssueChildren,
  getLinearIssueParent,
  listActiveLinearIssues,
  listLinearTeamMembers,
  listOpenLinearIssues,
  listRiskyLinearIssues,
  markLinearIssueBlocked,
  normalizeLinearIssuePayload,
  normalizeRelationListPayload,
  normalizeTeamMembersPayload,
  parseLinearBatchCreateFailure,
  searchLinearIssues,
  updateLinearIssue,
  updateLinearIssueState,
  updateLinearIssueStateWithComment,
  updateManagedLinearIssue,
} from "../gateways/linear/issues.js";

export {
  buildCreateLinearWebhookArgs,
  buildDeleteLinearWebhookArgs,
  buildListLinearWebhooksArgs,
  buildUpdateLinearWebhookArgs,
  createLinearWebhook,
  deleteLinearWebhook,
  ensureLinearIssueCreatedWebhook,
  listLinearWebhooks,
  normalizeLinearWebhookPayload,
  planLinearIssueCreatedWebhookReconcile,
  updateLinearWebhook,
} from "../gateways/linear/webhooks.js";

export {
  LINEAR_CLI_WRITE_TIMEOUT_MS,
  LINEAR_COMMAND_TIMEOUT_MS,
  LinearCommandError,
  LinearCommandTimeoutError,
};
export type { LinearCommandEnv };

export interface CreateIssueInput {
  title: string;
  description: string;
  state?: string;
  dueDate?: string;
}

export interface LinearIssueResult {
  issueId?: string;
  title?: string;
  url?: string;
  output: string;
}

export interface LinearListResult {
  output: string;
}

export interface ListProjectsInput {
  query?: string;
  status?: string;
  team?: string;
  allTeams?: boolean;
  limit?: number;
}

export interface UpdateIssueInput {
  issueId: string;
  state?: string;
  dueDate?: string;
  clearDueDate?: boolean;
}

export interface LinearUser {
  id: string;
  name?: string | null;
  displayName?: string | null;
  email?: string | null;
}

export interface LinearLabel {
  id?: string | null;
  name?: string | null;
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type?: string | null;
}

export interface LinearCycle {
  id?: string;
  number?: number;
  name?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
}

export interface LinearProjectUser {
  id?: string | null;
  name?: string | null;
  displayName?: string | null;
  email?: string | null;
}

export interface LinearProjectStatus {
  id?: string | null;
  name: string;
  type?: string | null;
  color?: string | null;
}

export interface LinearProjectTeam {
  id?: string | null;
  key?: string | null;
  name?: string | null;
}

export interface LinearProjectIssueSummary {
  total?: number;
  completed?: number;
  started?: number;
  unstarted?: number;
  backlog?: number;
  triage?: number;
  canceled?: number;
}

export interface LinearIssueProject {
  id?: string | null;
  name?: string | null;
  slugId?: string | null;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  url?: string | null;
  description?: string | null;
  createdAt?: string | null;
  completedAt?: string | null;
  dueDate?: string | null;
  priority?: number | null;
  priorityLabel?: string | null;
  cycle?: LinearCycle | null;
  updatedAt?: string | null;
  creator?: LinearUser | null;
  assignee?: LinearUser | null;
  labels?: LinearLabel[];
  state?: LinearWorkflowState | null;
  project?: LinearIssueProject | null;
  parent?: Pick<LinearIssue, "id" | "identifier" | "title" | "url"> | null;
  children?: Array<Pick<LinearIssue, "id" | "identifier" | "title" | "url">>;
  relations?: Array<{
    id?: string | null;
    type?: string | null;
    relatedIssue?: Pick<LinearIssue, "identifier" | "title" | "url"> | null;
  }>;
  inverseRelations?: Array<{
    id?: string | null;
    type?: string | null;
    issue?: Pick<LinearIssue, "identifier" | "title" | "url"> | null;
  }>;
  comments?: Array<{
    id: string;
    body: string;
    createdAt?: string | null;
    user?: Pick<LinearUser, "name" | "displayName"> | null;
  }>;
  latestActionKind?: "progress" | "blocked" | "slack-source" | "other";
  latestActionAt?: string | null;
}

export interface LinearProject {
  id: string;
  slugId?: string | null;
  name: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  url?: string | null;
  status?: LinearProjectStatus | null;
  creator?: LinearProjectUser | null;
  lead?: LinearProjectUser | null;
  priority?: number | null;
  health?: string | null;
  startDate?: string | null;
  targetDate?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  canceledAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  teams?: LinearProjectTeam[];
  issueSummary?: LinearProjectIssueSummary | null;
  lastUpdate?: {
    body?: string | null;
    createdAt?: string | null;
  } | null;
}

export interface SearchIssuesInput {
  query: string;
  states?: string[];
  limit?: number;
  parent?: string;
  priority?: number | string;
  updatedBefore?: string;
  dueBefore?: string;
  allStates?: boolean;
  allAssignees?: boolean;
}

export interface ManagedCreateIssueInput extends CreateIssueInput {
  assignee?: string;
  parent?: string;
  priority?: number;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  teamKeys?: string[];
  lead?: string;
  status?: string;
  startDate?: string;
  targetDate?: string;
}

export interface UpdateProjectInput {
  projectId: string;
  name?: string;
  description?: string;
  teamKeys?: string[];
  lead?: string;
  status?: string;
  startDate?: string;
  targetDate?: string;
}

export interface ManagedUpdateIssueInput extends UpdateIssueInput {
  title?: string;
  description?: string;
  assignee?: string;
  priority?: number;
  parent?: string | null;
  comment?: string;
}

export interface ManagedCreateIssueBatchInput {
  parent: ManagedCreateIssueInput;
  children: ManagedCreateIssueInput[];
}

export interface ManagedCreateIssueBatchResult {
  parent: LinearIssue;
  children: LinearIssue[];
}

export interface LinearBatchCreateFailureStep {
  stage?: string;
  index?: number;
  total?: number;
  title?: string;
}

export interface LinearBatchCreateFailureDetails {
  message: string;
  suggestion?: string | null;
  context?: string | null;
  createdIdentifiers: string[];
  createdCount?: number;
  failedStep?: LinearBatchCreateFailureStep;
  retryHint?: string;
}

export interface LinearWebhook {
  id: string;
  label: string;
  url: string;
  enabled: boolean;
  resourceTypes: string[];
  teamKey?: string;
  teamId?: string;
  secretConfigured?: boolean;
}

export interface EnsureLinearIssueCreatedWebhookInput {
  label: string;
  url: string;
  teamKey: string;
  secret: string;
}

export interface EnsureLinearIssueCreatedWebhookResult {
  status: "created" | "updated" | "unchanged" | "disabled-duplicate";
  webhook?: LinearWebhook;
  duplicateWebhooks?: LinearWebhook[];
}

export interface LinearWebhookReconcilePlan {
  action: "create" | "update" | "unchanged" | "disabled-duplicate";
  webhook?: LinearWebhook;
  duplicateWebhooks?: LinearWebhook[];
}

export interface RiskPolicy {
  staleBusinessDays: number;
  urgentPriorityThreshold: number;
}

export interface RiskyLinearIssue extends LinearIssue {
  riskCategories: string[];
  ownerMissing: boolean;
  dueMissing: boolean;
  blocked: boolean;
}

export interface LinearBlockedUpdateResult {
  issue: LinearIssue;
  commentId?: string;
  blockedStateApplied: boolean;
}

export interface GetLinearIssueOptions {
  includeComments?: boolean;
}

export async function verifyLinearCli(teamKey: string): Promise<void> {
  const versionResult = await execLinear(["--version"], process.env);
  const version = versionResult.stdout || versionResult.stderr;
  const normalizedVersion = extractLinearCliVersion(version) ?? version;
  if (compareLinearCliVersions(normalizedVersion, REQUIRED_LINEAR_CLI_VERSION) < 0) {
    throw new Error(`linear-cli v${REQUIRED_LINEAR_CLI_VERSION} or newer is required. Current version: ${version || "unknown"}`);
  }

  const whoami = await execLinear(["auth", "whoami"], process.env);
  if (!(whoami.stdout || whoami.stderr).trim()) {
    throw new Error("linear auth whoami returned empty output");
  }

  const capabilities = await execLinear(["capabilities", "--json"], process.env);
  const parsedCapabilities = parseLinearCliCapabilitiesPayload(capabilities.stdout || capabilities.stderr);
  if (!parsedCapabilities) {
    throw new Error("linear capabilities --json returned an invalid payload");
  }

  const capabilityErrors = validateLinearCliCapabilities(parsedCapabilities);
  if (capabilityErrors.length > 0) {
    throw new Error(`linear capabilities --json is missing required runtime surface: ${capabilityErrors.join(" | ")}`);
  }

  const teamList = await execLinear(["team", "list"], process.env);
  const lines = teamList.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const hasTeam = lines.some((line) => line.startsWith(`${teamKey} `) || line === teamKey);
  if (!hasTeam) {
    throw new Error(`LINEAR_TEAM_KEY "${teamKey}" was not found in linear team list output`);
  }
}
