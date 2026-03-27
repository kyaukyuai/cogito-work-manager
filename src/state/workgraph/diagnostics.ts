import {
  buildSystemPaths,
  inspectSystemStateFiles,
  type SystemPaths,
  type SystemStateFileStatus,
} from "../../lib/system-workspace.js";
import type { WorkgraphRepository } from "./file-backed-workgraph-repository.js";
import type { WorkgraphHealth, WorkgraphHealthPolicy } from "./health.js";

type WorkgraphFileStatus = Pick<
  SystemStateFileStatus,
  "relativePath" | "absolutePath" | "exists" | "sizeBytes" | "lastModifiedAt"
>;

export interface WorkgraphDiagnostics {
  workspaceDir: string;
  systemRoot: string;
  policy: WorkgraphHealthPolicy;
  health: WorkgraphHealth;
  files: {
    activeLog: WorkgraphFileStatus;
    snapshot: WorkgraphFileStatus;
  };
  operatorActionSummary: {
    recommendedAction: WorkgraphHealth["recommendedAction"];
    summary: string;
    commands: {
      health: string;
      snapshot: string;
      compact: string;
      recover: string;
    };
    maintenanceRules: {
      compactWhen: string;
      recoverWhen: string;
    };
  };
}

function selectWorkgraphFile(
  files: SystemStateFileStatus[],
  relativePath: string,
): WorkgraphFileStatus {
  const file = files.find((entry) => entry.relativePath === relativePath);
  if (!file) {
    throw new Error(`Missing system state definition for ${relativePath}`);
  }
  return {
    relativePath: file.relativePath,
    absolutePath: file.absolutePath,
    exists: file.exists,
    sizeBytes: file.sizeBytes,
    lastModifiedAt: file.lastModifiedAt,
  };
}

export async function buildWorkgraphDiagnostics(args: {
  workspaceDir: string;
  repository: WorkgraphRepository;
  policy: WorkgraphHealthPolicy;
  systemPaths?: SystemPaths;
}): Promise<WorkgraphDiagnostics> {
  const systemPaths = args.systemPaths ?? buildSystemPaths(args.workspaceDir);
  const [health, files] = await Promise.all([
    args.repository.health(args.policy),
    inspectSystemStateFiles(systemPaths),
  ]);

  return {
    workspaceDir: args.workspaceDir,
    systemRoot: systemPaths.rootDir,
    policy: args.policy,
    health,
    files: {
      activeLog: selectWorkgraphFile(files, "workgraph-events.jsonl"),
      snapshot: selectWorkgraphFile(files, "workgraph-snapshot.json"),
    },
    operatorActionSummary: {
      recommendedAction: health.recommendedAction,
      summary: health.operatorSummary,
      commands: {
        health: `npm run workgraph:health -- ${args.workspaceDir}`,
        snapshot: `npm run workgraph:snapshot -- ${args.workspaceDir}`,
        compact: `npm run workgraph:compact -- ${args.workspaceDir}`,
        recover: `npm run workgraph:recover -- ${args.workspaceDir}`,
      },
      maintenanceRules: {
        compactWhen: `Run compaction when activeLogEventCount >= ${args.policy.autoCompactMaxActiveLogEvents}.`,
        recoverWhen: "Run recovery when snapshotInvalid=true or snapshotAheadOfLog=true.",
      },
    },
  };
}
