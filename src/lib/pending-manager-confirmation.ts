import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  managerPendingConfirmationKindSchema,
  managerCommandProposalSchema,
  type ManagerCommandProposal,
} from "./manager-command-commit.js";
import type { ThreadPaths } from "./thread-workspace.js";

export interface PendingManagerConfirmation {
  kind: "owner-map" | "mutation";
  originalUserMessage: string;
  proposals: ManagerCommandProposal[];
  previewSummaryLines: string[];
  previewReply: string;
  recordedAt: string;
}

const CONFIRMATION_EXPIRY_MS = 24 * 60 * 60 * 1000;

const pendingManagerConfirmationSchema = z.object({
  kind: managerPendingConfirmationKindSchema,
  originalUserMessage: z.string(),
  proposals: z.array(managerCommandProposalSchema).min(1),
  previewSummaryLines: z.array(z.string()),
  previewReply: z.string(),
  recordedAt: z.string(),
});

function buildPendingManagerConfirmationPath(paths: ThreadPaths): string {
  return join(paths.scratchDir, "pending-manager-confirmation.json");
}

export function parsePendingManagerConfirmationDecision(text: string): "confirm" | "cancel" | undefined {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[。.!！?？、,\s]/g, "");
  if (!normalized) return undefined;
  if (normalized === "はい"
    || normalized === "お願いします"
    || normalized === "こちらでお願いします"
    || normalized === "それでお願いします"
    || normalized === "この方針で"
    || normalized === "この方針でお願いします"
    || normalized === "その方針で"
    || normalized === "これでお願いします"
    || normalized === "これで進めて"
    || normalized === "これで進めてください"
    || normalized === "そのまま進めて"
    || normalized === "そのままお願いします"
    || normalized === "実行して"
    || normalized === "適用して"
    || normalized === "confirm"
    || normalized === "ok"
    || normalized === "はいお願いします") {
    return "confirm";
  }
  if (normalized === "キャンセル"
    || normalized === "やめて"
    || normalized === "取り消して"
    || normalized === "no") {
    return "cancel";
  }
  return undefined;
}

export async function loadPendingManagerConfirmation(
  paths: ThreadPaths,
  now = new Date(),
): Promise<PendingManagerConfirmation | undefined> {
  try {
    const raw = await readFile(buildPendingManagerConfirmationPath(paths), "utf8");
    const parsed = pendingManagerConfirmationSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return undefined;
    }

    const recordedAt = Date.parse(parsed.data.recordedAt);
    if (Number.isNaN(recordedAt) || now.getTime() - recordedAt > CONFIRMATION_EXPIRY_MS) {
      await clearPendingManagerConfirmation(paths);
      return undefined;
    }

    return parsed.data as PendingManagerConfirmation;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function savePendingManagerConfirmation(
  paths: ThreadPaths,
  confirmation: PendingManagerConfirmation,
): Promise<void> {
  await mkdir(dirname(buildPendingManagerConfirmationPath(paths)), { recursive: true });
  await writeFile(
    buildPendingManagerConfirmationPath(paths),
    `${JSON.stringify(confirmation, null, 2)}\n`,
    "utf8",
  );
}

export async function clearPendingManagerConfirmation(paths: ThreadPaths): Promise<void> {
  try {
    await rm(buildPendingManagerConfirmationPath(paths), { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}
