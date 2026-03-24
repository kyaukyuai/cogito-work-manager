import { z } from "zod";

export const managerReplyKindSchema = z.enum([
  "conversation",
  "list-active",
  "list-today",
  "what-should-i-do",
  "inspect-work",
  "search-existing",
  "recommend-next-step",
]);

export const managerReplySchema = z.object({
  reply: z.string().trim().min(1),
});

export interface ManagerReplyInput {
  kind: "conversation" | "list-active" | "list-today" | "what-should-i-do" | "inspect-work" | "search-existing" | "recommend-next-step";
  currentDate: string;
  messageText: string;
  workspaceAgents?: string;
  workspaceMemory?: string;
  queryScope?: "self" | "team" | "thread-context";
  conversationKind?: "greeting" | "smalltalk" | "other";
  facts: Record<string, unknown>;
  taskKey?: string;
}

export interface ManagerReplyResult {
  reply: string;
}
