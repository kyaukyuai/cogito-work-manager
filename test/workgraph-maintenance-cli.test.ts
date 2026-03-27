import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const tsxBin = join(repoDir, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const maintenanceScript = join(repoDir, "scripts", "workgraph-maintenance.ts");

describe("workgraph maintenance cli", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("prints health output with operator guidance", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "workgraph-health-cli-"));
    tempDirs.push(cwd);

    await mkdir(join(cwd, "workspace", "system"), { recursive: true });
    await writeFile(join(cwd, "workspace", "system", "workgraph-events.jsonl"), [
      JSON.stringify({
        id: "00000000-0000-4000-8000-000000000002",
        type: "planning.parent_created",
        occurredAt: "2026-03-19T05:00:00.000Z",
        threadKey: "C0ALAMDRB9V:thread-workgraph",
        sourceChannelId: "C0ALAMDRB9V",
        sourceThreadTs: "thread-workgraph",
        sourceMessageTs: "msg-1",
        issueId: "AIC-980",
        title: "workgraph health check",
      }),
      "",
    ].join("\n"), "utf8");

    const { stdout } = await execFileAsync(tsxBin, [maintenanceScript, "health", "./workspace"], {
      cwd,
      env: {
        ...process.env,
        WORKGRAPH_HEALTH_WARN_ACTIVE_EVENTS: "1",
        WORKGRAPH_AUTO_COMPACT_MAX_ACTIVE_EVENTS: "3",
      },
    });
    const json = stdout.slice(stdout.indexOf("{"));
    const diagnostics = JSON.parse(json) as {
      health: {
        recommendedAction?: string;
        reasons?: Array<{ code?: string }>;
      };
      operatorActionSummary: {
        commands?: { compact?: string };
      };
    };

    expect(diagnostics.health).toMatchObject({
      recommendedAction: "observe",
      reasons: [
        expect.objectContaining({
          code: "active-log-warning",
        }),
      ],
    });
    expect(diagnostics.operatorActionSummary.commands?.compact).toContain("npm run workgraph:compact");
  });
});
