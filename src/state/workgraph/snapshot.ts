import { z } from "zod";

const workgraphIssueProjectionSchema = z.object({
  issueId: z.string().min(1),
  title: z.string().optional(),
  kind: z.enum(["parent", "execution", "research"]).optional(),
  parentIssueId: z.string().min(1).optional(),
  dueDate: z.string().optional(),
  assignee: z.string().optional(),
  threadKeys: z.array(z.string().min(1)),
  lastStatus: z.enum(["progress", "completed", "blocked"]).optional(),
  lastStatusAt: z.string().datetime().optional(),
  followupStatus: z.enum(["awaiting-response", "resolved"]).optional(),
  lastFollowupCategory: z.string().optional(),
  lastFollowupRequestedAt: z.string().datetime().optional(),
  lastFollowupResolvedAt: z.string().datetime().optional(),
  lastFollowupResolvedReason: z.enum(["response", "risk-cleared", "completed", "answered"]).optional(),
});

const workgraphThreadProjectionSchema = z.object({
  threadKey: z.string().min(1),
  sourceChannelId: z.string().min(1).optional(),
  sourceThreadTs: z.string().min(1).optional(),
  sourceMessageTs: z.string().min(1).optional(),
  messageFingerprint: z.string().min(1).optional(),
  originalText: z.string().optional(),
  clarificationQuestion: z.string().optional(),
  clarificationReasons: z.array(z.string()),
  clarificationRequestedAt: z.string().datetime().optional(),
  lastEventAt: z.string().datetime().optional(),
  intakeStatus: z.enum(["needs-clarification", "linked-existing", "created"]).optional(),
  pendingClarification: z.boolean(),
  parentIssueId: z.string().min(1).optional(),
  childIssueIds: z.array(z.string().min(1)),
  linkedIssueIds: z.array(z.string().min(1)),
  planningReason: z.string().optional(),
  lastResolvedIssueId: z.string().min(1).optional(),
  latestFocusIssueId: z.string().min(1).optional(),
  awaitingFollowupIssueIds: z.array(z.string().min(1)),
  issueStatuses: z.record(z.string(), z.enum(["progress", "completed", "blocked"])),
});

export const workgraphProjectionSchema = z.object({
  issues: z.record(z.string(), workgraphIssueProjectionSchema),
  threads: z.record(z.string(), workgraphThreadProjectionSchema),
});

export const workgraphSnapshotSchema = z.object({
  version: z.literal(1),
  eventCount: z.number().int().nonnegative(),
  lastEventId: z.string().uuid().optional(),
  lastOccurredAt: z.string().datetime().optional(),
  projection: workgraphProjectionSchema,
});

export type WorkgraphSnapshot = z.infer<typeof workgraphSnapshotSchema>;

export const EMPTY_WORKGRAPH_SNAPSHOT: WorkgraphSnapshot = {
  version: 1,
  eventCount: 0,
  projection: {
    issues: {},
    threads: {},
  },
};
