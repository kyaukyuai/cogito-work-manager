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
  emitJsonStateRecoveryWarning,
  type JsonFileRecoveryDetails,
  loadJsonFile,
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

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeJsonFileAtomic(path, value);
}

function createReadonlyJsonRepository<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  defaultValue: z.output<S>,
  options?: {
    recoverOnInvalid?: boolean;
    onRecoverInvalid?: (details: JsonFileRecoveryDetails) => void;
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
    onRecoverInvalid?: (details: JsonFileRecoveryDetails) => void;
  },
): MutableRepository<z.output<S>> {
  const readonlyRepository = createReadonlyJsonRepository(path, schema, defaultValue, options);
  return {
    load: readonlyRepository.load,
    async save(value: z.output<S>): Promise<void> {
      await writeJsonFile(path, value);
    },
  };
}

export function createFileBackedManagerRepositories(paths: SystemPaths): ManagerRepositories {
  return {
    policy: createMutableJsonRepository(paths.policyFile, managerPolicySchema, DEFAULT_POLICY),
    ownerMap: createMutableJsonRepository(paths.ownerMapFile, ownerMapSchema, DEFAULT_OWNER_MAP),
    followups: createMutableJsonRepository(paths.followupsFile, followupsLedgerSchema, []),
    planning: createMutableJsonRepository(paths.planningLedgerFile, planningLedgerSchema, []),
    personalization: createMutableJsonRepository(paths.personalizationLedgerFile, personalizationLedgerSchema, []),
    notionPages: createMutableJsonRepository(paths.notionPagesFile, notionManagedPagesSchema, []),
    webhookDeliveries: createMutableJsonRepository(paths.webhookDeliveriesFile, webhookDeliveriesSchema, [], {
      recoverOnInvalid: true,
      onRecoverInvalid: emitJsonStateRecoveryWarning,
    }),
    workgraph: createFileBackedWorkgraphRepository(paths),
  };
}
