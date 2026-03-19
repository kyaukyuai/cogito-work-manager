import { resolve } from "node:path";
import { buildSystemPaths } from "../src/lib/system-workspace.js";
import { createFileBackedWorkgraphRepository } from "../src/state/workgraph/file-backed-workgraph-repository.js";

type Command = "snapshot" | "compact" | "recover";

function parseCommand(value: string | undefined): Command {
  if (value === "snapshot" || value === "compact" || value === "recover") {
    return value;
  }
  throw new Error("Usage: tsx scripts/workgraph-maintenance.ts <snapshot|compact|recover> [workspaceDir]");
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv[2]);
  const workspaceDir = resolve(process.argv[3] ?? process.env.WORKSPACE_DIR ?? "./workspace");
  const repository = createFileBackedWorkgraphRepository(buildSystemPaths(workspaceDir));

  const snapshot = command === "snapshot"
    ? await repository.rebuildSnapshot()
    : command === "compact"
      ? await repository.compact()
      : await repository.recoverSnapshotFromLog();

  process.stdout.write(`${JSON.stringify({
    command,
    workspaceDir,
    eventCount: snapshot.eventCount,
    compactedEventCount: snapshot.compactedEventCount,
    lastEventId: snapshot.lastEventId ?? null,
    lastOccurredAt: snapshot.lastOccurredAt ?? null,
    issueCount: Object.keys(snapshot.projection.issues).length,
    threadCount: Object.keys(snapshot.projection.threads).length,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
