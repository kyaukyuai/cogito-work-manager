import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPersonalizationObservations } from "../src/lib/personalization-commit.js";
import {
  buildSystemPaths,
  ensureSystemWorkspace,
  readWorkspaceAgents,
  readWorkspaceMemory,
} from "../src/lib/system-workspace.js";

describe("personalization commit", () => {
  it("promotes explicit operating rules into runtime workspace AGENTS", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-personalization-"));
    const paths = buildSystemPaths(workspaceDir);
    await ensureSystemWorkspace(paths);

    const result = await applyPersonalizationObservations({
      paths,
      ledger: [],
      observations: [
        {
          kind: "operating_rule",
          source: "explicit",
          category: "workflow",
          summary: "Prefer issue terminology",
          canonicalText: "常に task より issue という語を優先する。",
          confidence: 0.99,
        },
      ],
      now: new Date("2026-03-24T09:00:00.000Z"),
    });

    expect(result.promoted).toHaveLength(1);
    expect(result.updatedFiles).toEqual(["agents"]);
    await expect(readWorkspaceAgents(paths)).resolves.toContain("常に task より issue という語を優先する。");
  });

  it("keeps inferred memory as candidate until evidence threshold is met", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-personalization-"));
    const paths = buildSystemPaths(workspaceDir);
    await ensureSystemWorkspace(paths);

    const first = await applyPersonalizationObservations({
      paths,
      ledger: [],
      observations: [
        {
          kind: "preference_or_fact",
          source: "inferred",
          category: "preferences",
          summary: "Short processing notice",
          canonicalText: "Slack の考え中表示は「考え中...」を使う。",
          confidence: 0.85,
        },
      ],
      now: new Date("2026-03-24T09:00:00.000Z"),
    });

    expect(first.promoted).toHaveLength(0);
    expect(first.ledger[0]?.status).toBe("candidate");
    await expect(readWorkspaceMemory(paths)).resolves.toBeUndefined();

    const second = await applyPersonalizationObservations({
      paths,
      ledger: first.ledger,
      observations: [
        {
          kind: "preference_or_fact",
          source: "inferred",
          category: "preferences",
          summary: "Short processing notice",
          canonicalText: "Slack の考え中表示は「考え中...」を使う。",
          confidence: 0.9,
        },
      ],
      now: new Date("2026-03-24T10:00:00.000Z"),
    });

    expect(second.promoted).toHaveLength(1);
    expect(second.ledger[0]?.status).toBe("promoted");
    await expect(readWorkspaceMemory(paths)).resolves.toContain("Slack の考え中表示は「考え中...」を使う。");
  });

  it("supersedes conflicting rules with the same summary", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-personalization-"));
    const paths = buildSystemPaths(workspaceDir);
    await ensureSystemWorkspace(paths);

    const first = await applyPersonalizationObservations({
      paths,
      ledger: [],
      observations: [
        {
          kind: "operating_rule",
          source: "explicit",
          category: "reply-style",
          summary: "Capability reply breadth",
          canonicalText: "能力説明では 3 項目までに絞る。",
          confidence: 1,
        },
      ],
      now: new Date("2026-03-24T09:00:00.000Z"),
    });

    const second = await applyPersonalizationObservations({
      paths,
      ledger: first.ledger,
      observations: [
        {
          kind: "operating_rule",
          source: "explicit",
          category: "reply-style",
          summary: "Capability reply breadth",
          canonicalText: "能力説明では 5 系統を簡潔な bullet で返す。",
          confidence: 1,
        },
      ],
      now: new Date("2026-03-24T11:00:00.000Z"),
    });

    const superseded = second.ledger.find((entry) => entry.canonicalText === "能力説明では 3 項目までに絞る。");
    const active = second.ledger.find((entry) => entry.canonicalText === "能力説明では 5 系統を簡潔な bullet で返す。");

    expect(superseded?.status).toBe("superseded");
    expect(active?.status).toBe("promoted");
    await expect(readWorkspaceAgents(paths)).resolves.toContain("能力説明では 5 系統を簡潔な bullet で返す。");
    await expect(readWorkspaceAgents(paths)).resolves.not.toContain("能力説明では 3 項目までに絞る。");
  });
});
