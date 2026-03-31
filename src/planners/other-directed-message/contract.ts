import { z } from "zod";

export const otherDirectedMessageClassificationSchema = z.enum([
  "to_other_person",
  "to_cogito",
  "unclear",
]);

export const otherDirectedMessageRecentThreadEntrySchema = z.object({
  userId: z.string().trim().min(1).optional(),
  text: z.string().trim().min(1),
});

export const otherDirectedMessageOwnerEntrySchema = z.object({
  entryId: z.string().trim().min(1),
  linearAssignee: z.string().trim().min(1),
  keywords: z.array(z.string().trim().min(1)).default([]),
  slackUserId: z.string().trim().min(1).optional(),
});

export const otherDirectedMessageReplySchema = z.object({
  classification: otherDirectedMessageClassificationSchema,
  confidence: z.number().min(0).max(1),
  selectedOwnerEntryId: z.string().trim().min(1).optional(),
  reasoningSummary: z.string().trim().min(1),
}).superRefine((value, ctx) => {
  if (value.classification !== "to_other_person" && value.selectedOwnerEntryId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["selectedOwnerEntryId"],
      message: "selectedOwnerEntryId is allowed only when classification=to_other_person",
    });
  }
});

export interface OtherDirectedMessageRecentThreadEntry {
  userId?: string;
  text: string;
}

export interface OtherDirectedMessageOwnerEntry {
  entryId: string;
  linearAssignee: string;
  keywords: string[];
  slackUserId?: string;
}

export interface OtherDirectedMessageInput {
  messageText: string;
  recentThreadEntries: OtherDirectedMessageRecentThreadEntry[];
  ownerEntries: OtherDirectedMessageOwnerEntry[];
  assistantName: string;
  workspaceAgents?: string;
  workspaceMemory?: string;
  taskKey?: string;
}

export interface OtherDirectedMessageResult {
  classification: "to_other_person" | "to_cogito" | "unclear";
  confidence: number;
  selectedOwnerEntryId?: string;
  reasoningSummary: string;
}
