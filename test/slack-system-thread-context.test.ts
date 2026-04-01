import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildThreadPaths, ensureThreadWorkspace } from "../src/lib/thread-workspace.js";
import { loadSystemThreadContext } from "../src/lib/system-thread-context.js";
import {
  extractLegacySystemThreadIssueRefs,
  recoverLegacySystemThreadContextFromSlackHistory,
} from "../src/gateways/slack-system-thread-context/index.js";

describe("slack system thread context recovery", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("extracts exact and shorthand issue refs with grouped title hints", () => {
    const issueRefs = extractLegacySystemThreadIssueRefs([
      ":city_sunset: 夕方レビュー (2026-03-31)",
      "AIC-38（4日超過・月曜になっても Backlog のまま）",
      "AIC-86/87（役員チャンネル招待・MTG定例名確認）: m.tahira アサイン済み",
      "後続 AIC-58→59 もブロックされています",
    ].join("\n"));

    expect(issueRefs).toEqual([
      { issueId: "AIC-38", titleHint: "4日超過・月曜になっても Backlog のまま" },
      { issueId: "AIC-86", titleHint: "役員チャンネル招待・MTG定例名確認" },
      { issueId: "AIC-87", titleHint: "役員チャンネル招待・MTG定例名確認" },
      { issueId: "AIC-58" },
      { issueId: "AIC-59" },
    ]);
  });

  it("recovers legacy system thread context from a pre-AIC-119 root Slack post", async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "cogito-legacy-system-thread-"));
    const paths = buildThreadPaths(workspaceDir, "C123", "1774944062.253979");
    await ensureThreadWorkspace(paths);
    const webClient = {
      conversations: {
        replies: vi.fn().mockResolvedValue({
          messages: [
            {
              ts: "1774944062.253979",
              user: "UBOT",
              text: [
                ":city_sunset: 夕方レビュー (2026-03-31)",
                "AIC-86/87（役員チャンネル招待・MTG定例名確認）: m.tahira アサイン済みだが stale 1日。今週中の着手確認を推奨",
              ].join("\n"),
            },
          ],
        }),
      },
    } as never;

    const result = await recoverLegacySystemThreadContextFromSlackHistory({
      paths,
      webClient,
      channelId: "C123",
      rootThreadTs: "1774944062.253979",
      botUserId: "UBOT",
    });

    expect(result.recovered).toBe(true);
    expect(result.context).toMatchObject({
      sourceKind: "legacy-system",
      rootPostedTs: "1774944062.253979",
      issueRefs: [
        { issueId: "AIC-86", titleHint: "役員チャンネル招待・MTG定例名確認" },
        { issueId: "AIC-87", titleHint: "役員チャンネル招待・MTG定例名確認" },
      ],
      summary: "Recovered from pre-AIC-119 root Slack post",
    });
    await expect(loadSystemThreadContext(paths)).resolves.toMatchObject({
      sourceKind: "legacy-system",
      issueRefs: [
        { issueId: "AIC-86", titleHint: "役員チャンネル招待・MTG定例名確認" },
        { issueId: "AIC-87", titleHint: "役員チャンネル招待・MTG定例名確認" },
      ],
    });

    const logContents = await readFile(paths.logFile, "utf8");
    expect(logContents).toContain("\"type\":\"assistant\"");
    expect(logContents).toContain("AIC-86/87");
  });

  it("does not recover when the root Slack post has no explicit issue refs", async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "cogito-legacy-system-thread-"));
    const paths = buildThreadPaths(workspaceDir, "C123", "1774944062.253979");
    await ensureThreadWorkspace(paths);
    const webClient = {
      conversations: {
        replies: vi.fn().mockResolvedValue({
          messages: [
            {
              ts: "1774944062.253979",
              user: "UBOT",
              text: ":city_sunset: 夕方レビュー\n大きな変化はありません。",
            },
          ],
        }),
      },
    } as never;

    const result = await recoverLegacySystemThreadContextFromSlackHistory({
      paths,
      webClient,
      channelId: "C123",
      rootThreadTs: "1774944062.253979",
      botUserId: "UBOT",
    });

    expect(result.recovered).toBe(false);
    await expect(loadSystemThreadContext(paths)).resolves.toBeUndefined();
  });
});
