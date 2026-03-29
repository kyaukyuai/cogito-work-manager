import "dotenv/config";
import { resolve } from "node:path";
import {
  buildManagerIssueDiagnostics,
  buildManagerStateFileDiagnostics,
  buildManagerThreadDiagnostics,
  buildManagerWorkgraphDiagnostics,
  buildManagerWorkspaceMemoryDiagnostics,
} from "../src/lib/manager-diagnostics.js";
import { loadConfig, type AppConfig } from "../src/lib/config.js";
import { buildExternalBoundaryDiagnostics } from "../src/lib/external-boundary-diagnostics.js";
import { ensureManagerStateFiles, loadWebhookDeliveries } from "../src/lib/manager-state.js";
import { buildLlmDiagnosticsFromConfig } from "../src/runtime/llm-runtime-config.js";
import { buildSystemPaths, readWorkspaceAgents, readWorkspaceMemory } from "../src/lib/system-workspace.js";
import { createFileBackedManagerRepositories } from "../src/state/repositories/file-backed-manager-repositories.js";

type Command = "thread" | "issue" | "webhook" | "personalization" | "llm" | "state-files" | "memory" | "workgraph" | "boundaries";

function extractMarkdownHeadings(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(##|###|####)\s+/.test(line));
}

function parseCommand(value: string | undefined): Command {
  if (value === "thread" || value === "issue" || value === "webhook" || value === "personalization" || value === "llm" || value === "state-files" || value === "memory" || value === "workgraph" || value === "boundaries") return value;
  throw new Error("Usage: tsx scripts/manager-diagnostics.ts <thread|issue|webhook|personalization|llm|state-files|memory|workgraph|boundaries> <arg1> <arg2?> [workspaceDir]");
}

function buildRuntimeConfig(workspaceDir: string): AppConfig {
  return loadConfig({
    SLACK_APP_TOKEN: "diagnostics",
    SLACK_BOT_TOKEN: "diagnostics",
    SLACK_ALLOWED_CHANNEL_IDS: "C0DIAGNOSTICS",
    LINEAR_API_KEY: "diagnostics",
    LINEAR_WORKSPACE: "diagnostics",
    LINEAR_TEAM_KEY: "AIC",
    ...process.env,
    WORKSPACE_DIR: workspaceDir,
  });
}

function buildThreadDiagnosticsCliView(
  diagnostics: Awaited<ReturnType<typeof buildManagerThreadDiagnostics>>,
) {
  return {
    summary: {
      lastAgentTurn: diagnostics.lastAgentTurn
        ? {
            recordedAt: diagnostics.lastAgentTurn.recordedAt,
            replyPath: diagnostics.lastAgentTurn.replyPath,
            intent: diagnostics.lastAgentTurn.intent,
            conversationKind: diagnostics.lastAgentTurn.conversationKind,
            queryKind: diagnostics.lastAgentTurn.queryKind,
            queryScope: diagnostics.lastAgentTurn.queryScope,
            currentDateTimeJst: diagnostics.lastAgentTurn.currentDateTimeJst,
            duplicateResolutions: diagnostics.lastAgentTurn.duplicateResolutions?.map((entry) => ({
              assessmentStatus: entry.assessmentStatus,
              recommendedAction: entry.recommendedAction,
              selectedIssueId: entry.selectedIssueId,
              reasonSummary: entry.reasonSummary,
              extraQueries: entry.extraQueries,
              finalCandidateIds: entry.finalCandidateIds,
            })),
            technicalFailure: diagnostics.lastAgentTurn.technicalFailure,
          }
        : undefined,
    },
    ...diagnostics,
  };
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv[2]);
  const workspaceDir = resolve(
    command === "thread"
      ? process.argv[5] ?? process.env.WORKSPACE_DIR ?? "./workspace"
      : command === "issue"
        ? process.argv[4] ?? process.env.WORKSPACE_DIR ?? "./workspace"
        : process.argv[3] ?? process.env.WORKSPACE_DIR ?? "./workspace",
  );
  const config = buildRuntimeConfig(workspaceDir);
  const systemPaths = buildSystemPaths(workspaceDir);
  await ensureManagerStateFiles(systemPaths);
  const repositories = createFileBackedManagerRepositories(systemPaths);

  if (command === "llm") {
    const diagnostics = await buildLlmDiagnosticsFromConfig(config);
    process.stdout.write(`${JSON.stringify(diagnostics, null, 2)}\n`);
    return;
  }

  if (command === "state-files") {
    const diagnostics = await buildManagerStateFileDiagnostics({ workspaceDir });
    process.stdout.write(`${JSON.stringify(diagnostics, null, 2)}\n`);
    return;
  }

  if (command === "memory") {
    const diagnostics = await buildManagerWorkspaceMemoryDiagnostics({ workspaceDir });
    process.stdout.write(`${JSON.stringify(diagnostics, null, 2)}\n`);
    return;
  }

  if (command === "workgraph") {
    const diagnostics = await buildManagerWorkgraphDiagnostics({
      config,
      repositories,
    });
    process.stdout.write(`${JSON.stringify(diagnostics, null, 2)}\n`);
    return;
  }

  if (command === "boundaries") {
    const diagnostics = await buildExternalBoundaryDiagnostics({ config });
    process.stdout.write(`${JSON.stringify(diagnostics, null, 2)}\n`);
    return;
  }

  if (command === "thread") {
    const channelId = process.argv[3];
    const rootThreadTs = process.argv[4];
    if (!channelId || !rootThreadTs) {
      throw new Error("Usage: tsx scripts/manager-diagnostics.ts thread <channelId> <rootThreadTs> [workspaceDir]");
    }
    const diagnostics = await buildManagerThreadDiagnostics({
      config,
      repositories,
      channelId,
      rootThreadTs,
    });
    process.stdout.write(`${JSON.stringify(buildThreadDiagnosticsCliView(diagnostics), null, 2)}\n`);
    return;
  }

  if (command === "webhook") {
    const deliveries = await loadWebhookDeliveries(systemPaths);
    process.stdout.write(`${JSON.stringify(deliveries.slice(-20), null, 2)}\n`);
    return;
  }

  if (command === "personalization") {
    const [ledger, workspaceAgents, workspaceMemory] = await Promise.all([
      repositories.personalization.load(),
      readWorkspaceAgents(systemPaths),
      readWorkspaceMemory(systemPaths),
    ]);
    process.stdout.write(`${JSON.stringify({
      recentEntries: ledger.slice(-20),
      workspaceMemoryHeadings: extractMarkdownHeadings(workspaceMemory),
      workspaceMemoryProjects: extractMarkdownHeadings(workspaceMemory)
        .filter((line) => line.startsWith("### "))
        .map((line) => line.replace(/^###\s+/, "")),
      workspaceAgents,
      workspaceMemory,
    }, null, 2)}\n`);
    return;
  }

  const issueId = process.argv[3];
  if (!issueId) {
    throw new Error("Usage: tsx scripts/manager-diagnostics.ts issue <issueId> [workspaceDir]");
  }
  const diagnostics = await buildManagerIssueDiagnostics({
    config,
    repositories,
    issueId,
    env: {
      ...process.env,
      LINEAR_API_KEY: config.linearApiKey,
      LINEAR_WORKSPACE: config.linearWorkspace,
      LINEAR_TEAM_KEY: config.linearTeamKey,
    },
  });
  process.stdout.write(`${JSON.stringify(diagnostics, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
