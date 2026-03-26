import { readFile, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitManagerCommandProposals } from "../src/lib/manager-command-commit.js";
import { buildSystemPaths } from "../src/lib/system-workspace.js";
import {
  buildLinearTestEnv,
  cleanupManagerCommandCommitTestContext,
  createManagerCommandCommitTestContext,
  type ManagerCommandCommitTestContext,
} from "./manager-command-commit-test-support.js";

describe("manager command commit scheduler", () => {
  let testContext: ManagerCommandCommitTestContext;

  beforeEach(async () => {
    testContext = await createManagerCommandCommitTestContext();
  });

  afterEach(async () => {
    await cleanupManagerCommandCommitTestContext(testContext.workspaceDir);
  });

  it("creates a custom scheduler job in jobs.json", async () => {
    const result = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "create_scheduler_job",
          jobId: "daily-task-check",
          prompt: "AIC の期限近い task を確認する",
          kind: "daily",
          time: "09:00",
          reasonSummary: "毎朝の custom scheduler job を追加します。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-scheduler-create",
        messageTs: "msg-scheduler-create-1",
        userId: "U1",
        text: "毎日 09:00 に AIC の期限近い task を確認する job を追加して",
      },
      now: new Date("2026-03-24T00:00:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    const jobs = JSON.parse(await readFile(buildSystemPaths(testContext.workspaceDir).jobsFile, "utf8")) as Array<Record<string, unknown>>;

    expect(result.committed).toHaveLength(1);
    expect(jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "daily-task-check",
        kind: "daily",
        time: "09:00",
        prompt: "AIC の期限近い task を確認する",
      }),
    ]));
  });

  it("updates and deletes a custom scheduler job", async () => {
    const systemPaths = buildSystemPaths(testContext.workspaceDir);
    await writeFile(systemPaths.jobsFile, `${JSON.stringify([
      {
        id: "daily-task-check",
        enabled: true,
        channelId: "C0ALAMDRB9V",
        prompt: "AIC の期限近い task を確認する",
        kind: "daily",
        time: "09:00",
      },
    ], null, 2)}\n`, "utf8");

    const updateResult = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "update_scheduler_job",
          jobId: "daily-task-check",
          time: "17:00",
          reasonSummary: "夕方に移動します。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-scheduler-update",
        messageTs: "msg-scheduler-update-1",
        userId: "U1",
        text: "daily-task-check を 17:00 に変更して",
      },
      now: new Date("2026-03-24T00:00:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    const deleteResult = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "delete_scheduler_job",
          jobId: "daily-task-check",
          reasonSummary: "不要になったため削除します。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-scheduler-delete",
        messageTs: "msg-scheduler-delete-1",
        userId: "U1",
        text: "daily-task-check を削除して",
      },
      now: new Date("2026-03-24T00:00:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    const jobs = JSON.parse(await readFile(systemPaths.jobsFile, "utf8")) as Array<Record<string, unknown>>;

    expect(updateResult.committed).toHaveLength(1);
    expect(updateResult.committed[0]?.summary).toContain("daily-task-check");
    expect(deleteResult.committed).toHaveLength(1);
    expect(jobs.find((job) => job.id === "daily-task-check")).toBeUndefined();
  });

  it("updates built-in schedule policy and syncs review jobs", async () => {
    const result = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "update_builtin_schedule",
          builtinId: "evening-review",
          enabled: false,
          reasonSummary: "夕方レビューを止めます。",
        },
        {
          commandType: "update_builtin_schedule",
          builtinId: "heartbeat",
          intervalMin: 60,
          activeLookbackHours: 12,
          reasonSummary: "heartbeat cadence を下げます。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-builtin-schedule-update",
        messageTs: "msg-builtin-schedule-update-1",
        userId: "U1",
        text: "夕方レビューを止めて heartbeat を 60分ごとにして",
      },
      now: new Date("2026-03-24T00:00:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
    });

    const policy = JSON.parse(await readFile(buildSystemPaths(testContext.workspaceDir).policyFile, "utf8")) as Record<string, unknown>;
    const jobs = JSON.parse(await readFile(buildSystemPaths(testContext.workspaceDir).jobsFile, "utf8")) as Array<Record<string, unknown>>;

    expect(result.committed).toHaveLength(2);
    expect(policy).toMatchObject({
      heartbeatEnabled: true,
      heartbeatIntervalMin: 60,
      heartbeatActiveLookbackHours: 12,
      reviewCadence: expect.objectContaining({
        eveningEnabled: false,
      }),
    });
    expect(jobs.find((job) => job.id === "manager-review-evening")).toBeUndefined();
    expect(result.committed.map((entry) => entry.summary).join("\n")).toContain("夕方レビューを停止しました。");
  });

  it("runs a custom scheduler job immediately without changing its next run", async () => {
    const systemPaths = buildSystemPaths(testContext.workspaceDir);
    await writeFile(systemPaths.jobsFile, `${JSON.stringify([
      {
        id: "weekly-notion-agenda-ai-clone",
        enabled: true,
        channelId: "C0ALAMDRB9V",
        prompt: "Notion に AIクローンプラットフォームのアジェンダを作成する",
        kind: "weekly",
        weekday: "thu",
        time: "09:00",
      },
    ], null, 2)}\n`, "utf8");
    await writeFile(systemPaths.jobStatusFile, `${JSON.stringify([
      {
        id: "weekly-notion-agenda-ai-clone",
        nextRunAt: "2026-03-26T00:00:00.000Z",
      },
    ], null, 2)}\n`, "utf8");

    const result = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "run_scheduler_job_now",
          jobId: "weekly-notion-agenda-ai-clone",
          reasonSummary: "動作確認のため 1 回だけ即時実行します。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-scheduler-run-now",
        messageTs: "msg-scheduler-run-now-1",
        userId: "U1",
        text: "weekly-notion-agenda-ai-clone を今すぐ実行して",
      },
      now: new Date("2026-03-24T01:00:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
      runSchedulerJobNow: vi.fn().mockResolvedValue({
        status: "ok",
        persistedSummary: "Notion にアジェンダを作成しました。",
        commitSummary: "Notion agenda created: <https://www.notion.so/page-1|2026.03.26 | AIクローンプラットフォーム Vol.1>",
        executedAt: "2026-03-24T01:00:05.000Z",
      }),
    });

    const jobStatuses = JSON.parse(await readFile(systemPaths.jobStatusFile, "utf8")) as Array<Record<string, unknown>>;
    const updatedJob = jobStatuses.find((job) => job.id === "weekly-notion-agenda-ai-clone");

    expect(result.committed).toHaveLength(1);
    expect(result.committed[0]?.summary).toContain("Notion agenda created:");
    expect(updatedJob).toMatchObject({
      id: "weekly-notion-agenda-ai-clone",
      nextRunAt: "2026-03-26T00:00:00.000Z",
      lastRunAt: "2026-03-24T01:00:05.000Z",
      lastStatus: "ok",
      lastResult: "Notion にアジェンダを作成しました。",
    });
  });

  it("rejects immediate runs for built-in schedules and unknown custom jobs", async () => {
    const result = await commitManagerCommandProposals({
      config: testContext.config,
      repositories: testContext.repositories,
      proposals: [
        {
          commandType: "run_scheduler_job_now",
          jobId: "morning-review",
          reasonSummary: "built-in を即時実行したいです。",
        },
        {
          commandType: "run_scheduler_job_now",
          jobId: "heartbeat",
          reasonSummary: "heartbeat を即時実行したいです。",
        },
        {
          commandType: "run_scheduler_job_now",
          jobId: "missing-custom-job",
          reasonSummary: "存在しない custom job を即時実行したいです。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-scheduler-run-now-reject",
        messageTs: "msg-scheduler-run-now-reject-1",
        userId: "U1",
        text: "朝レビューと heartbeat を今すぐ実行して",
      },
      now: new Date("2026-03-24T01:10:00.000Z"),
      policy: await testContext.repositories.policy.load(),
      env: buildLinearTestEnv(),
      runSchedulerJobNow: vi.fn(),
    });

    expect(result.committed).toEqual([]);
    expect(result.rejected).toHaveLength(3);
    expect(result.rejected[0]?.reason).toContain("built-in schedule");
    expect(result.rejected[1]?.reason).toContain("built-in schedule");
    expect(result.rejected[2]?.reason).toContain("見つかりませんでした");
  });
});
