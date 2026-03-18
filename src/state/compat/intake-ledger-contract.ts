import { z } from "zod";

const compatIssueFocusEntrySchema = z.object({
  issueId: z.string().min(1),
  actionKind: z.string().min(1),
  source: z.string().min(1),
  ts: z.string().datetime(),
  textSnippet: z.string().optional(),
});

export const compatIntakeLedgerEntrySchema = z.object({
  sourceChannelId: z.string().min(1),
  sourceThreadTs: z.string().min(1),
  sourceMessageTs: z.string().min(1),
  messageFingerprint: z.string().min(1),
  parentIssueId: z.string().optional(),
  childIssueIds: z.array(z.string()).default([]),
  status: z.string().min(1),
  ownerResolution: z.enum(["mapped", "fallback"]).optional(),
  originalText: z.string().optional(),
  clarificationQuestion: z.string().optional(),
  clarificationReasons: z.array(z.string()).default([]),
  lastResolvedIssueId: z.string().optional(),
  issueFocusHistory: z.array(compatIssueFocusEntrySchema).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const compatIntakeLedgerSchema = z.array(compatIntakeLedgerEntrySchema);

export type CompatIntakeLedgerEntry = z.infer<typeof compatIntakeLedgerEntrySchema>;
