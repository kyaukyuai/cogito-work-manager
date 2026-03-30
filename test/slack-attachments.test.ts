import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ingestThreadAttachments,
  loadThreadAttachmentCatalog,
  readThreadAttachment,
  saveThreadAttachmentCatalog,
} from "../src/gateways/slack-attachments/index.js";
import { buildThreadPaths, ensureThreadWorkspace } from "../src/lib/thread-workspace.js";

describe("slack attachment gateway", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("ingests text attachments and exposes extracted windows", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-attachment-gateway-"));
    tempDirs.push(workspaceDir);
    const paths = buildThreadPaths(workspaceDir, "C123", "111.000");
    await ensureThreadWorkspace(paths);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Buffer.from("第一条\n第二条\n第三条\n"),
    });
    vi.stubGlobal("fetch", fetchMock);

    const ingestResult = await ingestThreadAttachments({
      paths,
      slackBotToken: "xoxb-test",
      webClient: {
        conversations: {
          replies: vi.fn(),
        },
      } as never,
      channelId: "C123",
      rootThreadTs: "111.000",
      messageTs: "111.666",
      files: [
        {
          id: "F123",
          name: "contract.txt",
          mimetype: "text/plain",
          url_private_download: "https://files.example/contract.txt",
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledWith("https://files.example/contract.txt", expect.any(Object));
    expect(ingestResult.summaries).toHaveLength(1);
    expect(ingestResult.summaries[0]).toMatchObject({
      name: "contract.txt",
      kind: "document",
      extractionStatus: "completed",
      previewText: expect.stringContaining("第一条"),
    });

    const readResult = await readThreadAttachment({
      paths,
      attachmentId: ingestResult.summaries[0].attachmentId,
      maxLines: 2,
    });

    expect(readResult.textWindow).toContain("第一条");
    expect(readResult.textWindow).toContain("第二条");
    expect(readResult.moreLinesAvailable).toBe(true);
  });

  it("marks audio/video attachments unavailable when OPENAI_API_KEY is missing", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-attachment-media-"));
    tempDirs.push(workspaceDir);
    const paths = buildThreadPaths(workspaceDir, "C123", "222.000");
    await ensureThreadWorkspace(paths);
    const storedPath = join(paths.attachmentsDir, "F999-demo.mp4");
    await writeFile(storedPath, "placeholder", "utf8");
    await saveThreadAttachmentCatalog(paths, {
      entries: [
        {
          attachmentId: "222.111-F999",
          sourceAttachmentId: "F999",
          sourceMessageTs: "222.111",
          name: "demo.mp4",
          mimeType: "video/mp4",
          storedPath,
          kind: "video",
          createdAt: "2026-03-30T02:00:00.000Z",
          updatedAt: "2026-03-30T02:00:00.000Z",
          extraction: {
            status: "not_applicable",
          },
          transcription: {
            status: "pending",
          },
        },
      ],
    });

    const readResult = await readThreadAttachment({
      paths,
      attachmentId: "222.111-F999",
    });

    expect(readResult.textWindow).toBe("");
    expect(readResult.note).toContain("OPENAI_API_KEY");

    const catalog = await loadThreadAttachmentCatalog(paths);
    expect(catalog.entries[0]).toMatchObject({
      transcription: {
        status: "unavailable",
      },
    });
  });

  it("falls back to thread history when event file metadata lacks private URLs", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-attachment-history-fallback-"));
    tempDirs.push(workspaceDir);
    const paths = buildThreadPaths(workspaceDir, "C123", "333.000");
    await ensureThreadWorkspace(paths);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Buffer.from("修正版の本文"),
    });
    vi.stubGlobal("fetch", fetchMock);
    const repliesMock = vi.fn().mockResolvedValue({
      messages: [
        {
          ts: "333.111",
          files: [
            {
              id: "F333",
              name: "kanazawa_clone_soul (1).md",
              mimetype: "text/plain",
              url_private_download: "https://files.example/kanazawa_clone_soul.md",
            },
          ],
        },
      ],
    });

    const ingestResult = await ingestThreadAttachments({
      paths,
      slackBotToken: "xoxb-test",
      webClient: {
        conversations: {
          replies: repliesMock,
        },
      } as never,
      channelId: "C123",
      rootThreadTs: "333.000",
      messageTs: "333.111",
      files: [
        {
          id: "F333",
          name: "kanazawa_clone_soul (1).md",
          mimetype: "text/plain",
        },
      ],
    });

    expect(repliesMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://files.example/kanazawa_clone_soul.md", expect.any(Object));
    expect(ingestResult.usedHydratedSlackFiles).toBe(true);
    expect(ingestResult.summaries[0]).toMatchObject({
      name: "kanazawa_clone_soul (1).md",
      extractionStatus: "completed",
    });
    expect(ingestResult.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "info",
          message: "Attachment metadata incomplete on Slack event",
        }),
      ]),
    );
  });

  it("retries thread history hydration once when files are not visible yet", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-attachment-history-retry-"));
    tempDirs.push(workspaceDir);
    const paths = buildThreadPaths(workspaceDir, "C123", "444.000");
    await ensureThreadWorkspace(paths);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Buffer.from("retryで取得"),
    });
    vi.stubGlobal("fetch", fetchMock);
    const repliesMock = vi.fn()
      .mockResolvedValueOnce({
        messages: [
          {
            ts: "444.111",
            files: [],
          },
        ],
      })
      .mockResolvedValueOnce({
        messages: [
          {
            ts: "444.111",
            files: [
              {
                id: "F444",
                name: "retry.md",
                mimetype: "text/plain",
                url_private_download: "https://files.example/retry.md",
              },
            ],
          },
        ],
      });

    const ingestResult = await ingestThreadAttachments({
      paths,
      slackBotToken: "xoxb-test",
      webClient: {
        conversations: {
          replies: repliesMock,
        },
      } as never,
      channelId: "C123",
      rootThreadTs: "444.000",
      messageTs: "444.111",
      files: [],
    });

    expect(repliesMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith("https://files.example/retry.md", expect.any(Object));
    expect(ingestResult.summaries).toHaveLength(1);
    expect(ingestResult.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "info",
          message: "Attachment history hydration returned no files",
        }),
        expect.objectContaining({
          level: "info",
          message: "Attachment history hydration retry recovered files",
        }),
      ]),
    );
  });

  it("returns non-fatal diagnostics when thread history still has no files after retry", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-attachment-history-empty-"));
    tempDirs.push(workspaceDir);
    const paths = buildThreadPaths(workspaceDir, "C123", "555.000");
    await ensureThreadWorkspace(paths);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const repliesMock = vi.fn()
      .mockResolvedValueOnce({
        messages: [
          {
            ts: "555.111",
            files: [],
          },
        ],
      })
      .mockResolvedValueOnce({
        messages: [
          {
            ts: "555.111",
            files: [],
          },
        ],
      });

    const ingestResult = await ingestThreadAttachments({
      paths,
      slackBotToken: "xoxb-test",
      webClient: {
        conversations: {
          replies: repliesMock,
        },
      } as never,
      channelId: "C123",
      rootThreadTs: "555.000",
      messageTs: "555.111",
      files: [],
    });
    const catalog = await loadThreadAttachmentCatalog(paths);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(repliesMock).toHaveBeenCalledTimes(2);
    expect(ingestResult.attachments).toEqual([]);
    expect(ingestResult.summaries).toEqual([]);
    expect(catalog.entries).toEqual([]);
    expect(ingestResult.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          message: "Attachment history hydration returned no files after retry",
        }),
      ]),
    );
  });
});
