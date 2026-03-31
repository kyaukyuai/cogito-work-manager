# Refactor Roadmap

This document is not a supplement to [docs/execution-manager-architecture.md](/Users/kyaukyuai/src/github.com/kyaukyuai/pi-slack-linear/docs/execution-manager-architecture.md). It is an operational document that fixes implementation order, completion criteria, and prohibitions.

The intended readers are maintainers and implementers. This is not a user-facing behavior document.

This roadmap covers the medium-term phases up to the completion of Phases 1-4. It does not exist to drive additional runtime API or user-facing interface redesign.

## Status

- As of 2026-03-19, the completion gates for Phases 1-4 are satisfied on `main`
- Going forward, this document is a record of completion criteria and migration decisions, not a plan to restart a large structural refactor
- New work should prioritize operational resilience, observability, and work-graph maintainability instead of continued structural rewriting
- As of 2026-03-19, the post-refactor runtime uses `agent-first / tool-contract-first / manager commit` as the primary path

## Global Rules

- Use the LLM only as a planner or assessor
- Execute every external side effect through code-side commands
- Keep Linear as the source of truth for work
- Do not grow new features inside legacy catch-all files
- Do not span phases in one PR
- Do not begin Phase N+1 implementation until Phase N completion gates are satisfied
- Preserve compatibility exports while migration is in progress, then remove them in a deliberate cleanup step

## Phase Overview

| Phase | Name | Status | Primary Goal | Depends On | Entry Condition | Completion Gate |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Planner Extraction | Completed | Move planners into `src/planners/` | none | Architecture doc and AGENTS rules are fixed | Planner logic is logically separated from `pi-session.ts` without behavior changes |
| 2 | Workflow Split | Completed | Move workflows into `orchestrators/` | Phase 1 | Planner call boundaries are stable | `manager.ts` is router-like and major workflows are modularized |
| 3 | Repository Layer | Completed | Introduce file-backed repositories | Phase 2 | Workflow boundaries are clear and state access points are known | Direct `manager-state.ts` reads/writes are replaced by repositories |
| 4 | Unified Work Graph | Completed | Introduce a work graph spanning planning/intake/follow-up | Phase 3 | Repository layer is stable and ledger responsibilities are understood | An append-only event log plus projections powers the work graph |

## PR Rules

- A phase may span multiple PRs
- One PR must still stay within one phase
- Within a phase, separate behavior changes from structural changes whenever practical
- During migration, keep existing call sites and exports stable until replacement is complete
- If a docs-only change alters design decisions, update the architecture doc and AGENTS as needed in the same change

## Phase 1: Planner Extraction

### Goal

Split planner implementations out of `src/lib/pi-session.ts` into `src/planners/`, separating runtime construction from planner logic.

### In Scope

- `task-intake`
- `followup-resolution`
- `research-synthesis`
- `contract.ts`, `prompt.ts`, `parser.ts`, `runner.ts`, and `fixtures/` for each planner
- moving or strengthening existing tests
- updating imports at existing call sites

### Out of Scope

- planner behavior changes
- schema shape changes
- introducing `review-assessment`
- workflow splitting
- repository introduction

### Implementation Shape

- Create `src/planners/task-intake/` and move `TaskPlanningInput`, `TaskPlanningResult`, prompt building, parsing, and runner logic into it
- Apply the same pattern to `followup-resolution` and `research-synthesis`
- Leave runtime-factory and isolated-turn responsibilities in `pi-session.ts`
- If compatibility APIs are still needed, re-export from `pi-session.ts` but keep the implementation in `src/planners/`
- Preserve planner fixtures in a form that supports prompt/reply regression testing

### Validation

- Existing planner tests still pass
- Import paths may change, but behavior does not
- `pi-session.ts` no longer contains planner implementation details

### Done

- `task-intake`, `followup-resolution`, and `research-synthesis` exist under `src/planners/`
- `pi-session.ts` is runtime-centric
- Planner test coverage assumes the new layout

## Phase 2: Workflow Split

### Goal

Split `src/lib/manager.ts` by workflow and reduce `handleManagerMessage` to a routing-oriented entrypoint.

### In Scope

- `intake`
- `updates`
- `research`
- `followups`
- `review`
- workflow-level use-case separation
- turning `handleManagerMessage` into a router

### Out of Scope

- work-graph introduction
- state storage format changes
- planner contract redesign
- a full Linear gateway rewrite

### Implementation Shape

- Create `src/orchestrators/intake/`, `updates/`, `research/`, `followups/`, and `review/`
- Move request / progress / completed / blocked / review entrypoints incrementally
- Keep `handleManagerMessage` focused on message-kind routing and orchestrator dispatch
- Do not add new workflows to a legacy aggregation file
- Keep LLM execution and Linear command execution visibly separate inside each orchestrator

### Validation

- `manager.ts` shrinks toward routing and compatibility facades
- Workflow-level tests preserve existing behavior
- New logic is no longer added directly into `manager.ts`

### Done

- Major workflows live under `src/orchestrators/`
- `handleManagerMessage` is dispatch-oriented instead of implementation-oriented
- Workflow-level test structure exists

## Phase 3: Repository Layer

### Goal

Replace direct `src/lib/manager-state.ts` reads and writes with file-backed repositories so that state access has a stable boundary.

### In Scope

- `PolicyRepository`
- `OwnerMapRepository`
- `IntakeRepository`
- `FollowupRepository`
- `PlanningRepository`
- repository interfaces and file-backed implementations

### Out of Scope

- SQLite migration
- storage format changes
- full work-graph adoption
- full projection adoption

### Implementation Shape

- Add `src/state/repositories/` with repositories backed by the current JSON files
- Reduce `manager-state.ts` to schemas and compatibility helpers, or move it inward over time
- Route workflow-side state access through repositories
- Preserve the formats of `policy.json`, `owner-map.json`, `followups.json`, and `planning-ledger.json`

### Validation

- Major workflows no longer read/write JSON files directly
- Repository introduction does not change storage formats
- State access can be unit-tested at the repository layer

### Done

- Repositories exist for policy, owner map, intake, follow-up, and planning
- Workflows access state through repositories
- Direct dependency on `manager-state.ts` is greatly reduced

## Phase 4: Unified Work Graph

### Goal

Introduce a work graph spanning planning, intake, and follow-up, using an append-only event log plus projections as the orchestration-state backbone.

### In Scope

- `WorkgraphRepository`
- append-only event log
- projection-based current-state reconstruction
- a unified state model spanning planning, intake, and follow-up
- migration layers for existing ledgers

### Out of Scope

- redesigning every workflow at once
- adding another external system of record
- replacing Linear with a custom state machine

### Implementation Shape

- Introduce an append-only event log equivalent to `workgraph-events.jsonl`
- Define events such as `intake.received`, `intake.clarification-requested`, `linear.parent-created`, `linear.child-created`, `followup.requested`, `followup.resolved`, `issue.blocked`, and `issue.completed`
- Reconstruct current state through projections
- Treat old ledgers as migration compatibility layers rather than deleting them abruptly

### Current Boundary

- Linear remains the source of truth for work itself
- The work graph is the preferred cross-workflow read model
- The current read side uses work-graph queries for review counts, issue-source lookup, thread planning context, pending clarification checks, latest resolved issue lookup, and update target resolution
- Manager, intake, updates, and review decisions assume work-graph query access
- The legacy intake ledger has been removed from runtime, and old `intake-ledger.json` is cleaned up during bootstrap
- Source-of-truth transition was done incrementally through dual-write and query migration, ending with intake-ledger removal

### Validation

- Intake / planning / follow-up state can be reconstructed from one unified model
- Required current state can be recalculated from the append-only event log
- Existing workflows remain stable during migration

### Done

- Work-graph event definitions, repository, and projections exist
- The division of responsibility between ledgers and work graph is documented
- Major intake / planning / follow-up decisions use the unified state model
- The legacy intake ledger is removed from runtime, and workflows operate through the work graph plus the remaining ledgers

## Validation Checklist

- Phase numbers and names match the architecture document
- `In Scope` and `Out of Scope` do not contradict each other
- Legacy compatibility policy does not conflict with [AGENTS.md](/Users/kyaukyuai/src/github.com/kyaukyuai/pi-slack-linear/AGENTS.md)
- This roadmap elaborates the architecture doc rather than defining a competing architecture

## Defaults and Assumptions

- The roadmap covers the medium-term completion of Phases 1-4, not just the immediate next step
- Each phase is phase-gated
- Structural separation comes before unified state
- This document is documentation-only; it does not imply direct code changes by itself

## Post-Refactor Priorities

- Improve snapshot / compaction / replay operations for `workgraph-events.jsonl`
- Improve failure diagnostics and health checks for review, scheduler, and control-room flows
- Increase observability across major workflows so thread / issue / event tracing is easier
