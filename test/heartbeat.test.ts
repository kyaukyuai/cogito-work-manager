import { describe, expect, it } from "vitest";
import { parseHeartbeatManagerReply } from "../src/lib/heartbeat.js";

describe("parseHeartbeatManagerReply", () => {
  it("treats HEARTBEAT_OK as an internal noop token", () => {
    expect(parseHeartbeatManagerReply("HEARTBEAT_OK")).toEqual({
      status: "noop",
      reply: "heartbeat noop: no-urgent-items",
      reason: "no-urgent-items",
    });
  });

  it("keeps explicit heartbeat noop reasons", () => {
    expect(parseHeartbeatManagerReply("heartbeat noop: suppressed-by-cooldown")).toEqual({
      status: "noop",
      reply: "heartbeat noop: suppressed-by-cooldown",
      reason: "suppressed-by-cooldown",
    });
  });

  it("passes through normal posted replies", () => {
    expect(parseHeartbeatManagerReply("AIC-38 を確認してください。")).toEqual({
      status: "posted",
      reply: "AIC-38 を確認してください。",
    });
  });
});
