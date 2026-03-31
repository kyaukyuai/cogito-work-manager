import { z } from "zod";

export const otherDirectedMessageClassificationSchema = z.enum([
  "to_other_person",
  "to_cogito",
  "unclear",
]);

export const otherDirectedMessageSignalFamilySchema = z.enum([
  "line-opener",
  "directed-verb",
  "repeated-target",
]);

export const otherDirectedMessageOwnerCandidateSchema = z.object({
  entryId: z.string().trim().min(1),
  label: z.string().trim().min(1),
  slackUserId: z.string().trim().min(1).optional(),
  matchSource: z.enum(["id", "linearAssignee", "keyword"]),
  matchedSignalFamilies: z.array(otherDirectedMessageSignalFamilySchema).default([]),
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

export interface OtherDirectedMessageOwnerCandidate {
  entryId: string;
  label: string;
  slackUserId?: string;
  matchSource: "id" | "linearAssignee" | "keyword";
  matchedSignalFamilies: Array<"line-opener" | "directed-verb" | "repeated-target">;
}

export interface OtherDirectedMessageInput {
  messageText: string;
  signalFamilies: Array<"line-opener" | "directed-verb" | "repeated-target">;
  ownerCandidates: OtherDirectedMessageOwnerCandidate[];
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
