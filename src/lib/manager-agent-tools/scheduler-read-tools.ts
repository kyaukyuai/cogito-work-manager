import { Type } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AppConfig } from "../config.js";
import type { ManagerRepositories } from "../../state/repositories/file-backed-manager-repositories.js";
import {
  getUnifiedSchedule,
  listUnifiedSchedules,
  type SchedulerScheduleView,
} from "../scheduler-management.js";
import { buildSystemPaths } from "../system-workspace.js";

function formatScheduleLabel(view: SchedulerScheduleView): string {
  if (view.kind === "custom-job") {
    return view.id;
  }
  if (view.kind === "morning-review") return "朝レビュー";
  if (view.kind === "evening-review") return "夕方レビュー";
  if (view.kind === "weekly-review") return "週次レビュー";
  return "heartbeat";
}

function formatScheduleTiming(view: SchedulerScheduleView): string {
  if (view.scheduleType === "heartbeat") {
    return `${view.intervalMin ?? 0}分ごと`;
  }
  if (view.scheduleType === "daily") {
    return `毎日 ${view.time}`;
  }
  if (view.scheduleType === "weekly") {
    return `毎週 ${view.weekday} ${view.time}`;
  }
  if (view.scheduleType === "every") {
    return `${view.everySec}秒ごと`;
  }
  return view.at ?? "単発実行";
}

function formatScheduleViewText(view: SchedulerScheduleView): string {
  return [
    `${formatScheduleLabel(view)} (${view.id})`,
    `- enabled: ${view.enabled ? "yes" : "no"}`,
    `- source: ${view.source}`,
    `- channel: ${view.channelLabel} (${view.channelId})`,
    `- schedule: ${formatScheduleTiming(view)}`,
    `- prompt: ${view.prompt}`,
    view.nextRunAt ? `- nextRunAt: ${view.nextRunAt}` : undefined,
    view.lastRunAt ? `- lastRunAt: ${view.lastRunAt}` : undefined,
    view.lastStatus ? `- lastStatus: ${view.lastStatus}` : undefined,
    view.lastError ? `- lastError: ${view.lastError}` : undefined,
  ].filter(Boolean).join("\n");
}

export function createSchedulerReadTools(
  config: AppConfig,
  repositories: Pick<ManagerRepositories, "policy">,
): ToolDefinition[] {
  const systemPaths = buildSystemPaths(config.workspaceDir);

  return [
    {
      name: "scheduler_list_schedules",
      label: "Scheduler List Schedules",
      description: "List unified scheduler facts across custom jobs and built-in schedules.",
      promptSnippet: "Use this when the user asks to list or inspect schedules from Slack.",
      parameters: Type.Object({
        channelId: Type.Optional(Type.String({ description: "Optional Slack channel ID filter. Defaults to the control room channel." })),
      }),
      async execute(_toolCallId, params) {
        const policy = await repositories.policy.load();
        const schedules = await listUnifiedSchedules(systemPaths, policy, {
          channelId: (params as { channelId?: string }).channelId,
        });
        return {
          content: [{ type: "text", text: schedules.length > 0 ? schedules.map(formatScheduleViewText).join("\n\n") : "No schedules found." }],
          details: schedules,
        };
      },
    },
    {
      name: "scheduler_get_schedule",
      label: "Scheduler Get Schedule",
      description: "Get one unified scheduler fact by job ID or built-in schedule ID.",
      promptSnippet: "Use this when the user asks about one specific schedule like manager-review-evening or heartbeat.",
      parameters: Type.Object({
        id: Type.String({ description: "Custom job id or built-in schedule id such as manager-review-evening, morning-review, or heartbeat." }),
      }),
      async execute(_toolCallId, params) {
        const policy = await repositories.policy.load();
        const schedule = await getUnifiedSchedule(systemPaths, policy, (params as { id: string }).id);
        return {
          content: [{ type: "text", text: schedule ? formatScheduleViewText(schedule) : "Schedule not found." }],
          details: schedule,
        };
      },
    },
  ];
}
