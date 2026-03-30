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
});
