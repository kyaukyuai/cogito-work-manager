import { z } from "zod";
import { normalizeSchedulerJobs, recordManualJobRun } from "../../scheduler.js";
import {
  buildSystemPaths,
  loadSchedulerJobs,
  saveSchedulerJobs,
  schedulerJobSchema,
} from "../../system-workspace.js";
import { ensureManagerStateFiles, loadManagerPolicy, saveManagerPolicy } from "../../manager-state.js";
import {
  getUnifiedSchedule,
  isBuiltInReviewJobId,
  isBuiltInScheduleId,
  isReservedSchedulerId,
  reviewJobIdForBuiltInScheduleId,
  type BuiltInScheduleId,
} from "../../scheduler-management.js";
import type {
  CreateSchedulerJobProposal,
  DeleteSchedulerJobProposal,
  ManagerCommandHandlerResult,
  RunSchedulerJobNowProposal,
  UpdateBuiltinScheduleProposal,
  UpdateSchedulerJobProposal,
} from "../contracts.js";
import type { CommitManagerCommandArgs } from "../contracts.js";

function schedulerChannelOrDefault(
  channelId: string | undefined,
  policy: CommitManagerCommandArgs["policy"],
): string {
  return channelId?.trim() || policy.controlRoomChannelId;
}

function builtInScheduleLabel(builtinId: BuiltInScheduleId): string {
  if (builtinId === "morning-review") return "朝レビュー";
  if (builtinId === "evening-review") return "夕方レビュー";
  if (builtinId === "weekly-review") return "週次レビュー";
  return "heartbeat";
}

function schedulerJobLabel(
  kind: CreateSchedulerJobProposal["kind"] | UpdateSchedulerJobProposal["kind"],
  proposal: {
    time?: string;
    weekday?: string;
    everySec?: number;
    at?: string;
  },
): string {
  if (kind === "daily") {
    return `毎日 ${proposal.time}`;
  }
  if (kind === "weekly") {
    return `毎週 ${proposal.weekday} ${proposal.time}`;
  }
  if (kind === "every") {
    return `${proposal.everySec}秒ごと`;
  }
  return proposal.at ?? "単発実行";
}

function validateSchedulerChannel(
  channelId: string,
  config: CommitManagerCommandArgs["config"],
): string | undefined {
  return config.slackAllowedChannelIds.has(channelId)
    ? undefined
    : `channel ${channelId} は許可された Slack channel ではありません。`;
}

function validateFutureAt(
  at: string | undefined,
  now: Date,
): string | undefined {
  if (!at) return undefined;
  const parsed = Date.parse(at);
  if (Number.isNaN(parsed)) {
    return "at の日時を解釈できませんでした。";
  }
  if (parsed <= now.getTime()) {
    return "at に指定された日時が過去です。未来の日時を指定してください。";
  }
  return undefined;
}

function sanitizeSchedulerJobForKind(
  job: z.infer<typeof schedulerJobSchema>,
): z.infer<typeof schedulerJobSchema> {
  if (job.kind === "at") {
    return {
      ...job,
      everySec: undefined,
      time: undefined,
      weekday: undefined,
    };
  }
  if (job.kind === "every") {
    return {
      ...job,
      at: undefined,
      time: undefined,
      weekday: undefined,
    };
  }
  if (job.kind === "daily") {
    return {
      ...job,
      at: undefined,
      everySec: undefined,
      weekday: undefined,
    };
  }
  return {
    ...job,
    at: undefined,
    everySec: undefined,
  };
}

export async function commitCreateSchedulerJobProposal(
  args: CommitManagerCommandArgs,
  proposal: CreateSchedulerJobProposal,
): Promise<ManagerCommandHandlerResult> {
  if (isReservedSchedulerId(proposal.jobId)) {
    return {
      proposal,
      reason: `${proposal.jobId} は built-in schedule 用の予約 ID です。別の jobId を使ってください。`,
    };
  }

  const systemPaths = buildSystemPaths(args.config.workspaceDir);
  const jobs = normalizeSchedulerJobs(await loadSchedulerJobs(systemPaths));
  if (jobs.some((job) => job.id === proposal.jobId)) {
    return {
      proposal,
      reason: `${proposal.jobId} は既に存在します。別の jobId を使うか既存 job を更新してください。`,
    };
  }

  const channelId = schedulerChannelOrDefault(proposal.channelId, args.policy);
  const invalidChannelReason = validateSchedulerChannel(channelId, args.config);
  if (invalidChannelReason) {
    return { proposal, reason: invalidChannelReason };
  }

  const invalidAtReason = validateFutureAt(proposal.at, args.now);
  if (invalidAtReason) {
    return { proposal, reason: invalidAtReason };
  }

  const parsedJob = schedulerJobSchema.safeParse(sanitizeSchedulerJobForKind({
    id: proposal.jobId,
    enabled: proposal.enabled ?? true,
    channelId,
    prompt: proposal.prompt,
    kind: proposal.kind,
    at: proposal.at,
    everySec: proposal.everySec,
    time: proposal.time,
    weekday: proposal.weekday,
  }));
  if (!parsedJob.success) {
    return {
      proposal,
      reason: parsedJob.error.issues.map((issue) => issue.message).join(" / "),
    };
  }

  const nextJobs = normalizeSchedulerJobs([...jobs, parsedJob.data]);
  await saveSchedulerJobs(systemPaths, nextJobs);
  const saved = nextJobs.find((job) => job.id === proposal.jobId);

  return {
    commandType: proposal.commandType,
    issueIds: [],
    summary: `${proposal.jobId} を ${schedulerJobLabel(proposal.kind, proposal)} で登録しました。${saved?.nextRunAt ? `次回実行は ${saved.nextRunAt} です。` : ""}`.trim(),
  };
}

export async function commitUpdateSchedulerJobProposal(
  args: CommitManagerCommandArgs,
  proposal: UpdateSchedulerJobProposal,
): Promise<ManagerCommandHandlerResult> {
  if (
    proposal.enabled === undefined
    && !proposal.channelId
    && !proposal.prompt
    && !proposal.kind
    && !proposal.at
    && !proposal.everySec
    && !proposal.time
    && !proposal.weekday
  ) {
    return {
      proposal,
      reason: "更新する scheduler 項目がありません。時刻、enabled、prompt などの変更点を指定してください。",
    };
  }
  if (isReservedSchedulerId(proposal.jobId)) {
    return {
      proposal,
      reason: `${proposal.jobId} は built-in schedule です。更新は built-in schedule の更新 proposal を使ってください。`,
    };
  }

  const systemPaths = buildSystemPaths(args.config.workspaceDir);
  const jobs = normalizeSchedulerJobs(await loadSchedulerJobs(systemPaths));
  const current = jobs.find((job) => job.id === proposal.jobId);
  if (!current) {
    return {
      proposal,
      reason: `${proposal.jobId} は見つかりませんでした。`,
    };
  }

  const nextChannelId = proposal.channelId === undefined
    ? current.channelId
    : schedulerChannelOrDefault(proposal.channelId, args.policy);
  const invalidChannelReason = validateSchedulerChannel(nextChannelId, args.config);
  if (invalidChannelReason) {
    return { proposal, reason: invalidChannelReason };
  }

  const nextKind = proposal.kind ?? current.kind;
  const nextJobCandidate = sanitizeSchedulerJobForKind({
    ...current,
    enabled: proposal.enabled ?? current.enabled,
    channelId: nextChannelId,
    prompt: proposal.prompt ?? current.prompt,
    kind: nextKind,
    at: proposal.at ?? current.at,
    everySec: proposal.everySec ?? current.everySec,
    time: proposal.time ?? current.time,
    weekday: proposal.weekday ?? current.weekday,
  });
  const invalidAtReason = validateFutureAt(nextJobCandidate.at, args.now);
  if (invalidAtReason) {
    return { proposal, reason: invalidAtReason };
  }

  const parsedJob = schedulerJobSchema.safeParse(nextJobCandidate);
  if (!parsedJob.success) {
    return {
      proposal,
      reason: parsedJob.error.issues.map((issue) => issue.message).join(" / "),
    };
  }

  const nextJobs = normalizeSchedulerJobs(
    jobs.map((job) => (job.id === proposal.jobId ? parsedJob.data : job)),
  );
  await saveSchedulerJobs(systemPaths, nextJobs);
  const saved = nextJobs.find((job) => job.id === proposal.jobId);

  return {
    commandType: proposal.commandType,
    issueIds: [],
    summary: `${proposal.jobId} を更新しました。${saved ? `現在は ${schedulerJobLabel(saved.kind, saved)} です。` : ""}${saved?.nextRunAt ? `次回実行は ${saved.nextRunAt} です。` : ""}`.trim(),
  };
}

export async function commitDeleteSchedulerJobProposal(
  args: CommitManagerCommandArgs,
  proposal: DeleteSchedulerJobProposal,
): Promise<ManagerCommandHandlerResult> {
  if (proposal.jobId === "heartbeat" || isBuiltInReviewJobId(proposal.jobId)) {
    return {
      proposal,
      reason: `${proposal.jobId} は built-in schedule なので削除できません。停止したい場合は無効化してください。`,
    };
  }

  const systemPaths = buildSystemPaths(args.config.workspaceDir);
  const jobs = normalizeSchedulerJobs(await loadSchedulerJobs(systemPaths));
  if (!jobs.some((job) => job.id === proposal.jobId)) {
    return {
      proposal,
      reason: `${proposal.jobId} は見つかりませんでした。`,
    };
  }

  const nextJobs = jobs.filter((job) => job.id !== proposal.jobId);
  await saveSchedulerJobs(systemPaths, nextJobs);
  return {
    commandType: proposal.commandType,
    issueIds: [],
    summary: `${proposal.jobId} を削除しました。`,
  };
}

export async function commitUpdateBuiltinScheduleProposal(
  args: CommitManagerCommandArgs,
  proposal: UpdateBuiltinScheduleProposal,
): Promise<ManagerCommandHandlerResult> {
  if (
    proposal.enabled === undefined
    && !proposal.time
    && !proposal.weekday
    && proposal.intervalMin === undefined
    && proposal.activeLookbackHours === undefined
  ) {
    return {
      proposal,
      reason: "更新する built-in schedule 項目がありません。enabled、time、weekday、interval を指定してください。",
    };
  }
  if (proposal.builtinId === "heartbeat" && (proposal.time || proposal.weekday)) {
    return {
      proposal,
      reason: "heartbeat では time や weekday は更新できません。intervalMin か activeLookbackHours を指定してください。",
    };
  }
  if (
    proposal.builtinId !== "heartbeat"
    && (proposal.intervalMin !== undefined || proposal.activeLookbackHours !== undefined)
  ) {
    return {
      proposal,
      reason: "intervalMin と activeLookbackHours は heartbeat 専用です。",
    };
  }
  if (proposal.builtinId !== "weekly-review" && proposal.weekday) {
    return {
      proposal,
      reason: "weekday を変更できるのは weekly-review だけです。",
    };
  }
  const systemPaths = buildSystemPaths(args.config.workspaceDir);
  const nextPolicy = await loadManagerPolicy(systemPaths);

  if (proposal.builtinId === "heartbeat") {
    nextPolicy.heartbeatEnabled = proposal.enabled ?? nextPolicy.heartbeatEnabled;
    nextPolicy.heartbeatIntervalMin = proposal.intervalMin ?? nextPolicy.heartbeatIntervalMin;
    nextPolicy.heartbeatActiveLookbackHours = proposal.activeLookbackHours ?? nextPolicy.heartbeatActiveLookbackHours;
  } else if (proposal.builtinId === "morning-review") {
    nextPolicy.reviewCadence.morningEnabled = proposal.enabled ?? nextPolicy.reviewCadence.morningEnabled;
    nextPolicy.reviewCadence.morning = proposal.time ?? nextPolicy.reviewCadence.morning;
  } else if (proposal.builtinId === "evening-review") {
    nextPolicy.reviewCadence.eveningEnabled = proposal.enabled ?? nextPolicy.reviewCadence.eveningEnabled;
    nextPolicy.reviewCadence.evening = proposal.time ?? nextPolicy.reviewCadence.evening;
  } else {
    nextPolicy.reviewCadence.weeklyEnabled = proposal.enabled ?? nextPolicy.reviewCadence.weeklyEnabled;
    nextPolicy.reviewCadence.weeklyTime = proposal.time ?? nextPolicy.reviewCadence.weeklyTime;
    nextPolicy.reviewCadence.weeklyDay = proposal.weekday ?? nextPolicy.reviewCadence.weeklyDay;
  }

  await saveManagerPolicy(systemPaths, nextPolicy);
  await ensureManagerStateFiles(systemPaths);

  const targetId = proposal.builtinId === "heartbeat"
    ? "heartbeat"
    : reviewJobIdForBuiltInScheduleId(proposal.builtinId);
  const schedule = await getUnifiedSchedule(systemPaths, nextPolicy, targetId);
  const label = builtInScheduleLabel(proposal.builtinId);

  if (proposal.enabled === false) {
    return {
      commandType: proposal.commandType,
      issueIds: [],
      summary: `${label}を停止しました。`,
    };
  }

  if (proposal.builtinId === "heartbeat") {
    return {
      commandType: proposal.commandType,
      issueIds: [],
      summary: `${label} を ${nextPolicy.heartbeatIntervalMin}分ごとに更新しました。`,
    };
  }

  return {
    commandType: proposal.commandType,
    issueIds: [],
    summary: `${label} を更新しました。${schedule?.time ? `現在は ${schedule.time}` : ""}${schedule?.weekday ? ` (${schedule.weekday})` : ""}${schedule?.nextRunAt ? `。次回実行は ${schedule.nextRunAt} です。` : ""}`.replace(/^。/, ""),
  };
}

export async function commitRunSchedulerJobNowProposal(
  args: CommitManagerCommandArgs,
  proposal: RunSchedulerJobNowProposal,
): Promise<ManagerCommandHandlerResult> {
  if (!args.runSchedulerJobNow) {
    return {
      proposal,
      reason: "scheduler の即時実行は現在利用できません。",
    };
  }
  if (
    proposal.jobId === "heartbeat"
    || isBuiltInReviewJobId(proposal.jobId)
    || isBuiltInScheduleId(proposal.jobId)
  ) {
    return {
      proposal,
      reason: `${proposal.jobId} は built-in schedule なので、今回の scope では即時実行に対応していません。`,
    };
  }

  const systemPaths = buildSystemPaths(args.config.workspaceDir);
  const jobs = normalizeSchedulerJobs(await loadSchedulerJobs(systemPaths));
  const current = jobs.find((job) => job.id === proposal.jobId);
  if (!current) {
    return {
      proposal,
      reason: `${proposal.jobId} は見つかりませんでした。`,
    };
  }

  const result = await args.runSchedulerJobNow(current);
  const executedAt = result.executedAt ? new Date(result.executedAt) : args.now;
  const nextJobs = normalizeSchedulerJobs(
    jobs.map((job) => (
      job.id === proposal.jobId
        ? recordManualJobRun(job, result.status, result.persistedSummary, executedAt)
        : job
    )),
  );
  await saveSchedulerJobs(systemPaths, nextJobs);

  return {
    commandType: proposal.commandType,
    issueIds: [],
    summary: result.status === "error"
      ? `${proposal.jobId} の即時実行に失敗しました。${result.commitSummary ? ` ${result.commitSummary}` : ""}`.trim()
      : (result.commitSummary?.trim() || `${proposal.jobId} を今すぐ実行しました。`),
  };
}
