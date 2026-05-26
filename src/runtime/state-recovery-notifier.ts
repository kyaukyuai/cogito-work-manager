import type { WebClient } from "@slack/web-api";
import { basename } from "node:path";
import type { AppConfig } from "../lib/config.js";
import type { Logger } from "../lib/logger.js";
import { sendSlackReply } from "../lib/slack-replies.js";
import type { ManagerStateRecoveryEvent } from "../state/repositories/file-backed-manager-repositories.js";

export function createStateRecoveryNotifier(args: {
  logger: Logger;
  webClient: WebClient;
  config: AppConfig;
  getControlRoomChannel: () => string | undefined;
}): (event: ManagerStateRecoveryEvent) => Promise<void> {
  return async (event: ManagerStateRecoveryEvent): Promise<void> => {
    args.logger.warn("Recovered invalid manager state file", {
      repositoryKey: event.repositoryKey,
      path: event.path,
      backupPath: event.backupPath,
      errorType: event.errorType,
      error: event.errorMessage,
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
      `対象: ${event.repositoryKey} (${basename(event.path)})`,
      `原因: ${event.errorType === "syntax" ? "JSON parse error" : "schema validation error"}`,
      `path: ${event.path}`,
      `backup: ${event.backupPath ?? "unavailable"}`,
      `error: ${event.errorMessage}`,
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
