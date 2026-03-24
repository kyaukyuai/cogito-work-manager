import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureManagerStateFiles, loadManagerPolicy, loadOwnerMap, saveManagerPolicy } from "../src/lib/manager-state.js";
import {
  buildHeartbeatPaths,
  buildSchedulerPaths,
  buildSystemPaths,
  buildWebhookPaths,
  ensureSystemWorkspace,
  loadWorkspaceCustomization,
  readAgendaTemplate,
  readWorkspaceAgents,
  readWorkspaceMemory,
} from "../src/lib/system-workspace.js";

describe("system workspace helpers", () => {
  it("builds system root paths", () => {
    const paths = buildSystemPaths("/workspace");

    expect(paths.rootDir).toBe("/workspace/system");
    expect(paths.jobsFile).toBe("/workspace/system/jobs.json");
    expect(paths.heartbeatPromptFile).toBe("/workspace/system/HEARTBEAT.md");
    expect(paths.workspaceAgentsFile).toBe("/workspace/system/AGENTS.md");
    expect(paths.memoryFile).toBe("/workspace/system/MEMORY.md");
    expect(paths.agendaTemplateFile).toBe("/workspace/system/AGENDA_TEMPLATE.md");
    expect(paths.policyFile).toBe("/workspace/system/policy.json");
    expect(paths.ownerMapFile).toBe("/workspace/system/owner-map.json");
    expect(paths.personalizationLedgerFile).toBe("/workspace/system/personalization-ledger.json");
    expect(paths.webhookDeliveriesFile).toBe("/workspace/system/webhook-deliveries.json");
    expect(paths.workgraphEventsFile).toBe("/workspace/system/workgraph-events.jsonl");
    expect(paths.workgraphSnapshotFile).toBe("/workspace/system/workgraph-snapshot.json");
  });

  it("builds heartbeat session paths", () => {
    const paths = buildHeartbeatPaths("/workspace", "C123");

    expect(paths.rootDir).toBe("/workspace/system/sessions/heartbeat/C123");
    expect(paths.sessionFile).toBe("/workspace/system/sessions/heartbeat/C123/session.jsonl");
  });

  it("builds scheduler session paths", () => {
    const paths = buildSchedulerPaths("/workspace", "job:1");

    expect(paths.rootDir).toBe("/workspace/system/sessions/cron/job_1");
    expect(paths.sessionFile).toBe("/workspace/system/sessions/cron/job_1/session.jsonl");
  });

  it("builds webhook session paths", () => {
    const paths = buildWebhookPaths("/workspace", "AIC:123");

    expect(paths.rootDir).toBe("/workspace/system/sessions/webhook/AIC_123");
    expect(paths.sessionFile).toBe("/workspace/system/sessions/webhook/AIC_123/session.jsonl");
  });

  it("creates default manager files and review jobs", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-system-"));
    const paths = buildSystemPaths(workspaceDir);

    await ensureManagerStateFiles(paths);

    const policy = await loadManagerPolicy(paths);
    const ownerMap = await loadOwnerMap(paths);
    const jobs = JSON.parse(await readFile(paths.jobsFile, "utf8")) as Array<{ id: string }>;
    const personalization = JSON.parse(await readFile(paths.personalizationLedgerFile, "utf8")) as unknown[];
    const deliveries = JSON.parse(await readFile(paths.webhookDeliveriesFile, "utf8")) as unknown[];

    expect(policy.controlRoomChannelId).toBe("C0ALAMDRB9V");
    expect(policy.assistantName).toBe("コギト");
    expect(ownerMap.defaultOwner).toBe("kyaukyuai");
    expect(personalization).toEqual([]);
    expect(deliveries).toEqual([]);
    expect(jobs.map((job) => job.id)).toEqual(
      expect.arrayContaining([
        "manager-review-morning",
        "manager-review-evening",
        "manager-review-weekly",
      ]),
    );
  });

  it("removes the legacy intake ledger file during manager state bootstrap", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-system-legacy-"));
    const paths = buildSystemPaths(workspaceDir);
    const legacyFile = join(paths.rootDir, "intake-ledger.json");

    await ensureSystemWorkspace(paths);
    await writeFile(legacyFile, "[]\n", "utf8");
    await ensureManagerStateFiles(paths);

    await expect(access(legacyFile)).rejects.toThrow();
  });

  it("writes a default heartbeat prompt for fresh workspaces", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-heartbeat-"));
    const paths = buildSystemPaths(workspaceDir);

    await ensureSystemWorkspace(paths);

    const heartbeatPrompt = await readFile(paths.heartbeatPromptFile, "utf8");
    expect(heartbeatPrompt).toContain("Return at most one issue-centric update.");
    expect(heartbeatPrompt).toContain("HEARTBEAT_OK");
  });

  it("creates editable memory and agenda template files for fresh workspaces", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-custom-"));
    const paths = buildSystemPaths(workspaceDir);

    await ensureSystemWorkspace(paths);

    const workspaceAgents = await readWorkspaceAgents(paths);
    const memory = await readWorkspaceMemory(paths);
    const agendaTemplate = await readAgendaTemplate(paths);

    expect(workspaceAgents).toBeUndefined();
    expect(memory).toBeUndefined();
    expect(agendaTemplate).toBeUndefined();
    await expect(readFile(paths.workspaceAgentsFile, "utf8")).resolves.toBe("\n");
    await expect(readFile(paths.memoryFile, "utf8")).resolves.toBe("\n");
    await expect(readFile(paths.agendaTemplateFile, "utf8")).resolves.toBe("\n");
  });

  it("loads workspace customization slots together", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-custom-load-"));
    const paths = buildSystemPaths(workspaceDir);

    await ensureSystemWorkspace(paths);
    await writeFile(paths.workspaceAgentsFile, "常に issue という語を優先する\n", "utf8");
    await writeFile(paths.memoryFile, "用語は issue に統一する\n", "utf8");
    await writeFile(paths.agendaTemplateFile, "## 議題\n- 決めること\n", "utf8");

    await expect(loadWorkspaceCustomization(paths)).resolves.toEqual({
      workspaceAgents: "常に issue という語を優先する",
      workspaceMemory: "用語は issue に統一する",
      agendaTemplate: "## 議題\n- 決めること",
    });
  });

  it("removes disabled built-in review jobs when syncing manager state", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-builtins-"));
    const paths = buildSystemPaths(workspaceDir);

    await ensureManagerStateFiles(paths);
    const policy = await loadManagerPolicy(paths);
    policy.reviewCadence.eveningEnabled = false;
    await saveManagerPolicy(paths, policy);
    await ensureManagerStateFiles(paths);

    const jobs = JSON.parse(await readFile(paths.jobsFile, "utf8")) as Array<{ id: string }>;
    expect(jobs.find((job) => job.id === "manager-review-evening")).toBeUndefined();
    expect(jobs.map((job) => job.id)).toEqual(
      expect.arrayContaining([
        "manager-review-morning",
        "manager-review-weekly",
      ]),
    );
  });
});
