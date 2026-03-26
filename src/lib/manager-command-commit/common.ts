import {
  type CommitManagerCommandArgs,
  type ManagerCommandProposal,
  type ManagerCommitMessageContext,
} from "./contracts.js";

export function dedupeProposalKey(proposal: ManagerCommandProposal): string {
  return proposal.dedupeKeyCandidate
    ?? JSON.stringify({
      commandType: proposal.commandType,
      proposal,
    });
}

export function unique<T>(values: Array<T | undefined>): T[] {
  return Array.from(new Set(values.filter((value): value is T => value !== undefined)));
}

export function buildOccurredAt(now: Date): string {
  return now.toISOString();
}

export function isMessageContext(
  value: CommitManagerCommandArgs["message"],
): value is ManagerCommitMessageContext {
  return "userId" in value;
}
