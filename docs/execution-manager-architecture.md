# Execution Manager Architecture

This document defines how `cogito-work-manager` should evolve as an execution manager with Linear as the system of record, rather than as a generic Slack conversation bot.

This design does not assume skill-driven production behavior. The primary runtime path is `agent + tool contracts + manager commit`, with state management and side effects enforced in code.

## Current Status

- As of 2026-03-19, planner extraction, workflow splitting, repository layering, and the unified work graph are complete on `main`
- The primary runtime now treats `workgraph` as the main read model while keeping Linear as the canonical source of work state
- As of 2026-03-19, the primary path for Slack message, query, create, and update handling is `pi-coding-agent + strict tools + manager commit`
- As of 2026-03-24, the Linear issue-created webhook is also routed through the same `agent + strict tools + manager commit` system workflow
- As of 2026-03-25, runtime customization uses fixed slots under `/workspace/system/AGENTS.md`, `MEMORY.md`, and `AGENDA_TEMPLATE.md`; `AGENTS.md` and `MEMORY.md` can be silently auto-updated after turns, while `MEMORY.md` remains milestone-oriented and does not track issue-level current state
- Scheduler and heartbeat already use the same primary agent/tool surface, and the old regex- and planner-heavy fallback path has been reduced to safety-only behavior
- As of 2026-03-30, Slack attachments are stored as thread-local catalogs with eager extraction for `pdf / docx / txt / md / csv / json`, and with lazy audio/video transcription when `OPENAI_API_KEY` is available; the read surface is exposed through `slack_list_thread_attachments` and `slack_read_thread_attachment`
- As of 2026-03-31, messages that mention another Slack user without mentioning Cogito are publicly ignored but still persisted; when the runtime can resolve exactly one existing issue, it records a thread-local `external-coordination-hint` so later replies can update or comment on that hinted issue
- As of 2026-03-31, follow-up priority changes are first-class proposals and commits through `propose_update_issue_priority` / `update_issue_priority`, rather than being overloaded onto status-change paths
- As of 2026-04-01, top-level system-generated Slack posts persist typed issue references into the actual Slack thread workspace as `scratch/system-thread-context.json`, so later human follow-ups in that real Slack thread can reuse root review/heartbeat/scheduler/webhook context
- As of 2026-04-01, pre-AIC-119 system-generated Slack threads can lazily recover `system-thread-context.json` from the actual root Slack post on the first later follow-up, so older review threads can reuse root issue refs without a batch migration
- As of 2026-04-01, the manager read/write surface also covers Linear projects, including project facts inspection plus typed project create/update proposals committed through the same manager boundary
- As of 2026-04-02, explicit project-grouped task-list queries are rendered by the manager from exact `linear_list_active_issue_facts` project membership, preserving exact per-project counts and deterministic continuation instead of agent-side grouped prose
- As of 2026-04-05, the Linear runtime contract assumes `linear-cli v3.0.0`, accepts additive `linear capabilities --json` schema changes, verifies `LINEAR_TEAM_KEY` through `team list --json`, and preserves `timeout_error.appliedState` and `callerGuidance` for repo-side reconciliation
- Business judgment on the primary path must be explicit in agent proposals; manager commit is responsible only for validation, dedupe, execution, and state updates
- Emergency fallback is safety-only and must not replace primary-path business judgment
- The main focus from this point forward is not another large structural rewrite, but operational resilience, observability, and event-log maintainability

## Goals

- Reliably convert Slack- and webhook-originated requests into work items
- Handle progress, blocked, research, and follow-up states within one consistent model
- Safely execute creation, updates, comments, assignment, relations, status changes, and priority changes against Linear
- Safely inspect, create, and update Linear projects without bypassing manager commit
- Preserve explicit contracts and regression-testability even when LLMs are involved
- Run control-room review and heartbeat on the same execution-manager model

## Non-Goals

- Making production behavior depend on freeform skills or freeform prompts
- Maintaining an internal todo system outside Linear
- Delegating all decision-making to one large unstructured agent turn

## Core Principles

### 1. Agent-First, Tool-Contract-First

Use the LLM/agent for understanding and proposing:

- interpreting intent for conversation, query, create, update, and review flows
- reading Slack, Linear, and workgraph state through tools
- assembling business command proposals
- generating natural-language replies

Use manager commit for all side effects:

- Linear issue creation
- due date updates
- assignee updates
- priority updates
- comment creation
- blocked / completed / progress state changes
- duplicate prevention
- command validation
- permission and policy checks
- workgraph append

This separation keeps language understanding flexible while enforcing typed side effects and idempotent execution in code.

### 2. State-First, Not Chat-First

The runtime still keeps `1 Slack thread = 1 session context`, but the execution manager is centered on work state, not on chat state.

At minimum, the system must consistently track:

- source thread
- source webhook delivery
- parent issue
- child issues
- research issues
- follow-up requests
- blocked reasons
- owner and due-date resolution history

Slack threads are input channels, not the subject of state.

### 3. Typed Tool Contracts

The agent must not trigger side effects through freeform text. Production behavior must go through read, proposal, and internal commit contracts.

Examples:

- `linear_list_active_issues`
- `linear_list_active_issue_facts`
- `linear_get_issue_facts`
- `linear_list_review_facts`
- `linear_list_project_facts`
- `linear_get_project_facts`
- `workgraph_get_thread_context`
- `slack_list_thread_attachments`
- `slack_read_thread_attachment`
- `propose_create_issue`
- `propose_create_project`
- `propose_update_issue_status`
- `propose_update_issue_priority`
- `propose_update_project`
- `propose_review_followup`

The agent stops at proposals. Manager commit is responsible for schema validation, execution, and state updates.

### 4. Idempotent Commands and Append-Only History

Slack retries, repeated thread replies, and scheduler re-runs must not execute the same side effect twice.

This requires:

- strong dedupe keys before command execution
- one-time proposal confirmation in manager commit
- append-only execution history with read-side projections for current state

The current ledgers are only an intermediate step toward that model.

### 5. Linear Is the Source of Truth for Work

Canonical work state lives in Linear. Local state is allowed only when it is orchestration support.

Allowed local state includes:

- Slack thread to issue linkage
- pending follow-up state
- thread-local external coordination hints
- thread-local system root issue context for system-generated Slack threads
- thread-local attachment catalogs and derived extracts/transcripts
- planner decision history
- dedupe and retry history
- review and heartbeat suppression state

## Current Structure and Pain Points

The current implementation is still concentrated in a few legacy files:

- [main.ts](/Users/kyaukyuai/src/github.com/kyaukyuai/pi-slack-linear/src/main.ts): Slack ingress, webhook ingress, thread queueing, manager dispatch, fallback agent flow
- [manager.ts](/Users/kyaukyuai/src/github.com/kyaukyuai/pi-slack-linear/src/lib/manager.ts): intake, progress, completion, blocked, research, review, and follow-up handling
- [pi-session.ts](/Users/kyaukyuai/src/github.com/kyaukyuai/pi-slack-linear/src/lib/pi-session.ts): runtime construction, isolated turn execution, planner runtime glue
- [manager-state.ts](/Users/kyaukyuai/src/github.com/kyaukyuai/pi-slack-linear/src/lib/manager-state.ts): schema and persistence for policy and ledgers
- [linear-tools.ts](/Users/kyaukyuai/src/github.com/kyaukyuai/pi-slack-linear/src/lib/linear-tools.ts): custom Linear tools

The system works, but this shape still has predictable long-term problems:

- `manager.ts` can grow without clear workflow boundaries
- `pi-session.ts` still mixes runtime and planner-adjacent responsibilities
- state is spread across intake, follow-up, planning, and workgraph helpers
- tests can fall back toward “large manager function” coverage instead of workflow contracts
- adding more review, dependency, replanning, or escalation behavior becomes harder to contain

Compatibility note:

- The repo still contains `skills/linear-cli/` and related workspace-copy behavior
- That is acceptable as an operational compatibility asset
- It is not part of the long-term execution-manager architecture

## Target Architecture

### Layered Design

The long-term target remains a six-layer model:

1. `app`
2. `adapters`
3. `orchestrators`
4. `planners`
5. `gateways`
6. `state`

Responsibilities:

- `app`: process bootstrap, dependency wiring, runtime routing
- `adapters`: Slack, scheduler, heartbeat, and control-room ingress/egress
- `orchestrators`: workflow-specific use cases
- `planners`: LLM prompt / parser / runner / schema units
- `gateways`: Linear, Slack context, Slack attachments, web research, and other external dependencies
- `state`: policy, repositories, event logs, and projections

### Proposed Directory Layout

```text
src/
  main.ts
  app/
    bootstrap.ts
    dependency-container.ts
    message-router.ts
  adapters/
    slack/
      slack-event-consumer.ts
      slack-reply-publisher.ts
    scheduler/
      scheduler-runner.ts
    heartbeat/
      heartbeat-runner.ts
    control-room/
      control-room-publisher.ts
  domain/
    work/
      work-item.ts
      work-bundle.ts
      work-status.ts
      dependency.ts
    planning/
      plan-decision.ts
      planner-contracts.ts
    followup/
      followup-request.ts
      followup-resolution.ts
    review/
      risk-assessment.ts
      review-decision.ts
    policy/
      manager-policy.ts
      owner-routing.ts
  orchestrators/
    intake/
      handle-intake.ts
      build-work-creation-command.ts
      dedupe-intake.ts
    updates/
      handle-progress-update.ts
      handle-completed-update.ts
      handle-blocked-update.ts
      handle-priority-update.ts
    research/
      handle-research-child.ts
      synthesize-research-findings.ts
    followups/
      request-followup.ts
      resolve-followup-response.ts
    review/
      build-manager-review.ts
      build-heartbeat-review.ts
  planners/
    task-intake/
      contract.ts
      prompt.ts
      parser.ts
      runner.ts
      fixtures/
    followup-resolution/
      contract.ts
      prompt.ts
      parser.ts
      runner.ts
      fixtures/
    research-synthesis/
      contract.ts
      prompt.ts
      parser.ts
      runner.ts
      fixtures/
    review-assessment/
      contract.ts
      prompt.ts
      parser.ts
      runner.ts
      fixtures/
  gateways/
    linear/
      linear-client.ts
      linear-commands.ts
      linear-queries.ts
      linear-tool-definitions.ts
    slack/
      slack-thread-context.ts
      slack-channel-context.ts
    slack-attachments/
      catalog.ts
      service.ts
    web/
      web-search.ts
      web-fetch.ts
  runtime/
    agent-runtime-factory.ts
    isolated-turn-runner.ts
    thread-runtime-pool.ts
    system-prompt.ts
  state/
    repositories/
      policy-repository.ts
      owner-map-repository.ts
      followup-repository.ts
      planning-repository.ts
      workgraph-repository.ts
    projections/
      thread-context-projection.ts
      issue-focus-projection.ts
      review-suppression-projection.ts
    schemas/
      followup-ledger-schema.ts
      planning-ledger-schema.ts
      workgraph-event-schema.ts
  shared/
    clock.ts
    ids.ts
    json.ts
    text.ts
```

### Why This Layout Fits This Repo

This repo is not a generic web app. It is:

- a long-running Slack Socket Mode bot
- an optional Linear webhook consumer in the same process
- a system that uses `pi-coding-agent` for both isolated turns and thread sessions
- a Linear-first execution manager
- a runtime that also contains scheduler, heartbeat, and control-room workflows

That makes workflow- and planner-first boundaries more natural than generic `controller/service/repository` layering.

## Responsibilities by Area

### `app`

Keep `main.ts` thin. It should only handle:

- configuration loading
- startup for Slack, scheduler, and heartbeat
- wiring the thread queue and runtime pool
- routing to the correct orchestrator by message kind

### `adapters`

Adapters handle ingress and egress:

- converting Slack events into domain inputs
- publishing Slack replies
- dispatching scheduler and heartbeat triggers into shared orchestrators

Inline Slack logic in `main.ts` should migrate here.

### `orchestrators`

Orchestrators are the execution-manager core and should remain workflow-scoped:

- intake: turn requests into issue-creation plans and commit them to Linear
- updates: apply progress, completion, blocked, and priority changes to existing issues
- research: synthesize findings and next steps from research issues
- followups: request and resolve explicit follow-up actions
- review: morning/evening/weekly review plus heartbeat review

The most important rule here is to keep LLM calls and Linear side effects clearly separated inside each workflow.

### `planners`

One planner per workflow directory.

Each planner should contain:

- `contract.ts`: zod schema and public types
- `prompt.ts`: prompt builder
- `parser.ts`: JSON extraction and validation
- `runner.ts`: isolated-turn execution helper
- `fixtures/`: prompt and reply regression samples

This keeps planner changes local instead of letting them leak across the entire manager.

### `gateways`

Gateways centralize external dependencies and the underlying implementations behind custom tools:

- Linear queries and commands
- Slack thread and channel context
- Slack attachment hydration, extraction, and transcription
- web search and fetch

`linear-tools.ts` should continue moving toward `gateways/linear/linear-tool-definitions.ts`.

### `state`

Do not let workflows read and write JSON files directly. Repositories and projections should hide the persistence details.

File-backed repositories are sufficient in the short term. Over time, the interfaces should remain stable enough to swap to SQLite if needed.

Minimum repositories:

- `PolicyRepository`
- `OwnerMapRepository`
- `IntakeRepository`
- `FollowupRepository`
- `PlanningRepository`

Longer term, `WorkgraphRepository` should carry the append-only event log and projections rather than keeping workflow state fragmented across ledgers.

## Workflow Contracts

Execution-manager workflows should expose explicit input and output shapes.

### 1. Intake

Input:

- Slack request
- thread context
- pending clarification
- owner map
- duplicate candidates

Output:

- clarify
- link existing
- create single issue
- create parent + child issues

### 2. Progress / Completed / Blocked / Priority

Input:

- Slack update message
- thread-linked issues
- preferred issue candidates

Output:

- target issue decision
- state mutation command or priority mutation command
- optional follow-up resolution update

### 3. Research

Input:

- research issue
- Slack thread summary
- recent channel summary
- related issues
- web evidence

Output:

- findings
- uncertainties
- next child tasks

### 4. Review

Input:

- risky issues
- follow-up cooldown state
- business-hours policy

Output:

- no-op
- control-room summary
- explicit follow-up request

The Linear issue-created webhook should decide execute vs no-op based on whether a safe action exists on the existing proposal surface, not on abstract “value”.

Person-to-person Slack coordination should remain split into three buckets:

1. explicit operator-directed outbound posts
2. system follow-up notifications from review/heartbeat
3. external coordination threads that are publicly ignored but may later map into hinted-issue progress/comments

For bucket 3, explicit `@other-user without @Cogito` suppression remains deterministic. Plain-text other-directed messages may also enter this bucket through an LLM-first classifier that reads the latest message, recent thread context, and owner-map entries directly. Suppression and hint creation are separate: a thread may be publicly ignored even when no safe hinted Slack target can be persisted.

Only the third bucket is allowed to auto-promote `Backlog -> In Progress`, and only when the thread-local hint resolves exactly to an existing issue and later replies clearly indicate progress.

## State Model Recommendation

Short term: keep the existing ledgers, but access them through repositories.

### Short Term

Keep these files behind repository interfaces:

- `policy.json`
- `owner-map.json`
- `followups.json`
- `planning-ledger.json`

The file formats do not need to change immediately.

### Mid Term

Use `workgraph-events.jsonl` as the append-only event log and reconstruct current state through projections.

Example event types:

- `intake.received`
- `intake.clarification-requested`
- `linear.parent-created`
- `linear.child-created`
- `followup.requested`
- `followup.resolved`
- `issue.blocked`
- `issue.completed`
- `issue.priority-updated`

## Migration Plan

### Phase 1: Planner Extraction

Move planner implementations out of `pi-session.ts`:

- `task-intake`
- `followup-resolution`
- `research-synthesis`

This phase is complete and was intended to preserve behavior while cleaning up placement.

### Phase 2: Workflow Split

Split `manager.ts` into workflow-oriented orchestrators:

- intake
- updates
- research
- followups
- review

This phase is complete. `handleManagerMessage` should remain a routing and orchestration entrypoint rather than a full implementation bucket.

### Phase 3: Repository Layer

Replace direct `manager-state.ts` reads and writes with repositories.

This phase is complete. State access should continue moving through repository interfaces instead of direct JSON calls.

### Phase 4: Unified Work Graph

Unify planning, intake, and follow-up around the work graph.

This phase is complete. Future work should improve work-graph operations, observability, replay, and maintenance rather than starting another large restructure.

## File Mapping From Current Code

Approximate mapping from current files toward the target architecture:

- [main.ts](/Users/kyaukyuai/src/github.com/kyaukyuai/pi-slack-linear/src/main.ts) -> `app/`, `adapters/`
- [manager.ts](/Users/kyaukyuai/src/github.com/kyaukyuai/pi-slack-linear/src/lib/manager.ts) -> `orchestrators/`, `domain/`, service boundaries
- [pi-session.ts](/Users/kyaukyuai/src/github.com/kyaukyuai/pi-slack-linear/src/lib/pi-session.ts) -> `runtime/`, `planners/`
- [manager-state.ts](/Users/kyaukyuai/src/github.com/kyaukyuai/pi-slack-linear/src/lib/manager-state.ts) -> `state/`
- [linear-tools.ts](/Users/kyaukyuai/src/github.com/kyaukyuai/pi-slack-linear/src/lib/linear-tools.ts) -> `gateways/linear/`
- [slack-context.ts](/Users/kyaukyuai/src/github.com/kyaukyuai/pi-slack-linear/src/lib/slack-context.ts) -> `gateways/slack/`
- `src/gateways/slack-attachments/*` -> `gateways/slack-attachments/`
- [web-research.ts](/Users/kyaukyuai/src/github.com/kyaukyuai/pi-slack-linear/src/lib/web-research.ts) -> `gateways/web/`

## Decision Summary

The architectural direction for this repo is:

- orchestration-first, not chat-first
- agent-first for understanding, tool-contract-first for execution
- Linear as the only source of truth for work
- manager commit as the only side-effect boundary
- local state limited to orchestration support
- no new feature growth into legacy catch-all files unless there is no better option
