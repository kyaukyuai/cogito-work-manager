import { z } from "zod";

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
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const compatIntakeLedgerSchema = z.array(compatIntakeLedgerEntrySchema);

export type CompatIntakeLedgerEntry = z.infer<typeof compatIntakeLedgerEntrySchema>;
