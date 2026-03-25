import type { AppConfig } from "../../lib/config.js";
import { getLinearIssue, listRiskyLinearIssues } from "../../lib/linear.js";
import {
  type FollowupLedgerEntry,
  type ManagerPolicy,
  type OwnerMap,
  type PlanningLedgerEntry,
} from "../../state/manager-state-contract.js";
import type { ManagerRepositories } from "../../state/repositories/file-backed-manager-repositories.js";
import {
  buildIssueSourceIndex,
  listAwaitingFollowups,
  listPendingClarifications,
} from "../../state/workgraph/queries.js";
import { recordFollowupTransitions } from "../../state/workgraph/recorder.js";
import type { ManagerFollowupSource } from "./contract.js";
import type { RiskAssessment } from "./contract.js";
import { assessRisk, issueMatchesCompletedState } from "./risk.js";

export interface ManagerReviewData {
  policy: ManagerPolicy;
  ownerMap: OwnerMap;
  followups: FollowupLedgerEntry[];
  planningLedger: PlanningLedgerEntry[];
  pendingClarificationCount: number;
  awaitingFollowupCount: number;
  issueSources: Record<string, ManagerFollowupSource>;
  risky: RiskAssessment[];
}

type ReviewRepositories = Pick<ManagerRepositories, "policy" | "followups" | "workgraph">;

function resolveFollowupEntry(
  entry: FollowupLedgerEntry,
  now: Date,
  reason: "response" | "risk-cleared" | "completed" | "answered",
): FollowupLedgerEntry {
  return {
    ...entry,
    status: "resolved",
    resolvedAt: now.toISOString(),
    resolvedReason: reason,
  };
}

function followupStillNeedsResponse(
  entry: FollowupLedgerEntry,
  current: RiskAssessment,
): boolean {
  if (entry.lastCategory === "owner_missing") {
    return current.ownerMissing;
  }
  if (entry.lastCategory === "due_missing") {
    return current.dueMissing;
  }
  if (entry.lastCategory === "blocked") {
    return current.blocked;
  }

  const statusCategories = new Set(["overdue", "due_today", "due_soon", "stale"]);
  if (entry.lastCategory && statusCategories.has(entry.lastCategory)) {
    return current.riskCategories.some((category) => statusCategories.has(category));
  }

  if (!entry.lastCategory) {
    return current.riskCategories.length > 0;
  }

  return current.riskCategories.includes(entry.lastCategory);
}

async function reconcileFollowupsWithCurrentLinearState(
  followups: FollowupLedgerEntry[],
  policy: ManagerPolicy,
  env: Record<string, string | undefined>,
  now: Date,
): Promise<{ changed: boolean; followups: FollowupLedgerEntry[] }> {
  let changed = false;

  const next = await Promise.all(followups.map(async (entry) => {
    if (entry.status !== "awaiting-response") {
      return entry;
    }

    try {
      const currentIssue = await getLinearIssue(entry.issueId, env);
      if (issueMatchesCompletedState(currentIssue)) {
        changed = true;
        return resolveFollowupEntry(entry, now, "completed");
      }

      const currentRisk = assessRisk(currentIssue, policy, now);
      if (!followupStillNeedsResponse(entry, currentRisk)) {
        changed = true;
        return resolveFollowupEntry(entry, now, "risk-cleared");
      }
    } catch {
      return entry;
    }

    return entry;
  }));

  return { changed, followups: next };
}

function reconcileFollowupsWithRiskyIssues(
  followups: FollowupLedgerEntry[],
  risky: RiskAssessment[],
  now: Date,
): { changed: boolean; followups: FollowupLedgerEntry[] } {
  const riskyByIssueId = new Map(risky.map((item) => [item.issue.identifier, item]));
  let changed = false;
  const next = followups.map((entry) => {
    if (entry.status !== "awaiting-response") {
      return entry;
    }

    const current = riskyByIssueId.get(entry.issueId);
    if (!current) {
      changed = true;
      return resolveFollowupEntry(entry, now, "risk-cleared");
    }

    if (issueMatchesCompletedState(current.issue)) {
      changed = true;
      return resolveFollowupEntry(entry, now, "completed");
    }

    if (entry.lastCategory === "owner_missing" && !current.ownerMissing) {
      changed = true;
      return resolveFollowupEntry(entry, now, "risk-cleared");
    }

    if (entry.lastCategory === "due_missing" && !current.dueMissing) {
      changed = true;
      return resolveFollowupEntry(entry, now, "risk-cleared");
    }

    if (entry.lastCategory === "blocked" && !current.blocked) {
      changed = true;
      return resolveFollowupEntry(entry, now, "risk-cleared");
    }

    return entry;
  });

  return { changed, followups: next };
}

export async function reconcileAwaitingFollowupsWithCurrentLinear(
  config: AppConfig,
  repositories: ReviewRepositories,
  now: Date,
): Promise<{ changed: boolean; followups: FollowupLedgerEntry[] }> {
  const policy = await repositories.policy.load();
  const followups = await repositories.followups.load();
  const env = {
    ...process.env,
    LINEAR_API_KEY: config.linearApiKey,
    LINEAR_WORKSPACE: config.linearWorkspace,
    LINEAR_TEAM_KEY: config.linearTeamKey,
  };

  const reconciled = await reconcileFollowupsWithCurrentLinearState(
    followups,
    policy,
    env,
    now,
  );

  if (reconciled.changed) {
    await repositories.followups.save(reconciled.followups);
    await recordFollowupTransitions(repositories.workgraph, followups, reconciled.followups, {
      occurredAt: now.toISOString(),
    });
  }

  return reconciled;
}

export async function loadManagerReviewData(
  config: AppConfig,
  repositories: Pick<ManagerRepositories, "policy" | "ownerMap" | "followups" | "planning" | "workgraph">,
  now: Date,
): Promise<ManagerReviewData> {
  const initialPolicy = await repositories.policy.load();
  const ownerMap = await repositories.ownerMap.load();
  const planningLedger = await repositories.planning.load();
  const pendingClarificationCount = (await listPendingClarifications(repositories.workgraph)).length;
  const env = {
    ...process.env,
    LINEAR_API_KEY: config.linearApiKey,
    LINEAR_WORKSPACE: config.linearWorkspace,
    LINEAR_TEAM_KEY: config.linearTeamKey,
  };

  const reconciledWithLinear = await reconcileFollowupsWithCurrentLinearState(
    await repositories.followups.load(),
    initialPolicy,
    env,
    now,
  );
  if (reconciledWithLinear.changed) {
    const previousFollowups = await repositories.followups.load();
    await repositories.followups.save(reconciledWithLinear.followups);
    await recordFollowupTransitions(repositories.workgraph, previousFollowups, reconciledWithLinear.followups, {
      occurredAt: now.toISOString(),
    });
  }

  const risky = (await listRiskyLinearIssues(
    {
      staleBusinessDays: initialPolicy.staleBusinessDays,
      urgentPriorityThreshold: initialPolicy.urgentPriorityThreshold,
    },
    env,
  )).map((issue) => assessRisk(issue, initialPolicy, now)).filter((item) => item.riskCategories.length > 0);

  const reconciled = reconcileFollowupsWithRiskyIssues(reconciledWithLinear.followups, risky, now);
  if (reconciled.changed) {
    await repositories.followups.save(reconciled.followups);
    await recordFollowupTransitions(repositories.workgraph, reconciledWithLinear.followups, reconciled.followups, {
      occurredAt: now.toISOString(),
    });
  }
  const policy = await repositories.policy.load();
  const issueSources = await buildIssueSourceIndex(repositories.workgraph);
  const awaitingFollowupCount = (await listAwaitingFollowups(repositories.workgraph)).length;

  return {
    policy,
    ownerMap,
    followups: reconciled.followups,
    planningLedger,
    pendingClarificationCount,
    awaitingFollowupCount,
    issueSources,
    risky,
  };
}
