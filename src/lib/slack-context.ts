import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { buildThreadPaths, type LogEntry } from "./thread-workspace.js";

export interface SlackThreadLogEntry extends LogEntry {
  createdAt?: string;
}

export interface SlackThreadContext {
  channelId: string;
  rootThreadTs: string;
  entries: SlackThreadLogEntry[];
}

async function readLogFile(logFile: string): Promise<SlackThreadLogEntry[]> {
  try {
    const raw = await readFile(logFile, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SlackThreadLogEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function getSlackThreadContext(
  workspaceDir: string,
  channelId: string,
  rootThreadTs: string,
  limit = 50,
): Promise<SlackThreadContext> {
  const paths = buildThreadPaths(workspaceDir, channelId, rootThreadTs);
  const entries = await readLogFile(paths.logFile);
  return {
    channelId,
    rootThreadTs,
    entries: entries.slice(-Math.max(1, limit)),
  };
}

export async function getRecentChannelContext(
  workspaceDir: string,
  channelId: string,
  limit = 5,
  messagesPerThread = 10,
): Promise<SlackThreadContext[]> {
  const channelRoot = join(workspaceDir, "threads", channelId);
  try {
    const threadDirs = await readdir(channelRoot, { withFileTypes: true });
    const candidates = await Promise.all(threadDirs
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const logFile = join(channelRoot, entry.name, "log.jsonl");
        try {
          const details = await stat(logFile);
          return {
            safeThreadTs: entry.name,
            mtimeMs: details.mtimeMs,
            logFile,
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
          }
          throw error;
        }
      }));

    const recent = candidates
      .filter(Boolean)
      .sort((left, right) => (right?.mtimeMs ?? 0) - (left?.mtimeMs ?? 0))
      .slice(0, Math.max(1, limit));

    const contexts = await Promise.all(recent.map(async (entry) => {
      const entries = await readLogFile(entry!.logFile);
      return {
        channelId,
        rootThreadTs: entry!.safeThreadTs.replace(/_/g, "."),
        entries: entries.slice(-Math.max(1, messagesPerThread)),
      };
    }));

    return contexts;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
