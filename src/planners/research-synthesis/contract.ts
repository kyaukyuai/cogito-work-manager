export interface ResearchSynthesisInput {
  channelId: string;
  rootThreadTs: string;
  taskTitle: string;
  sourceMessage: string;
  slackThreadSummary: string;
  recentChannelSummary: string;
  relatedIssuesSummary: string;
  webSummary: string;
  taskKey?: string;
}

export interface ResearchNextAction {
  title: string;
  purpose: string;
  ownerHint?: string;
  confidence: number;
}

export interface ResearchSynthesisResult {
  findings: string[];
  uncertainties: string[];
  nextActions: ResearchNextAction[];
}
