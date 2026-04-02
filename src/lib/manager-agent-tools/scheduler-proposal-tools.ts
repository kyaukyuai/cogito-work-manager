import { Type } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { createProposalTool } from "./proposal-tool-factory.js";

export function createSchedulerProposalTools(): ToolDefinition[] {
  return [
    createProposalTool({
      name: "propose_create_scheduler_job",
      label: "Propose Create Scheduler Job",
      description: "Propose creating a custom scheduler job. This does not execute the mutation.",
      promptSnippet: "Use this when the user wants to add a new recurring or one-shot custom scheduler job from Slack.",
      commandType: "create_scheduler_job",
      parameters: Type.Object({
        jobId: Type.String({ description: "Stable custom job id such as daily-task-check." }),
        channelId: Type.Optional(Type.String({ description: "Optional target channel id. Omit to use the control room channel." })),
        prompt: Type.String({ description: "Prompt the scheduler job should execute." }),
        kind: Type.String({ description: "at | every | daily | weekly" }),
        at: Type.Optional(Type.String({ description: "ISO datetime for one-shot runs." })),
        everySec: Type.Optional(Type.Number({ description: "Interval seconds for kind=every." })),
        time: Type.Optional(Type.String({ description: "HH:MM for daily or weekly jobs." })),
        weekday: Type.Optional(Type.String({ description: "mon | tue | wed | thu | fri | sat | sun for weekly jobs." })),
        enabled: Type.Optional(Type.Boolean({ description: "Whether the custom job should start enabled." })),
        reasonSummary: Type.String({ description: "Short reason for this proposal." }),
        evidenceSummary: Type.Optional(Type.String({ description: "Short evidence summary." })),
        dedupeKeyCandidate: Type.Optional(Type.String({ description: "Stable dedupe key when you can infer one." })),
      }),
    }),
    createProposalTool({
      name: "propose_update_scheduler_job",
      label: "Propose Update Scheduler Job",
      description: "Propose updating a custom scheduler job. This does not execute the mutation.",
      promptSnippet: "Use this when the user wants to update, stop, resume, or retime a custom scheduler job.",
      commandType: "update_scheduler_job",
      parameters: Type.Object({
        jobId: Type.String({ description: "Existing custom job id." }),
        enabled: Type.Optional(Type.Boolean({ description: "Optional enabled flag." })),
        channelId: Type.Optional(Type.String({ description: "Optional channel id patch." })),
        prompt: Type.Optional(Type.String({ description: "Optional prompt patch." })),
        kind: Type.Optional(Type.String({ description: "Optional replacement schedule kind: at | every | daily | weekly." })),
        at: Type.Optional(Type.String({ description: "Optional ISO datetime patch for kind=at." })),
        everySec: Type.Optional(Type.Number({ description: "Optional seconds patch for kind=every." })),
        time: Type.Optional(Type.String({ description: "Optional HH:MM patch for daily or weekly jobs." })),
        weekday: Type.Optional(Type.String({ description: "Optional weekday patch for weekly jobs." })),
        reasonSummary: Type.String({ description: "Short reason for this proposal." }),
        evidenceSummary: Type.Optional(Type.String({ description: "Short evidence summary." })),
        dedupeKeyCandidate: Type.Optional(Type.String({ description: "Stable dedupe key when you can infer one." })),
      }),
    }),
    createProposalTool({
      name: "propose_delete_scheduler_job",
      label: "Propose Delete Scheduler Job",
      description: "Propose deleting a custom scheduler job. This does not execute the mutation.",
      promptSnippet: "Use this only for custom scheduler jobs. Built-in schedules should be disabled with propose_update_builtin_schedule instead.",
      commandType: "delete_scheduler_job",
      parameters: Type.Object({
        jobId: Type.String({ description: "Existing custom job id." }),
        reasonSummary: Type.String({ description: "Short reason for this proposal." }),
        evidenceSummary: Type.Optional(Type.String({ description: "Short evidence summary." })),
        dedupeKeyCandidate: Type.Optional(Type.String({ description: "Stable dedupe key when you can infer one." })),
      }),
    }),
    createProposalTool({
      name: "propose_update_builtin_schedule",
      label: "Propose Update Builtin Schedule",
      description: "Propose updating a built-in review or heartbeat schedule. This does not execute the mutation.",
      promptSnippet: "Use this for morning/evening/weekly review or heartbeat changes. Delete on a built-in means disable it instead of removing it.",
      commandType: "update_builtin_schedule",
      parameters: Type.Object({
        builtinId: Type.String({ description: "morning-review | evening-review | weekly-review | heartbeat" }),
        enabled: Type.Optional(Type.Boolean({ description: "Optional enable or disable flag." })),
        time: Type.Optional(Type.String({ description: "Optional HH:MM patch for review schedules." })),
        weekday: Type.Optional(Type.String({ description: "Optional weekday patch for weekly-review." })),
        intervalMin: Type.Optional(Type.Number({ description: "Optional heartbeat interval in minutes." })),
        activeLookbackHours: Type.Optional(Type.Number({ description: "Optional heartbeat active lookback window in hours." })),
        reasonSummary: Type.String({ description: "Short reason for this proposal." }),
        evidenceSummary: Type.Optional(Type.String({ description: "Short evidence summary." })),
        dedupeKeyCandidate: Type.Optional(Type.String({ description: "Stable dedupe key when you can infer one." })),
      }),
    }),
    createProposalTool({
      name: "propose_run_scheduler_job_now",
      label: "Propose Run Scheduler Job Now",
      description: "Propose running one custom scheduler job immediately. This does not execute the mutation.",
      promptSnippet: "Use this when the user asks to run a custom scheduler job immediately for testing or a one-off check.",
      commandType: "run_scheduler_job_now",
      parameters: Type.Object({
        jobId: Type.String({ description: "Existing custom scheduler job id." }),
        reasonSummary: Type.String({ description: "Short reason for this proposal." }),
        evidenceSummary: Type.Optional(Type.String({ description: "Short evidence summary." })),
        dedupeKeyCandidate: Type.Optional(Type.String({ description: "Stable dedupe key when you can infer one." })),
      }),
    }),
  ];
}
