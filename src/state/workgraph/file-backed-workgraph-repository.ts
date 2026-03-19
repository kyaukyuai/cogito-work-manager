import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SystemPaths } from "../../lib/system-workspace.js";
import {
  createWorkgraphEvent,
  workgraphEventSchema,
  type WorkgraphEvent,
  type WorkgraphEventInput,
} from "./events.js";
import { projectWorkgraph, type WorkgraphProjection } from "./projection.js";
import {
  EMPTY_WORKGRAPH_SNAPSHOT,
  workgraphSnapshotSchema,
  type WorkgraphSnapshot,
} from "./snapshot.js";

export interface WorkgraphRepository {
  list(): Promise<WorkgraphEvent[]>;
  append(events: WorkgraphEventInput | WorkgraphEventInput[]): Promise<WorkgraphEvent[]>;
  project(): Promise<WorkgraphProjection>;
  loadSnapshot(): Promise<WorkgraphSnapshot>;
  rebuildSnapshot(): Promise<WorkgraphSnapshot>;
}

export function createFileBackedWorkgraphRepository(paths: SystemPaths): WorkgraphRepository {
  const list = async (): Promise<WorkgraphEvent[]> => {
    try {
      const raw = await readFile(paths.workgraphEventsFile, "utf8");
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => workgraphEventSchema.parse(JSON.parse(line)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  };

  const loadSnapshot = async (): Promise<WorkgraphSnapshot> => {
    try {
      const raw = await readFile(paths.workgraphSnapshotFile, "utf8");
      return workgraphSnapshotSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return EMPTY_WORKGRAPH_SNAPSHOT;
      }
      throw error;
    }
  };

  return {
    list,
    async append(events: WorkgraphEventInput | WorkgraphEventInput[]): Promise<WorkgraphEvent[]> {
      const normalized = Array.isArray(events) ? events : [events];
      if (normalized.length === 0) {
        return [];
      }

      const persisted = normalized.map((event) => createWorkgraphEvent(event));
      await mkdir(dirname(paths.workgraphEventsFile), { recursive: true });
      await appendFile(
        paths.workgraphEventsFile,
        `${persisted.map((event) => JSON.stringify(event)).join("\n")}\n`,
        "utf8",
      );
      return persisted;
    },
    loadSnapshot,
    async project(): Promise<WorkgraphProjection> {
      const [snapshot, events] = await Promise.all([loadSnapshot(), list()]);
      if (snapshot.eventCount > events.length) {
        return projectWorkgraph(events);
      }
      if (snapshot.eventCount === events.length) {
        return projectWorkgraph([], snapshot);
      }
      return projectWorkgraph(events.slice(snapshot.eventCount), snapshot);
    },
    async rebuildSnapshot(): Promise<WorkgraphSnapshot> {
      const events = await list();
      const projection = projectWorkgraph(events);
      const snapshot: WorkgraphSnapshot = {
        version: 1,
        eventCount: events.length,
        lastEventId: events.at(-1)?.id,
        lastOccurredAt: events.at(-1)?.occurredAt,
        projection,
      };
      await mkdir(dirname(paths.workgraphSnapshotFile), { recursive: true });
      await writeFile(paths.workgraphSnapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      return snapshot;
    },
  };
}
