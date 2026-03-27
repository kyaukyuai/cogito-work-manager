import type { WorkgraphProjection } from "./projection.js";
import type { WorkgraphSnapshot } from "./snapshot.js";

export interface WorkgraphHealthPolicy {
  warnActiveLogEvents: number;
  autoCompactMaxActiveLogEvents: number;
}

export type WorkgraphHealthReasonCode =
  | "snapshot-invalid"
  | "snapshot-ahead-of-log"
  | "active-log-warning"
  | "compact-recommended";

export interface WorkgraphHealthReason {
  code: WorkgraphHealthReasonCode;
  severity: "warning" | "recovery-required";
  summary: string;
}

export interface WorkgraphHealth {
  status: "ok" | "warning" | "recovery-required";
  snapshotEventCount: number;
  compactedEventCount: number;
  activeLogEventCount: number;
  snapshottedActiveLogEventCount: number;
  replayTailEventCount: number;
  issueCount: number;
  threadCount: number;
  lastOccurredAt?: string;
  snapshotInvalid: boolean;
  snapshotAheadOfLog: boolean;
  compactRecommended: boolean;
  warnActiveLogEvents: number;
  autoCompactMaxActiveLogEvents: number;
  eventsUntilWarning: number;
  eventsUntilAutoCompact: number;
  reasons: WorkgraphHealthReason[];
  recommendedAction: "observe" | "compact" | "recover";
  operatorSummary: string;
}

export function assessWorkgraphHealth(
  snapshot: WorkgraphSnapshot,
  activeLogEventCount: number,
  projection: WorkgraphProjection,
  policy: WorkgraphHealthPolicy,
): WorkgraphHealth {
  const snapshotInvalid = snapshot.compactedEventCount > snapshot.eventCount;
  const replayOffset = snapshotInvalid ? 0 : Math.max(0, snapshot.eventCount - snapshot.compactedEventCount);
  const snapshotAheadOfLog = replayOffset > activeLogEventCount;
  const snapshottedActiveLogEventCount = snapshotAheadOfLog
    ? activeLogEventCount
    : Math.min(activeLogEventCount, replayOffset);
  const replayTailEventCount = snapshotAheadOfLog
    ? 0
    : Math.max(0, activeLogEventCount - snapshottedActiveLogEventCount);
  const compactRecommended = activeLogEventCount >= policy.autoCompactMaxActiveLogEvents;
  const warning = compactRecommended || activeLogEventCount >= policy.warnActiveLogEvents;
  const eventsUntilWarning = Math.max(0, policy.warnActiveLogEvents - activeLogEventCount);
  const eventsUntilAutoCompact = Math.max(0, policy.autoCompactMaxActiveLogEvents - activeLogEventCount);
  const reasons: WorkgraphHealthReason[] = [];

  if (snapshotInvalid) {
    reasons.push({
      code: "snapshot-invalid",
      severity: "recovery-required",
      summary: "snapshot compactedEventCount exceeds snapshot eventCount.",
    });
  }
  if (snapshotAheadOfLog) {
    reasons.push({
      code: "snapshot-ahead-of-log",
      severity: "recovery-required",
      summary: "snapshot expects more replay tail events than the active log currently contains.",
    });
  }
  if (compactRecommended) {
    reasons.push({
      code: "compact-recommended",
      severity: "warning",
      summary: `active log reached the auto-compaction threshold (${policy.autoCompactMaxActiveLogEvents}).`,
    });
  } else if (warning) {
    reasons.push({
      code: "active-log-warning",
      severity: "warning",
      summary: `active log reached the warning threshold (${policy.warnActiveLogEvents}).`,
    });
  }

  const recommendedAction = snapshotInvalid || snapshotAheadOfLog
    ? "recover"
    : compactRecommended
      ? "compact"
      : "observe";
  const operatorSummary = recommendedAction === "recover"
    ? "Recovery is required before trusting the current workgraph snapshot."
    : recommendedAction === "compact"
      ? "Compaction is recommended now because the active event log has reached the configured threshold."
      : warning
        ? "Workgraph is still readable, but the active event log is growing and should be watched."
        : "Workgraph health is OK. No maintenance action is required now.";

  return {
    status: snapshotInvalid || snapshotAheadOfLog
      ? "recovery-required"
      : warning
        ? "warning"
        : "ok",
    snapshotEventCount: snapshot.eventCount,
    compactedEventCount: snapshot.compactedEventCount,
    activeLogEventCount,
    snapshottedActiveLogEventCount,
    replayTailEventCount,
    issueCount: Object.keys(projection.issues).length,
    threadCount: Object.keys(projection.threads).length,
    lastOccurredAt: snapshot.lastOccurredAt,
    snapshotInvalid,
    snapshotAheadOfLog,
    compactRecommended,
    warnActiveLogEvents: policy.warnActiveLogEvents,
    autoCompactMaxActiveLogEvents: policy.autoCompactMaxActiveLogEvents,
    eventsUntilWarning,
    eventsUntilAutoCompact,
    reasons,
    recommendedAction,
    operatorSummary,
  };
}
