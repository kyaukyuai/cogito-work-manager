import type { Logger } from "./logger.js";
import type { SystemPaths } from "./system-workspace.js";
import { listActiveChannels, readHeartbeatInstructions } from "./system-workspace.js";

export interface HeartbeatExecutionContext {
  channelId: string;
  prompt: string;
}

export interface HeartbeatExecutionResult {
  reply: string;
  status: "posted" | "noop";
  reason?: "outside-business-hours" | "no-active-channels" | "no-urgent-items" | "suppressed-by-cooldown";
}

export interface ParsedHeartbeatReply {
  status: "posted" | "noop";
  reply: string;
  reason?: "outside-business-hours" | "no-active-channels" | "no-urgent-items" | "suppressed-by-cooldown";
}

export interface HeartbeatServiceOptions {
  logger: Logger;
  workspaceDir: string;
  systemPaths: SystemPaths;
  allowedChannelIds: Set<string>;
  intervalMin: number;
  activeLookbackHours: number;
  executeHeartbeat: (context: HeartbeatExecutionContext) => Promise<HeartbeatExecutionResult>;
}

export const DEFAULT_HEARTBEAT_PROMPT = [
  "You are running a periodic heartbeat for this Slack channel.",
  "Review the current Linear task situation using the available Linear tools.",
  "Return at most one issue-centric update.",
  "Only post when there is one short actionable update worth the team's attention right now.",
  "If you post, include: the issue ID, what is wrong now, and what the team should reply with in the control room.",
  "Only consider overdue, due today, blocked, or important stale work.",
  "Keep the reply short and in Japanese.",
  "If there is nothing worth broadcasting, reply with exactly HEARTBEAT_OK.",
].join("\n");

export function parseHeartbeatManagerReply(reply: string): ParsedHeartbeatReply {
  const normalized = reply.trim();
  if (normalized === "HEARTBEAT_OK") {
    return {
      status: "noop",
      reply: "heartbeat noop: no-urgent-items",
      reason: "no-urgent-items",
    };
  }

  if (normalized.startsWith("heartbeat noop:")) {
    const rawReason = normalized.replace("heartbeat noop:", "").trim();
    const reason = (
      rawReason === "outside-business-hours"
      || rawReason === "no-active-channels"
      || rawReason === "suppressed-by-cooldown"
    ) ? rawReason : "no-urgent-items";
    return {
      status: "noop",
      reply: normalized,
      reason,
    };
  }

  return {
    status: "posted",
    reply,
  };
}

export class HeartbeatService {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private intervalMin: number;
  private activeLookbackHours: number;

  constructor(private readonly options: HeartbeatServiceOptions) {
    this.intervalMin = options.intervalMin;
    this.activeLookbackHours = options.activeLookbackHours;
  }

  async start(): Promise<void> {
    if (this.intervalMin <= 0) return;

    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMin * 60 * 1000);
    this.timer.unref();
  }

  async reconfigure(next: {
    intervalMin: number;
    activeLookbackHours: number;
  }): Promise<void> {
    this.stop();
    this.intervalMin = next.intervalMin;
    this.activeLookbackHours = next.activeLookbackHours;
    await this.start();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const instructions = (await readHeartbeatInstructions(this.options.systemPaths)) ?? DEFAULT_HEARTBEAT_PROMPT;
      const activeChannels = await listActiveChannels(
        this.options.workspaceDir,
        this.options.allowedChannelIds,
        this.activeLookbackHours * 60 * 60 * 1000,
      );

      if (activeChannels.length === 0) {
        this.options.logger.info("Heartbeat noop", {
          status: "noop",
          reason: "no-active-channels",
        });
        return;
      }

      for (const channelId of activeChannels) {
        try {
          const result = await this.options.executeHeartbeat({
            channelId,
            prompt: instructions,
          });

          if (result.status === "noop") {
            this.options.logger.info("Heartbeat noop", {
              channelId,
              status: "noop",
              reason: result.reason ?? "no-urgent-items",
            });
            continue;
          }

          this.options.logger.info("Heartbeat posted", {
            channelId,
            status: "posted",
          });
        } catch (error) {
          this.options.logger.error("Heartbeat failed", {
            channelId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
