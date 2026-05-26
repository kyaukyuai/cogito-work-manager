import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureManagerStateFiles,
  loadFollowupsLedger,
  loadPlanningLedger,
} from "../src/lib/manager-state.js";
import { buildSystemPaths } from "../src/lib/system-workspace.js";
import { DEFAULT_POLICY } from "../src/state/manager-state-contract.js";
import { createFileBackedManagerRepositories } from "../src/state/repositories/file-backed-manager-repositories.js";

describe("file-backed manager repositories", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads default values from missing files", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-repositories-defaults-"));
    const systemPaths = buildSystemPaths(workspaceDir);
    const repositories = createFileBackedManagerRepositories(systemPaths);

    await expect(repositories.policy.load()).resolves.toMatchObject({
      controlRoomChannelId: "C0ALAMDRB9V",
      fallbackOwner: "kyaukyuai",
    });
    await expect(repositories.ownerMap.load()).resolves.toMatchObject({
      defaultOwner: "kyaukyuai",
    });
    await expect(repositories.followups.load()).resolves.toEqual([]);
    await expect(repositories.planning.load()).resolves.toEqual([]);
    await expect(repositories.personalization.load()).resolves.toEqual([]);
    await expect(repositories.webhookDeliveries.load()).resolves.toEqual([]);
    await expect(repositories.workgraph.list()).resolves.toEqual([]);
  });

  it("persists manager state without changing file-backed reads", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-repositories-"));
    const systemPaths = buildSystemPaths(workspaceDir);
    const now = new Date("2026-03-18T00:00:00.000Z").toISOString();

    await ensureManagerStateFiles(systemPaths);

    const repositories = createFileBackedManagerRepositories(systemPaths);
    const policy = await repositories.policy.load();
    const ownerMap = await repositories.ownerMap.load();

    expect(policy.controlRoomChannelId).toBe("C0ALAMDRB9V");
    expect(ownerMap.defaultOwner).toBe("kyaukyuai");
    const followups = [
      {
        issueId: "AIC-2",
        status: "awaiting-response" as const,
        requestKind: "status" as const,
      },
    ];
    const planningLedger = [
      {
        sourceThread: "C123:1710000000.000100",
        generatedChildIssueIds: ["AIC-2"],
        planningReason: "llm-plan",
        createdAt: now,
        updatedAt: now,
      },
    ];

    await repositories.followups.save(followups);
    await repositories.planning.save(planningLedger);
    await repositories.policy.save({
      ...policy,
      heartbeatIntervalMin: 45,
    });
    await repositories.ownerMap.save({
      defaultOwner: "y.kakui",
      entries: [
        {
          id: "opt",
          domains: ["sales"],
          keywords: ["OPT"],
          linearAssignee: "t.tahira",
          primary: false,
        },
      ],
    });

    expect(await loadFollowupsLedger(systemPaths)).toEqual(followups);
    expect(await loadPlanningLedger(systemPaths)).toEqual(planningLedger);
    await expect(repositories.policy.load()).resolves.toMatchObject({
      heartbeatIntervalMin: 45,
    });
    await expect(repositories.ownerMap.load()).resolves.toEqual({
      defaultOwner: "y.kakui",
      entries: [
        {
          id: "opt",
          domains: ["sales"],
          keywords: ["OPT"],
          linearAssignee: "t.tahira",
          primary: false,
        },
      ],
    });
  });

  it("reloads saved values from a new repository instance", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-repositories-reload-"));
    const systemPaths = buildSystemPaths(workspaceDir);
    const now = new Date("2026-03-18T09:00:00.000Z").toISOString();

    const first = createFileBackedManagerRepositories(systemPaths);
    await first.followups.save([
      {
        issueId: "AIC-9",
        status: "resolved",
        resolvedAt: now,
        resolvedReason: "answered",
      },
    ]);

    const second = createFileBackedManagerRepositories(systemPaths);
    await expect(second.followups.load()).resolves.toEqual([
      {
        issueId: "AIC-9",
        status: "resolved",
        resolvedAt: now,
        resolvedReason: "answered",
      },
    ]);
  });

  it("still rejects schema-invalid planning data because that repository does not auto-recover", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-repositories-invalid-"));
    const systemPaths = buildSystemPaths(workspaceDir);
    const repositories = createFileBackedManagerRepositories(systemPaths);

    await mkdir(dirname(systemPaths.planningLedgerFile), { recursive: true });
    await writeFile(systemPaths.planningLedgerFile, "{\"sourceThread\":1}\n", "utf8");

    await expect(repositories.planning.load()).rejects.toThrow();
  });

  it("recovers a schema-invalid policy file by restoring defaults and emitting state recovery hooks", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-repositories-policy-invalid-schema-"));
    const systemPaths = buildSystemPaths(workspaceDir);
    const onStateRecovery = vi.fn();
    const repositories = createFileBackedManagerRepositories(systemPaths, { onStateRecovery });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const invalidSchema = "{\"controlRoomChannelId\":1}\n";

    await mkdir(dirname(systemPaths.policyFile), { recursive: true });
    await writeFile(systemPaths.policyFile, invalidSchema, "utf8");

    await expect(repositories.policy.load()).resolves.toMatchObject({
      controlRoomChannelId: "C0ALAMDRB9V",
      heartbeatEnabled: true,
    });
    await expect(readFile(systemPaths.policyFile, "utf8")).resolves.toContain("\"controlRoomChannelId\": \"C0ALAMDRB9V\"");

    const backups = await readdir(dirname(systemPaths.policyFile));
    const backupName = backups.find((entry) => entry.startsWith("policy.json.corrupt-"));
    expect(backupName).toBeDefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(onStateRecovery).toHaveBeenCalledWith(expect.objectContaining({
      repositoryKey: "policy",
      path: systemPaths.policyFile,
      backupPath: join(dirname(systemPaths.policyFile), backupName!),
      errorType: "schema",
      restoredFrom: "default",
    }));
  });

  it("recovers an invalid policy file from last-known-good instead of defaults", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-policy-last-known-good-"));
    const systemPaths = buildSystemPaths(workspaceDir);
    const onStateRecovery = vi.fn();
    const repositories = createFileBackedManagerRepositories(systemPaths, { onStateRecovery });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await repositories.policy.save({
      ...(await repositories.policy.load()),
      heartbeatEnabled: false,
      heartbeatIntervalMin: 120,
      reviewCadence: {
        morning: "09:15",
        morningEnabled: true,
        evening: "17:00",
        eveningEnabled: false,
        weeklyDay: "thu",
        weeklyTime: "10:30",
        weeklyEnabled: true,
      },
    });

    await writeFile(systemPaths.policyFile, "{\"controlRoomChannelId\":1}\n", "utf8");

    await expect(repositories.policy.load()).resolves.toMatchObject({
      controlRoomChannelId: "C0ALAMDRB9V",
      heartbeatEnabled: false,
      heartbeatIntervalMin: 120,
      reviewCadence: expect.objectContaining({
        morning: "09:15",
        eveningEnabled: false,
        weeklyDay: "thu",
      }),
    });

    const lastKnownGoodPath = `${systemPaths.policyFile}.last-known-good`;
    await expect(readFile(lastKnownGoodPath, "utf8")).resolves.toContain("\"heartbeatIntervalMin\": 120");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(onStateRecovery).toHaveBeenCalledWith(expect.objectContaining({
      repositoryKey: "policy",
      restoredFrom: "last-known-good",
      restoredPath: lastKnownGoodPath,
    }));
  });

  it("recovers an invalid policy file from the latest valid backup when last-known-good is unavailable", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-policy-backup-recovery-"));
    const systemPaths = buildSystemPaths(workspaceDir);
    const onStateRecovery = vi.fn();
    const repositories = createFileBackedManagerRepositories(systemPaths, { onStateRecovery });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await mkdir(dirname(systemPaths.policyFile), { recursive: true });
    await writeFile(
      `${systemPaths.policyFile}.bak-20260526T063259Z`,
      `${JSON.stringify({
        ...DEFAULT_POLICY,
        heartbeatEnabled: false,
        heartbeatIntervalMin: 240,
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(systemPaths.policyFile, "{\"controlRoomChannelId\":1}\n", "utf8");

    await expect(repositories.policy.load()).resolves.toMatchObject({
      heartbeatEnabled: false,
      heartbeatIntervalMin: 240,
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(onStateRecovery).toHaveBeenCalledWith(expect.objectContaining({
      repositoryKey: "policy",
      restoredFrom: "backup",
      restoredPath: `${systemPaths.policyFile}.bak-20260526T063259Z`,
    }));
  });

  it("recovers a corrupted webhook delivery ledger by backing it up and resetting the file", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-repositories-webhook-corrupt-"));
    const systemPaths = buildSystemPaths(workspaceDir);
    const repositories = createFileBackedManagerRepositories(systemPaths);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const corrupted = `[
  {
    "deliveryId": "broken-delivery"
  }
]
trailing-fragment`;

    await mkdir(dirname(systemPaths.webhookDeliveriesFile), { recursive: true });
    await writeFile(systemPaths.webhookDeliveriesFile, corrupted, "utf8");

    await expect(repositories.webhookDeliveries.load()).resolves.toEqual([]);
    await expect(readFile(systemPaths.webhookDeliveriesFile, "utf8")).resolves.toBe("[]\n");

    const backups = await readdir(dirname(systemPaths.webhookDeliveriesFile));
    const backupName = backups.find((entry) => entry.startsWith("webhook-deliveries.json.corrupt-"));
    expect(backupName).toBeDefined();
    await expect(readFile(join(dirname(systemPaths.webhookDeliveriesFile), backupName!), "utf8")).resolves.toBe(corrupted);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warnSpy.mock.calls[0]?.[0]))).toMatchObject({
      level: "warn",
      message: "Recovered invalid JSON state file",
      path: systemPaths.webhookDeliveriesFile,
      backupPath: join(dirname(systemPaths.webhookDeliveriesFile), backupName!),
      errorType: "syntax",
    });
  });

  it("recovers a corrupted followups ledger by backing it up and resetting the file", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-repositories-followups-corrupt-"));
    const systemPaths = buildSystemPaths(workspaceDir);
    const onStateRecovery = vi.fn();
    const repositories = createFileBackedManagerRepositories(systemPaths, { onStateRecovery });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const corrupted = `[
  {
    "issueId": "AIC-1"
  }
]
trailing-fragment`;

    await mkdir(dirname(systemPaths.followupsFile), { recursive: true });
    await writeFile(systemPaths.followupsFile, corrupted, "utf8");

    await expect(repositories.followups.load()).resolves.toEqual([]);
    await expect(readFile(systemPaths.followupsFile, "utf8")).resolves.toBe("[]\n");

    const backups = await readdir(dirname(systemPaths.followupsFile));
    const backupName = backups.find((entry) => entry.startsWith("followups.json.corrupt-"));
    expect(backupName).toBeDefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(onStateRecovery).toHaveBeenCalledWith(expect.objectContaining({
      repositoryKey: "followups",
      path: systemPaths.followupsFile,
      backupPath: join(dirname(systemPaths.followupsFile), backupName!),
      errorType: "syntax",
    }));
  });

  it("recovers an invalid followups ledger from last-known-good instead of dropping pending entries", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-followups-last-known-good-"));
    const systemPaths = buildSystemPaths(workspaceDir);
    const onStateRecovery = vi.fn();
    const repositories = createFileBackedManagerRepositories(systemPaths, { onStateRecovery });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const followups = [{
      issueId: "AIC-42",
      status: "awaiting-response" as const,
      requestKind: "status" as const,
      sourceChannelId: "C123",
      sourceThreadTs: "1779781504.200029",
    }];

    await repositories.followups.save(followups);
    await writeFile(systemPaths.followupsFile, "{\"issueId\":1}\n", "utf8");

    await expect(repositories.followups.load()).resolves.toEqual(followups);

    const lastKnownGoodPath = `${systemPaths.followupsFile}.last-known-good`;
    await expect(readFile(lastKnownGoodPath, "utf8")).resolves.toContain("\"issueId\": \"AIC-42\"");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(onStateRecovery).toHaveBeenCalledWith(expect.objectContaining({
      repositoryKey: "followups",
      restoredFrom: "last-known-good",
      restoredPath: lastKnownGoodPath,
      restoredValue: followups,
    }));
  });

  it("recovers an invalid followups ledger from the latest valid backup when last-known-good is unavailable", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-followups-backup-recovery-"));
    const systemPaths = buildSystemPaths(workspaceDir);
    const onStateRecovery = vi.fn();
    const repositories = createFileBackedManagerRepositories(systemPaths, { onStateRecovery });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const backupPath = `${systemPaths.followupsFile}.bak-20260526T063259Z`;
    const followups = [{
      issueId: "AIC-55",
      status: "resolved" as const,
      resolvedAt: "2026-05-25T00:00:00.000Z",
      resolvedReason: "answered" as const,
    }];

    await mkdir(dirname(systemPaths.followupsFile), { recursive: true });
    await writeFile(backupPath, `${JSON.stringify(followups, null, 2)}\n`, "utf8");
    await writeFile(systemPaths.followupsFile, "{\"issueId\":1}\n", "utf8");

    await expect(repositories.followups.load()).resolves.toEqual(followups);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(onStateRecovery).toHaveBeenCalledWith(expect.objectContaining({
      repositoryKey: "followups",
      restoredFrom: "backup",
      restoredPath: backupPath,
      restoredValue: followups,
    }));
  });

  it("recovers a schema-invalid webhook delivery ledger by backing it up and resetting the file", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-repositories-webhook-invalid-schema-"));
    const systemPaths = buildSystemPaths(workspaceDir);
    const repositories = createFileBackedManagerRepositories(systemPaths);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const invalidSchema = `[
  {
    "deliveryId": 1
  }
]
`;

    await mkdir(dirname(systemPaths.webhookDeliveriesFile), { recursive: true });
    await writeFile(systemPaths.webhookDeliveriesFile, invalidSchema, "utf8");

    await expect(repositories.webhookDeliveries.load()).resolves.toEqual([]);
    await expect(readFile(systemPaths.webhookDeliveriesFile, "utf8")).resolves.toBe("[]\n");

    const backups = await readdir(dirname(systemPaths.webhookDeliveriesFile));
    const backupName = backups.find((entry) => entry.startsWith("webhook-deliveries.json.corrupt-"));
    expect(backupName).toBeDefined();
    await expect(readFile(join(dirname(systemPaths.webhookDeliveriesFile), backupName!), "utf8")).resolves.toBe(invalidSchema);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warnSpy.mock.calls[0]?.[0]))).toMatchObject({
      level: "warn",
      message: "Recovered invalid JSON state file",
      path: systemPaths.webhookDeliveriesFile,
      backupPath: join(dirname(systemPaths.webhookDeliveriesFile), backupName!),
      errorType: "schema",
    });
  });

  it("recovers an invalid webhook delivery ledger from last-known-good instead of clearing dedupe history", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-webhook-last-known-good-"));
    const systemPaths = buildSystemPaths(workspaceDir);
    const onStateRecovery = vi.fn();
    const repositories = createFileBackedManagerRepositories(systemPaths, { onStateRecovery });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const deliveries = [{
      deliveryId: "delivery-42",
      webhookId: "webhook-42",
      issueId: "issue-42",
      issueIdentifier: "AIC-42",
      receivedAt: "2099-05-25T00:00:00.000Z",
      status: "committed" as const,
      createdIssueIds: ["AIC-420"],
    }];

    await repositories.webhookDeliveries.save(deliveries);
    await writeFile(systemPaths.webhookDeliveriesFile, "{\"deliveryId\":1}\n", "utf8");

    await expect(repositories.webhookDeliveries.load()).resolves.toEqual(deliveries);

    const lastKnownGoodPath = `${systemPaths.webhookDeliveriesFile}.last-known-good`;
    await expect(readFile(lastKnownGoodPath, "utf8")).resolves.toContain("\"deliveryId\": \"delivery-42\"");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(onStateRecovery).toHaveBeenCalledWith(expect.objectContaining({
      repositoryKey: "webhookDeliveries",
      restoredFrom: "last-known-good",
      restoredPath: lastKnownGoodPath,
      restoredValue: deliveries,
    }));
  });

  it("recovers an invalid webhook delivery ledger from the latest valid backup when last-known-good is unavailable", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-webhook-backup-recovery-"));
    const systemPaths = buildSystemPaths(workspaceDir);
    const onStateRecovery = vi.fn();
    const repositories = createFileBackedManagerRepositories(systemPaths, { onStateRecovery });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const backupPath = `${systemPaths.webhookDeliveriesFile}.bak-20260526T063259Z`;
    const deliveries = [{
      deliveryId: "delivery-99",
      webhookId: "webhook-99",
      issueId: "issue-99",
      issueIdentifier: "AIC-99",
      receivedAt: "2099-05-26T00:00:00.000Z",
      status: "ignored-duplicate" as const,
      createdIssueIds: [],
    }];

    await mkdir(dirname(systemPaths.webhookDeliveriesFile), { recursive: true });
    await writeFile(backupPath, `${JSON.stringify(deliveries, null, 2)}\n`, "utf8");
    await writeFile(systemPaths.webhookDeliveriesFile, "{\"deliveryId\":1}\n", "utf8");

    await expect(repositories.webhookDeliveries.load()).resolves.toEqual(deliveries);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(onStateRecovery).toHaveBeenCalledWith(expect.objectContaining({
      repositoryKey: "webhookDeliveries",
      restoredFrom: "backup",
      restoredPath: backupPath,
      restoredValue: deliveries,
    }));
  });

  it("trims webhook delivery retention on save and persists the trimmed last-known-good ledger", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-webhook-trim-"));
    const systemPaths = buildSystemPaths(workspaceDir);
    const repositories = createFileBackedManagerRepositories(systemPaths);
    const staleDelivery = {
      deliveryId: "delivery-stale",
      webhookId: "webhook-stale",
      issueId: "issue-stale",
      issueIdentifier: "AIC-0",
      receivedAt: "2000-01-01T00:00:00.000Z",
      status: "received" as const,
      createdIssueIds: [],
    };
    const recentDeliveries = Array.from({ length: 1002 }, (_, index) => ({
      deliveryId: `delivery-${index}`,
      webhookId: `webhook-${index}`,
      issueId: `issue-${index}`,
      issueIdentifier: `AIC-${index}`,
      receivedAt: `2099-05-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      status: "committed" as const,
      createdIssueIds: index % 2 === 0 ? [`AIC-CREATED-${index}`] : [],
    }));

    await repositories.webhookDeliveries.save([staleDelivery, ...recentDeliveries]);

    const persisted = await repositories.webhookDeliveries.load();
    expect(persisted).toHaveLength(1000);
    expect(persisted[0]?.deliveryId).toBe("delivery-2");
    expect(persisted.at(-1)?.deliveryId).toBe("delivery-1001");

    const lastKnownGoodPath = `${systemPaths.webhookDeliveriesFile}.last-known-good`;
    const lastKnownGood = JSON.parse(await readFile(lastKnownGoodPath, "utf8")) as Array<{ deliveryId: string }>;
    expect(lastKnownGood).toHaveLength(1000);
    expect(lastKnownGood[0]?.deliveryId).toBe("delivery-2");
    expect(lastKnownGood.some((entry) => entry.deliveryId === "delivery-stale")).toBe(false);
  });

  it("prunes stale corrupt and overflow backup artifacts when saving policy state", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-policy-artifact-retention-"));
    const systemPaths = buildSystemPaths(workspaceDir);
    const repositories = createFileBackedManagerRepositories(systemPaths);
    const now = Date.now();

    await mkdir(dirname(systemPaths.policyFile), { recursive: true });
    for (let index = 0; index < 7; index += 1) {
      const corruptPath = `${systemPaths.policyFile}.corrupt-old-${index}`;
      await writeFile(corruptPath, `corrupt-${index}\n`, "utf8");
      const oldDate = new Date(now - ((60 + index) * 24 * 60 * 60 * 1000));
      await utimes(corruptPath, oldDate, oldDate);
    }
    for (let index = 0; index < 12; index += 1) {
      const backupPath = `${systemPaths.policyFile}.bak-retention-${index}`;
      await writeFile(backupPath, `backup-${index}\n`, "utf8");
      const recentDate = new Date(now - (index * 60 * 60 * 1000));
      await utimes(backupPath, recentDate, recentDate);
    }

    await repositories.policy.save({
      ...DEFAULT_POLICY,
      heartbeatEnabled: false,
    });

    const entries = await readdir(dirname(systemPaths.policyFile));
    const corruptEntries = entries.filter((entry) => entry.startsWith("policy.json.corrupt-old-")).sort();
    const backupEntries = entries.filter((entry) => entry.startsWith("policy.json.bak-retention-")).sort();

    expect(corruptEntries).toEqual(["policy.json.corrupt-old-0"]);
    expect(backupEntries).toHaveLength(10);
    expect(backupEntries).not.toContain("policy.json.bak-retention-10");
    expect(backupEntries).not.toContain("policy.json.bak-retention-11");
    expect(backupEntries).toContain("policy.json.bak-retention-0");
    await expect(readFile(`${systemPaths.policyFile}.last-known-good`, "utf8")).resolves.toContain("\"heartbeatEnabled\": false");
  });
});
