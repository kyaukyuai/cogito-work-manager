import { readFile, writeFile } from "node:fs/promises";
import { expect } from "vitest";
import type { ManagerHandleResult, ManagerSlackMessage } from "../../src/lib/manager.js";
import type { SystemPaths } from "../../src/lib/system-workspace.js";

export interface TranscriptExpectation {
  handled?: boolean;
  replyIncludes?: string[];
  replyExcludes?: string[];
}

export interface TranscriptTurnFixture {
  id: string;
  channelId: string;
  rootThreadTs: string;
  messageTs: string;
  userId: string;
  text: string;
  now: string;
  beforeScenario?: string;
  expect: TranscriptExpectation;
}

export interface TranscriptFixture {
  name: string;
  ownerMapPatch?: Record<string, unknown>;
  turns: TranscriptTurnFixture[];
}

export async function loadTranscriptFixture(path: string): Promise<TranscriptFixture> {
  return JSON.parse(await readFile(path, "utf8")) as TranscriptFixture;
}

export async function patchOwnerMap(systemPaths: SystemPaths, patch: Record<string, unknown>): Promise<void> {
  const raw = await readFile(systemPaths.ownerMapFile, "utf8");
  const current = JSON.parse(raw) as Record<string, unknown>;
  await writeFile(systemPaths.ownerMapFile, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, "utf8");
}

export async function runTranscriptFixture(args: {
  fixture: TranscriptFixture;
  systemPaths: SystemPaths;
  beforeTurn?: (turn: TranscriptTurnFixture) => Promise<void> | void;
  invokeTurn: (message: ManagerSlackMessage, now: Date) => Promise<ManagerHandleResult>;
}): Promise<void> {
  if (args.fixture.ownerMapPatch) {
    await patchOwnerMap(args.systemPaths, args.fixture.ownerMapPatch);
  }

  for (const turn of args.fixture.turns) {
    await args.beforeTurn?.(turn);

    const result = await args.invokeTurn(
      {
        channelId: turn.channelId,
        rootThreadTs: turn.rootThreadTs,
        messageTs: turn.messageTs,
        userId: turn.userId,
        text: turn.text,
      },
      new Date(turn.now),
    );

    if (turn.expect.handled !== undefined) {
      expect.soft(result.handled, `${args.fixture.name}:${turn.id}:handled`).toBe(turn.expect.handled);
    }
    for (const needle of turn.expect.replyIncludes ?? []) {
      expect.soft(result.reply ?? "", `${args.fixture.name}:${turn.id}:includes:${needle}`).toContain(needle);
    }
    for (const needle of turn.expect.replyExcludes ?? []) {
      expect.soft(result.reply ?? "", `${args.fixture.name}:${turn.id}:excludes:${needle}`).not.toContain(needle);
    }
  }
}
