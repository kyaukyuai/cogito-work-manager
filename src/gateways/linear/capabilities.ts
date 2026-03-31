export const REQUIRED_LINEAR_CLI_VERSION = "2.12.3";
export const REQUIRED_LINEAR_AUTOMATION_CONTRACT_VERSION = "v4";

type CapabilityContractVersion = `v${number}`;

interface CapabilityJsonSupport {
  supported: boolean;
  contractVersion: string | null;
}

interface CapabilityDryRunSupport {
  supported: boolean;
  contractVersion: string | null;
}

export interface LinearCliCapabilityCommand {
  path: string;
  json: CapabilityJsonSupport;
  dryRun: CapabilityDryRunSupport;
}

export interface LinearCliCapabilitiesPayload {
  schemaVersion: string;
  cli: {
    version: string;
  };
  contractVersions: {
    automation: {
      latest: string;
    };
  };
  commands: LinearCliCapabilityCommand[];
}

interface RequiredCapability {
  path: string;
  minJsonContractVersion?: CapabilityContractVersion;
}

const REQUIRED_RUNTIME_CAPABILITIES: RequiredCapability[] = [
  { path: "linear capabilities" },
  { path: "linear issue list", minJsonContractVersion: "v1" },
  { path: "linear issue view", minJsonContractVersion: "v1" },
  { path: "linear issue create", minJsonContractVersion: "v1" },
  { path: "linear issue update", minJsonContractVersion: "v1" },
  { path: "linear issue comment add", minJsonContractVersion: "v1" },
  { path: "linear issue relation add", minJsonContractVersion: "v1" },
  { path: "linear issue relation list", minJsonContractVersion: "v1" },
  { path: "linear issue parent", minJsonContractVersion: "v1" },
  { path: "linear issue children", minJsonContractVersion: "v1" },
  { path: "linear issue create-batch", minJsonContractVersion: "v1" },
  { path: "linear team members", minJsonContractVersion: "v1" },
  { path: "linear webhook list" },
  { path: "linear webhook create" },
  { path: "linear webhook update" },
];

const OPTIONAL_V4_READ_SURFACE = [
  "linear label list",
  "linear user list",
  "linear workflow-state list",
] as const;

const SUPPORTED_CAPABILITIES_SCHEMA_VERSIONS = new Set(["v1", "v2"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function toBoolean(value: unknown): boolean {
  return value === true;
}

function normalizeCapabilityCommand(raw: unknown): LinearCliCapabilityCommand | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const path = toStringOrUndefined(raw.path);
  const json = isRecord(raw.json) ? raw.json : undefined;
  const dryRun = isRecord(raw.dryRun) ? raw.dryRun : undefined;
  if (!path || !json || !dryRun) {
    return undefined;
  }

  return {
    path,
    json: {
      supported: toBoolean(json.supported),
      contractVersion: toStringOrUndefined(json.contractVersion) ?? null,
    },
    dryRun: {
      supported: toBoolean(dryRun.supported),
      contractVersion: toStringOrUndefined(dryRun.contractVersion) ?? null,
    },
  };
}

function parseContractVersion(version: string | null | undefined): number | undefined {
  const match = version?.match(/^v(\d+)$/i);
  if (!match) {
    return undefined;
  }
  return Number(match[1]);
}

export function extractLinearCliVersion(raw: string): string | undefined {
  const match = raw.match(/(\d+\.\d+\.\d+)/);
  return match?.[1];
}

export function compareLinearCliVersions(left: string, right: string): number {
  const normalize = (value: string): number[] => {
    const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) return [0, 0, 0];
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };

  const leftParts = normalize(left);
  const rightParts = normalize(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

export function parseLinearCliCapabilitiesPayload(raw: string): LinearCliCapabilitiesPayload | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }

    const schemaVersion = toStringOrUndefined(parsed.schemaVersion);
    const cli = isRecord(parsed.cli) ? parsed.cli : undefined;
    const contractVersions = isRecord(parsed.contractVersions) ? parsed.contractVersions : undefined;
    const automation = contractVersions && isRecord(contractVersions.automation)
      ? contractVersions.automation
      : undefined;
    const commands = Array.isArray(parsed.commands)
      ? parsed.commands.map((command) => normalizeCapabilityCommand(command)).filter(Boolean) as LinearCliCapabilityCommand[]
      : [];

    const version = toStringOrUndefined(cli?.version);
    const automationLatest = toStringOrUndefined(automation?.latest);

    if (!schemaVersion || !version || !automationLatest || commands.length === 0) {
      return undefined;
    }

    return {
      schemaVersion,
      cli: { version },
      contractVersions: {
        automation: {
          latest: automationLatest,
        },
      },
      commands,
    };
  } catch {
    return undefined;
  }
}

export function validateLinearCliCapabilities(payload: LinearCliCapabilitiesPayload): string[] {
  const errors: string[] = [];

  if (!SUPPORTED_CAPABILITIES_SCHEMA_VERSIONS.has(payload.schemaVersion)) {
    errors.push(`schemaVersion=${payload.schemaVersion}`);
  }

  const automationLatest = parseContractVersion(payload.contractVersions.automation.latest);
  const requiredAutomationLatest = parseContractVersion(REQUIRED_LINEAR_AUTOMATION_CONTRACT_VERSION);
  if (
    automationLatest == null
    || requiredAutomationLatest == null
    || automationLatest < requiredAutomationLatest
  ) {
    errors.push(`automation.latest=${payload.contractVersions.automation.latest}`);
  }

  const commandsByPath = new Map(payload.commands.map((command) => [command.path, command]));
  for (const requirement of REQUIRED_RUNTIME_CAPABILITIES) {
    const command = commandsByPath.get(requirement.path);
    if (!command) {
      errors.push(`missing ${requirement.path}`);
      continue;
    }
    if (!command.json.supported) {
      errors.push(`${requirement.path} missing --json support`);
      continue;
    }
    if (requirement.minJsonContractVersion) {
      const actual = parseContractVersion(command.json.contractVersion);
      const required = parseContractVersion(requirement.minJsonContractVersion);
      if (actual == null || required == null || actual < required) {
        errors.push(`${requirement.path} json contract=${command.json.contractVersion ?? "none"}`);
      }
    }
  }

  return errors;
}

export function collectOptionalV4ReadSurface(payload: LinearCliCapabilitiesPayload): string[] {
  const commandsByPath = new Map(payload.commands.map((command) => [command.path, command]));
  return OPTIONAL_V4_READ_SURFACE.filter((path) => {
    const command = commandsByPath.get(path);
    const contract = parseContractVersion(command?.json.contractVersion);
    return command?.json.supported === true && contract != null && contract >= 4;
  });
}
