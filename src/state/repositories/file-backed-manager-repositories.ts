import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { SystemPaths } from "../../lib/system-workspace.js";
import {
  DEFAULT_OWNER_MAP,
  DEFAULT_POLICY,
  followupsLedgerSchema,
  managerPolicySchema,
  notionManagedPagesSchema,
  ownerMapSchema,
  planningLedgerSchema,
  personalizationLedgerSchema,
  webhookDeliveriesSchema,
  type FollowupLedgerEntry,
  type ManagerPolicy,
  type NotionManagedPageEntry,
  type OwnerMap,
  type PersonalizationLedgerEntry,
  type PlanningLedgerEntry,
  type WebhookDeliveryEntry,
} from "../manager-state-contract.js";
import {
  buildLastKnownGoodJsonPath,
  emitJsonStateRecoveryWarning,
  type JsonFileRecoveryDetails,
  loadJsonFile,
  readValidatedJsonFile,
  type RecoveredJsonValue,
  writeJsonFileAtomic,
} from "../json-file-store.js";
import { createFileBackedWorkgraphRepository, type WorkgraphRepository } from "../workgraph/file-backed-workgraph-repository.js";

export interface ReadonlyRepository<T> {
  load(): Promise<T>;
}

export interface MutableRepository<T> extends ReadonlyRepository<T> {
  save(value: T): Promise<void>;
}

export type PolicyRepository = MutableRepository<ManagerPolicy>;
export type OwnerMapRepository = MutableRepository<OwnerMap>;
export type FollowupRepository = MutableRepository<FollowupLedgerEntry[]>;
export type PlanningRepository = MutableRepository<PlanningLedgerEntry[]>;
export type WebhookDeliveryRepository = MutableRepository<WebhookDeliveryEntry[]>;
export type PersonalizationRepository = MutableRepository<PersonalizationLedgerEntry[]>;
export type NotionManagedPagesRepository = MutableRepository<NotionManagedPageEntry[]>;

export type RecoverableManagerStateRepositoryKey = "policy" | "followups" | "webhookDeliveries";

export interface ManagerStateRecoveryEvent extends JsonFileRecoveryDetails {
  repositoryKey: RecoverableManagerStateRepositoryKey;
}

export interface ManagerRepositories {
  policy: PolicyRepository;
  ownerMap: OwnerMapRepository;
  followups: FollowupRepository;
  planning: PlanningRepository;
  personalization: PersonalizationRepository;
  notionPages: NotionManagedPagesRepository;
  webhookDeliveries: WebhookDeliveryRepository;
  workgraph: WorkgraphRepository;
}

export interface CreateFileBackedManagerRepositoriesOptions {
  onStateRecovery?: (event: ManagerStateRecoveryEvent) => void | Promise<void>;
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeJsonFileAtomic(path, value);
}

async function persistLastKnownGoodJson(path: string, value: unknown): Promise<void> {
  await writeJsonFileAtomic(buildLastKnownGoodJsonPath(path), value);
}

async function findLatestValidBackup<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
): Promise<{ path: string; value: z.output<S> } | undefined> {
  const prefix = `${basename(path)}.bak-`;
  let entries: string[];
  try {
    entries = await readdir(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const candidates: Array<{ path: string; value: z.output<S>; mtimeMs: number }> = [];
  for (const entry of entries.filter((candidate) => candidate.startsWith(prefix))) {
    const fullPath = join(dirname(path), entry);
    const value = await readValidatedJsonFile(fullPath, schema);
    if (!value) {
      continue;
    }
    const metadata = await stat(fullPath);
    candidates.push({
      path: fullPath,
      value,
      mtimeMs: metadata.mtimeMs,
    });
  }

  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
}

async function recoverPolicyValue(
  path: string,
): Promise<RecoveredJsonValue<ManagerPolicy> | undefined> {
  const lastKnownGoodPath = buildLastKnownGoodJsonPath(path);
  const lastKnownGood = await readValidatedJsonFile(lastKnownGoodPath, managerPolicySchema);
  if (lastKnownGood) {
    return {
      value: lastKnownGood,
      restoredFrom: "last-known-good",
      restoredPath: lastKnownGoodPath,
    };
  }

  const backup = await findLatestValidBackup(path, managerPolicySchema);
  if (backup) {
    return {
      value: backup.value,
      restoredFrom: "backup",
      restoredPath: backup.path,
    };
  }

  return {
    value: DEFAULT_POLICY,
    restoredFrom: "default",
  };
}

function createRecoveryHandler(
  repositoryKey: RecoverableManagerStateRepositoryKey,
  options?: CreateFileBackedManagerRepositoriesOptions,
): (details: JsonFileRecoveryDetails) => void | Promise<void> {
  return async (details) => {
    emitJsonStateRecoveryWarning(details);
    await options?.onStateRecovery?.({
      repositoryKey,
      ...details,
    });
  };
}

function createReadonlyJsonRepository<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  defaultValue: z.output<S>,
  options?: {
    recoverOnInvalid?: boolean;
    onRecoverInvalid?: (details: JsonFileRecoveryDetails) => void | Promise<void>;
    onValidValue?: (value: z.output<S>) => void | Promise<void>;
    recoverValue?: (args: {
      path: string;
      schema: S;
      defaultValue: z.output<S>;
      raw: string;
      parseError: SyntaxError | z.ZodError;
      parsedValue?: unknown;
    }) => Promise<RecoveredJsonValue<z.output<S>> | undefined>;
  },
): ReadonlyRepository<z.output<S>> {
  return {
    async load(): Promise<z.output<S>> {
      return loadJsonFile({
        path,
        schema,
        defaultValue,
        recoverOnInvalid: options?.recoverOnInvalid ?? false,
        onRecoverInvalid: options?.onRecoverInvalid,
        onValidValue: options?.onValidValue,
        recoverValue: options?.recoverValue,
      });
    },
  };
}

function createMutableJsonRepository<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  defaultValue: z.output<S>,
  options?: {
    recoverOnInvalid?: boolean;
    onRecoverInvalid?: (details: JsonFileRecoveryDetails) => void | Promise<void>;
    onValidValue?: (value: z.output<S>) => void | Promise<void>;
    recoverValue?: (args: {
      path: string;
      schema: S;
      defaultValue: z.output<S>;
      raw: string;
      parseError: SyntaxError | z.ZodError;
      parsedValue?: unknown;
    }) => Promise<RecoveredJsonValue<z.output<S>> | undefined>;
  },
): MutableRepository<z.output<S>> {
  const readonlyRepository = createReadonlyJsonRepository(path, schema, defaultValue, options);
  return {
    load: readonlyRepository.load,
    async save(value: z.output<S>): Promise<void> {
      await writeJsonFile(path, value);
      await options?.onValidValue?.(value);
    },
  };
}

export function createFileBackedManagerRepositories(
  paths: SystemPaths,
  options?: CreateFileBackedManagerRepositoriesOptions,
): ManagerRepositories {
  return {
    policy: createMutableJsonRepository(paths.policyFile, managerPolicySchema, DEFAULT_POLICY, {
      recoverOnInvalid: true,
      onRecoverInvalid: createRecoveryHandler("policy", options),
      onValidValue: async (value) => persistLastKnownGoodJson(paths.policyFile, value),
      recoverValue: async () => recoverPolicyValue(paths.policyFile),
    }),
    ownerMap: createMutableJsonRepository(paths.ownerMapFile, ownerMapSchema, DEFAULT_OWNER_MAP),
    followups: createMutableJsonRepository(paths.followupsFile, followupsLedgerSchema, [], {
      recoverOnInvalid: true,
      onRecoverInvalid: createRecoveryHandler("followups", options),
    }),
    planning: createMutableJsonRepository(paths.planningLedgerFile, planningLedgerSchema, []),
    personalization: createMutableJsonRepository(paths.personalizationLedgerFile, personalizationLedgerSchema, []),
    notionPages: createMutableJsonRepository(paths.notionPagesFile, notionManagedPagesSchema, []),
    webhookDeliveries: createMutableJsonRepository(paths.webhookDeliveriesFile, webhookDeliveriesSchema, [], {
      recoverOnInvalid: true,
      onRecoverInvalid: createRecoveryHandler("webhookDeliveries", options),
    }),
    workgraph: createFileBackedWorkgraphRepository(paths),
  };
}
