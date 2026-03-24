export interface FollowupResolutionInput {
  issueId: string;
  issueTitle: string;
  requestKind: "status" | "blocked-details" | "owner" | "due-date";
  requestText: string;
  acceptableAnswerHint?: string;
  responseText: string;
  workspaceAgents?: string;
  workspaceMemory?: string;
  taskKey?: string;
}

export interface FollowupResolutionResult {
  answered: boolean;
  answerKind?: string;
  confidence: number;
  extractedFields?: Record<string, string>;
  reasoningSummary?: string;
}
