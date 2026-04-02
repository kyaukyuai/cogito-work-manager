import {
  execLinearJson,
  type LinearCommandEnv,
} from "./command-runner.js";
import type {
  EnsureLinearIssueCreatedWebhookInput,
  EnsureLinearIssueCreatedWebhookResult,
  LinearWebhook,
  LinearWebhookReconcilePlan,
} from "./types.js";

interface CliWebhookPayload {
  id?: string;
  label?: string;
  url?: string;
  enabled?: boolean;
  resourceTypes?: string[];
  resource_types?: string[];
  secretConfigured?: boolean;
  secret_configured?: boolean;
  teamKey?: string;
  teamId?: string;
  team?: {
    key?: string;
    id?: string;
  } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
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

export function normalizeLinearWebhookPayload(raw: unknown): LinearWebhook | undefined {
  if (!isRecord(raw)) return undefined;
  const id = toStringOrUndefined(raw.id);
  const label = toStringOrUndefined(raw.label);
  const url = toStringOrUndefined(raw.url);
  if (!id || !label || !url) return undefined;

  const resourceTypes = Array.isArray(raw.resourceTypes)
    ? raw.resourceTypes.map((value) => toStringOrUndefined(value)).filter(Boolean) as string[]
    : Array.isArray(raw.resource_types)
      ? raw.resource_types.map((value) => toStringOrUndefined(value)).filter(Boolean) as string[]
      : [];
  const team = isRecord(raw.team) ? raw.team : undefined;

  return {
    id,
    label,
    url,
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    resourceTypes,
    teamKey: toStringOrUndefined(raw.teamKey) ?? toStringOrUndefined(team?.key),
    teamId: toStringOrUndefined(raw.teamId) ?? toStringOrUndefined(team?.id),
    secretConfigured: typeof raw.secretConfigured === "boolean"
      ? raw.secretConfigured
      : typeof raw.secret_configured === "boolean"
        ? raw.secret_configured
        : undefined,
  };
}

export function buildListLinearWebhooksArgs(
  teamKey: string,
  env: LinearCommandEnv = process.env,
): string[] {
  ensureLinearAuthConfigured(env);
  return ["webhook", "list", ...workspaceArgs(env), "--team", teamKey, "--json"];
}

export function buildCreateLinearWebhookArgs(
  input: EnsureLinearIssueCreatedWebhookInput,
  env: LinearCommandEnv = process.env,
): string[] {
  ensureLinearAuthConfigured(env);
  return [
    "webhook",
    "create",
    ...workspaceArgs(env),
    "--url",
    input.url,
    "--resource-types",
    "Issue",
    "--label",
    input.label,
    "--team",
    input.teamKey,
    "--secret",
    input.secret,
    "--json",
  ];
}

export function buildUpdateLinearWebhookArgs(
  webhookId: string,
  input: EnsureLinearIssueCreatedWebhookInput,
  env: LinearCommandEnv = process.env,
): string[] {
  if (!webhookId.trim()) {
    throw new Error("Webhook ID is required");
  }
  ensureLinearAuthConfigured(env);
  return [
    "webhook",
    "update",
    ...workspaceArgs(env),
    webhookId.trim(),
    "--url",
    input.url,
    "--resource-types",
    "Issue",
    "--label",
    input.label,
    "--team",
    input.teamKey,
    "--secret",
    input.secret,
    "--json",
  ];
}

export function buildDeleteLinearWebhookArgs(
  webhookId: string,
  env: LinearCommandEnv = process.env,
): string[] {
  if (!webhookId.trim()) {
    throw new Error("Webhook ID is required");
  }
  ensureLinearAuthConfigured(env);
  return ["webhook", "delete", ...workspaceArgs(env), webhookId.trim(), "--json"];
}

export async function listLinearWebhooks(
  teamKey: string,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearWebhook[]> {
  ensureLinearAuthConfigured(env);
  const payload = await execLinearJson<CliWebhookPayload[]>(buildListLinearWebhooksArgs(teamKey, env), env, signal);
  return payload.map((entry) => normalizeLinearWebhookPayload(entry)).filter(Boolean) as LinearWebhook[];
}

export async function createLinearWebhook(
  input: EnsureLinearIssueCreatedWebhookInput,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearWebhook> {
  const payload = await execLinearJson<CliWebhookPayload>(buildCreateLinearWebhookArgs(input, env), env, signal);
  const webhook = normalizeLinearWebhookPayload(payload);
  if (!webhook) {
    throw new Error("Linear webhook creation returned no webhook");
  }
  return webhook;
}

export async function updateLinearWebhook(
  webhookId: string,
  input: EnsureLinearIssueCreatedWebhookInput,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearWebhook> {
  const payload = await execLinearJson<CliWebhookPayload>(buildUpdateLinearWebhookArgs(webhookId, input, env), env, signal);
  const webhook = normalizeLinearWebhookPayload(payload);
  if (!webhook) {
    throw new Error("Linear webhook update returned no webhook");
  }
  return webhook;
}

export async function deleteLinearWebhook(
  webhookId: string,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<void> {
  await execLinearJson(buildDeleteLinearWebhookArgs(webhookId, env), env, signal);
}

function shouldUpdateLinearWebhook(
  existing: LinearWebhook,
  desired: EnsureLinearIssueCreatedWebhookInput,
): boolean {
  const resourceTypes = [...existing.resourceTypes].sort();
  return existing.url !== desired.url
    || existing.label !== desired.label
    || existing.enabled !== true
    || resourceTypes.length !== 1
    || resourceTypes[0] !== "Issue"
    || (existing.teamKey !== undefined && existing.teamKey !== desired.teamKey)
    || existing.secretConfigured === false;
}

export function planLinearIssueCreatedWebhookReconcile(
  existing: LinearWebhook[],
  input: EnsureLinearIssueCreatedWebhookInput,
): LinearWebhookReconcilePlan {
  const matching = existing.filter((webhook) => webhook.label === input.label);

  if (matching.length > 1) {
    return {
      action: "disabled-duplicate",
      duplicateWebhooks: matching,
    };
  }

  if (matching.length === 0) {
    return { action: "create" };
  }

  const current = matching[0]!;
  if (!shouldUpdateLinearWebhook(current, input)) {
    return {
      action: "unchanged",
      webhook: current,
    };
  }

  return {
    action: "update",
    webhook: current,
  };
}

export async function ensureLinearIssueCreatedWebhook(
  input: EnsureLinearIssueCreatedWebhookInput,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<EnsureLinearIssueCreatedWebhookResult> {
  const existing = await listLinearWebhooks(input.teamKey, env, signal);
  const plan = planLinearIssueCreatedWebhookReconcile(existing, input);

  if (plan.action === "disabled-duplicate") {
    return {
      status: "disabled-duplicate",
      duplicateWebhooks: plan.duplicateWebhooks,
    };
  }
  if (plan.action === "create") {
    return {
      status: "created",
      webhook: await createLinearWebhook(input, env, signal),
    };
  }
  if (plan.action === "unchanged") {
    return {
      status: "unchanged",
      webhook: plan.webhook,
    };
  }

  return {
    status: "updated",
    webhook: await updateLinearWebhook(plan.webhook!.id, input, env, signal),
  };
}
