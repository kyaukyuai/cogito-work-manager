import { describe, expect, it, vi } from "vitest";
import { createStateRecoveryNotifier } from "../src/runtime/state-recovery-notifier.js";

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as never;
}

function createWebClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: "123.456" }),
      update: vi.fn().mockResolvedValue({}),
    },
  } as never;
}

describe("state recovery notifier", () => {
  it("logs and posts a control-room notice for recovered state", async () => {
    const logger = createLogger();
    const webClient = createWebClient();
    const notify = createStateRecoveryNotifier({
      logger,
      webClient,
      config: {
        linearWorkspace: "kyaukyuai",
      } as never,
      getControlRoomChannel: () => "CROOM",
    });

    await notify({
      repositoryKey: "policy",
      path: "/workspace/system/policy.json",
      backupPath: "/workspace/system/policy.json.corrupt-1",
      errorType: "schema",
      errorMessage: "expected string, received number",
      parsedValue: {
        controlRoomChannelId: 1,
      },
      restoredFrom: "last-known-good",
      restoredPath: "/workspace/system/policy.json.last-known-good",
      restoredValue: {
        controlRoomChannelId: "C0ALAMDRB9V",
      },
    });

    expect(logger.error).toHaveBeenCalledWith("Recovered invalid manager state file", expect.objectContaining({
      repositoryKey: "policy",
      path: "/workspace/system/policy.json",
      errorType: "schema",
      policyResetDiff: expect.arrayContaining([
        expect.objectContaining({
          path: "controlRoomChannelId",
          previous: "1",
          restored: "\"C0ALAMDRB9V\"",
        }),
      ]),
    }));
    expect(webClient.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "CROOM",
      text: expect.stringContaining("system state を自動復旧しました。"),
    }));
    expect(webClient.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("復旧元: last-known-good"),
    }));
    expect(webClient.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("restoredPath: /workspace/system/policy.json.last-known-good"),
    }));
    expect(webClient.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("復旧差分:"),
    }));
    expect(webClient.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("controlRoomChannelId: 1 -> \"C0ALAMDRB9V\""),
      blocks: expect.any(Array),
    }));
    expect(logger.info).toHaveBeenCalledWith("Posted state recovery notice to control room", expect.objectContaining({
      repositoryKey: "policy",
      controlRoomChannelId: "CROOM",
    }));
  });

  it("logs a skip warning when no control-room channel is available", async () => {
    const logger = createLogger();
    const webClient = createWebClient();
    const notify = createStateRecoveryNotifier({
      logger,
      webClient,
      config: {
        linearWorkspace: "kyaukyuai",
      } as never,
      getControlRoomChannel: () => "",
    });

    await notify({
      repositoryKey: "followups",
      path: "/tmp/followups.json",
      backupPath: "/workspace/system/followups.json.corrupt-1",
      errorType: "syntax",
      errorMessage: "Unexpected token",
    });

    expect(webClient.chat.postMessage).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith("Recovered invalid manager state file", expect.objectContaining({
      repositoryKey: "followups",
      errorType: "syntax",
    }));
    expect(logger.warn).toHaveBeenCalledWith("Skipped state recovery control-room notification", expect.objectContaining({
      repositoryKey: "followups",
      reason: "missing-control-room-channel",
    }));
  });
});
