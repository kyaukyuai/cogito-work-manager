import type { WebClient } from "@slack/web-api";
import { basename } from "node:path";
import type { AppConfig } from "../lib/config.js";
import type { Logger } from "../lib/logger.js";
import { sendSlackReply } from "../lib/slack-replies.js";
import { DEFAULT_POLICY } from "../state/manager-state-contract.js";
import type { ManagerStateRecoveryEvent } from "../state/repositories/file-backed-manager-repositories.js";

interface PolicyResetDiffEntry {
  path: string;
  previous: string;
  restored: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function summarizeValue(value: unknown): string {
  if (value === undefined) {
    return "missing";
  }
  const text = typeof value === "string"
    ? JSON.stringify(value)
    : JSON.stringify(value);
  if (!text) {
    return String(value);
  }
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function collectPolicyResetDiffEntries(
  previousValue: unknown,
  restoredValue: unknown,
  pathPrefix = "",
): PolicyResetDiffEntry[] {
  if (previousValue === undefined) {
    return [{
      path: pathPrefix || "(root)",
      previous: "missing",
      restored: summarizeValue(restoredValue),
    }];
  }

  if (isPlainObject(previousValue) && isPlainObject(restoredValue)) {
    const diffEntries: PolicyResetDiffEntry[] = [];
    const restoredKeys = Object.keys(restoredValue);
    for (const key of restoredKeys) {
      const nextPath = pathPrefix ? `${pathPrefix}.${key}` : key;
      if (!(key in previousValue)) {
        diffEntries.push({
          path: nextPath,
          previous: "missing",
          restored: summarizeValue(restoredValue[key]),
        });
        continue;
      }
      diffEntries.push(...collectPolicyResetDiffEntries(previousValue[key], restoredValue[key], nextPath));
    }
    for (const key of Object.keys(previousValue)) {
      if (key in restoredValue) {
        continue;
      }
      const nextPath = pathPrefix ? `${pathPrefix}.${key}` : key;
      diffEntries.push({
        path: nextPath,
        previous: summarizeValue(previousValue[key]),
        restored: "removed",
      });
    }
    return diffEntries;
  }

  if (valuesEqual(previousValue, restoredValue)) {
    return [];
  }

  return [{
    path: pathPrefix || "(root)",
    previous: summarizeValue(previousValue),
    restored: summarizeValue(restoredValue),
  }];
}

function buildPolicyResetDiff(event: ManagerStateRecoveryEvent): PolicyResetDiffEntry[] | undefined {
  if (event.repositoryKey !== "policy") {
    return undefined;
  }
  return collectPolicyResetDiffEntries(event.parsedValue, event.restoredValue ?? DEFAULT_POLICY)
    .filter((entry) => entry.path !== "(root)");
}

function buildPolicyResetDiffLines(diffEntries: PolicyResetDiffEntry[] | undefined): string[] {
  if (!diffEntries) {
    return [];
  }
  if (diffEntries.length === 0) {
    return ["復旧差分: none"];
  }
  const visibleEntries = diffEntries.slice(0, 8);
  const lines = [
    "復旧差分:",
    ...visibleEntries.map((entry) => `- ${entry.path}: ${entry.previous} -> ${entry.restored}`),
  ];
  if (diffEntries.length > visibleEntries.length) {
    lines.push(`- ... ${diffEntries.length - visibleEntries.length} more`);
  }
  return lines;
}

function buildRecoverySourceLines(event: ManagerStateRecoveryEvent): string[] {
  if (!event.restoredFrom) {
    return [];
  }
  const lines = [`復旧元: ${event.restoredFrom}`];
  if (event.restoredPath) {
    lines.push(`restoredPath: ${event.restoredPath}`);
  }
  return lines;
}

function isProductionStatePath(path: string): boolean {
  return path.startsWith("/workspace/system/");
}

export function createStateRecoveryNotifier(args: {
  logger: Logger;
  webClient: WebClient;
  config: AppConfig;
  getControlRoomChannel: () => string | undefined;
}): (event: ManagerStateRecoveryEvent) => Promise<void> {
  return async (event: ManagerStateRecoveryEvent): Promise<void> => {
    const policyResetDiff = buildPolicyResetDiff(event);
    args.logger.error("Recovered invalid manager state file", {
      repositoryKey: event.repositoryKey,
      path: event.path,
      backupPath: event.backupPath,
      errorType: event.errorType,
      error: event.errorMessage,
      policyResetDiff,
    });

    const controlRoomChannelId = args.getControlRoomChannel()?.trim();
    if (!controlRoomChannelId) {
      args.logger.warn("Skipped state recovery control-room notification", {
        repositoryKey: event.repositoryKey,
        reason: "missing-control-room-channel",
      });
      return;
    }

    const reply = [
      "system state を自動復旧しました。",
      ...(isProductionStatePath(event.path) ? [] : ["検証: test notification"]),
      `対象: ${event.repositoryKey} (${basename(event.path)})`,
      `原因: ${event.errorType === "syntax" ? "JSON parse error" : "schema validation error"}`,
      `path: ${event.path}`,
      `backup: ${event.backupPath ?? "unavailable"}`,
      ...buildRecoverySourceLines(event),
      `error: ${event.errorMessage}`,
      ...buildPolicyResetDiffLines(policyResetDiff),
    ].join("\n");

    try {
      await sendSlackReply(args.webClient, {
        channel: controlRoomChannelId,
        reply,
        linearWorkspace: args.config.linearWorkspace,
      });
      args.logger.info("Posted state recovery notice to control room", {
        repositoryKey: event.repositoryKey,
        controlRoomChannelId,
      });
    } catch (error) {
      args.logger.warn("Failed to post state recovery notice to control room", {
        repositoryKey: event.repositoryKey,
        controlRoomChannelId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
