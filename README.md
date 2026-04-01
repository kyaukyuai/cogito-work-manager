# cogito-work-manager

Cogito is an execution-manager assistant that continuously watches dedicated Slack channels, optionally consumes Linear issue-created webhooks, and uses `pi-coding-agent` while keeping Linear as the task system of record.

## What It Does

- Watches only allowlisted Slack channels
- Optionally receives Linear issue-created webhooks and runs safe automatic actions
- Always replies in a Slack thread
- Keeps `1 Slack thread = 1 pi session`
- Autonomously creates Linear issues for clear requests
- Splits larger requests into a parent issue plus execution-sized child issues
- Auto-assigns work using the owner map
- Reflects due dates into Linear when the request contains a deadline
- Detects overdue, stale, blocked, and owner/due-date-missing issues and reports them to the control room
- Optionally uses Notion as reference material and can create agenda pages under a configured parent page
- Does not maintain a separate internal todo system

## Architecture

```text
Slack (Socket Mode) / Linear Issue Create Webhook
  -> custom Node.js bot + webhook listener
  -> pi-coding-agent SDK
  -> manager loops + custom Linear tools + read-only reference tools
  -> linear CLI
  -> Linear API
```

For the long-term execution-manager design and the target repo structure, see [docs/execution-manager-architecture.md](/Users/kyaukyuai/src/github.com/kyaukyuai/pi-slack-linear/docs/execution-manager-architecture.md).

## Directory Layout

The runtime workspace uses the following structure.

```text
/workspace
  /.pi/agent/skills/linear-cli/
  /threads/<channel-id>/<thread-ts>/
    session.jsonl
    log.jsonl
    attachments/
    scratch/
  /system/
    HEARTBEAT.md
    AGENTS.md
    MEMORY.md
    AGENDA_TEMPLATE.md
    jobs.json
    job-status.json
    policy.json
    owner-map.json
    notion-pages.json
    followups.json
    planning-ledger.json
    personalization-ledger.json
    webhook-deliveries.json
    workgraph-events.jsonl
    workgraph-snapshot.json
    /sessions/
      /heartbeat/<channel-id>/
      /cron/<job-id>/
      /webhook/<issue-id>/
```

## Required Environment Variables

- `SLACK_APP_TOKEN`
- `SLACK_BOT_TOKEN`
- `SLACK_ALLOWED_CHANNEL_IDS`
- `LINEAR_API_KEY`
- `LINEAR_WORKSPACE`
- `LINEAR_TEAM_KEY`

Optional:

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `LINEAR_WRITE_TIMEOUT_MS`
- `LINEAR_WEBHOOK_ENABLED`
- `LINEAR_WEBHOOK_PUBLIC_URL`
- `LINEAR_WEBHOOK_SECRET`
- `LINEAR_WEBHOOK_PORT`
- `LINEAR_WEBHOOK_PATH`
- `NOTION_API_TOKEN`
- `NOTION_AGENDA_PARENT_PAGE_ID`
- `BOT_MODEL`
- `BOT_THINKING_LEVEL`
- `BOT_MAX_OUTPUT_TOKENS`
- `BOT_RETRY_MAX_RETRIES`
- `BOT_UID`
- `BOT_GID`
- `WORKSPACE_DIR`
- `HEARTBEAT_INTERVAL_MIN`
- `HEARTBEAT_ACTIVE_LOOKBACK_HOURS`
- `SCHEDULER_POLL_SEC`
- `WORKGRAPH_MAINTENANCE_INTERVAL_MIN`
- `WORKGRAPH_HEALTH_WARN_ACTIVE_EVENTS`
- `WORKGRAPH_AUTO_COMPACT_MAX_ACTIVE_EVENTS`
- `LOG_LEVEL`

This bot assumes `linear-cli v2.12.3` or newer. Runtime Linear reads and writes use `issue list/view/create/update --json`, `issue comment add --json`, `issue relation add/list --json`, `team members --json`, `issue parent/children --json`, and `issue create-batch --file ... --json`. Startup and diagnostics verify the required runtime surface with `linear capabilities --json`. The bot accepts the additive `stateName` field from `issue list --json` while remaining compatible with nested `state.name`. Multiline descriptions and comments use `--description-file` and `--body-file`. Relation add is treated as retry-safe. High-value writes pass `LINEAR_WRITE_TIMEOUT_MS` to prefer machine-readable `timeout_error`; when unset, the repo defaults to `25000ms`. If `timeout_error` contains `appliedState` or `callerGuidance`, those fields are preserved for repo-side reconciliation.

Slack attachments are cataloged under each thread workspace. `pdf / docx / txt / md / csv / json` are eagerly extracted on ingest, and the manager agent can inspect them with the read-only tools `slack_list_thread_attachments` and `slack_read_thread_attachment`. If `OPENAI_API_KEY` is set, video and audio attachments are lazily transcribed on first read using `gpt-4o-mini-transcribe`, with about 20 MB chunking and a 30-minute cap. Document attachment reading still works when `OPENAI_API_KEY` is unset.

The runtime can also publicly suppress plain-text Slack messages that are clearly directed to another person even when no explicit `@mention` is present. This path is LLM-first: an isolated classifier decides `to_other_person | to_cogito | unclear` from the latest message, recent thread context, and owner-map entries. Suppression and external-coordination hint creation are separate, so a message may be suppressed even when no safe hinted Slack target can be persisted.

If `NOTION_API_TOKEN` is set, the bundled `ntn v0.4.0` can access Notion. The current scope includes page search, page facts, page content excerpts, database search, and database query. If `NOTION_AGENDA_PARENT_PAGE_ID` is also set, the bot can create agenda pages under the configured parent page. Existing pages can be updated via title changes, append operations, `replace_section` updates limited to `heading_2` sections on Cogito-managed pages, and archive/trash actions. Managed pages are tracked in `workspace/system/notion-pages.json`. Database row updates and deletes are out of scope. Notion is not used as the task system of record.

`/workspace/system/AGENTS.md`, `/workspace/system/MEMORY.md`, and `/workspace/system/AGENDA_TEMPLATE.md` are runtime customization files.

- `AGENTS.md` holds durable operating rules such as workflow preferences, reply behavior, and priorities.
- `MEMORY.md` holds terminology, background knowledge, project overview, members and roles, and roadmap or milestone context.
- `AGENDA_TEMPLATE.md` is reserved for the default structure of Notion agenda pages.

`MEMORY.md` is milestone-oriented and must not contain issue-level due dates, current progress, or current status. `AGENTS.md` and `MEMORY.md` are injected into manager/system turns and into reply/router/intake/research/follow-up planners on every turn. They do not override schema, supported actions, parser contracts, or safety rules. `HEARTBEAT.md` is a heartbeat-only prompt override, and `owner-map.json` is the control-plane config for owner routing. The repo-root `AGENTS.md` is for development rules only and is not used for runtime customization.

Runtime `AGENTS.md` and `MEMORY.md` can be silently auto-updated from conversations and execution results. Candidate facts are recorded in `/workspace/system/personalization-ledger.json`, and only promoted facts are written back into runtime `AGENTS.md` and `MEMORY.md`. For a richer project snapshot, the preferred path is an explicit structured save such as `Save this to MEMORY`, including `project-overview`, `members-and-roles`, and `roadmap-and-milestones`.

`LINEAR_WORKSPACE` is descriptive only. When `LINEAR_API_KEY` is present, the runtime avoids combining it with `-w/--workspace`, even on `linear-cli v2.12.3`.

If `LINEAR_WEBHOOK_ENABLED=true`, the same process also starts the issue-created webhook listener. It only accepts new issues for `LINEAR_TEAM_KEY`, verifies signatures, deduplicates deliveries, and then routes the event through the same agent-first, strict-tools, manager-commit workflow. The decision criterion is not “is this valuable?” but “is there a safe action available on the existing proposal surface right now?” No-op outcomes stay silent; only committed actions and failures notify the control room.

If webhooks are enabled, these settings are also required:

- `LINEAR_WEBHOOK_PUBLIC_URL`
  - Public URL reachable by Linear. `LINEAR_WEBHOOK_PATH` is appended to this value.
- `LINEAR_WEBHOOK_SECRET`
  - Secret used for webhook signature verification.
- `LINEAR_WEBHOOK_PORT`
  - Port the bot listens on. Docker Compose exposes the same port from the host.
- `LINEAR_WEBHOOK_PATH`
  - Defaults to `/hooks/linear`.

If you do not provide `ANTHROPIC_API_KEY`, you can mount a local `~/.pi/agent/auth.json` into `/workspace/.pi/agent/auth.json` with Docker Compose.

## LLM Runtime Configuration

The LLM runtime can be configured globally through env vars.

- `BOT_MODEL`
  - Resolved by `ModelRegistry.find("anthropic", BOT_MODEL)`.
- `BOT_THINKING_LEVEL`
  - Accepts `off | minimal | low | medium | high | xhigh`.
  - On reasoning-capable models, this is converted into provider-specific reasoning or thinking settings.
- `BOT_MAX_OUTPUT_TOKENS`
  - Uses the library or provider default when unset.
  - When set, the repo-side stream wrapper injects `maxTokens` / `max_tokens` on every LLM call.
- `BOT_RETRY_MAX_RETRIES`
  - Passed into the SDK retry setting `retry.maxRetries`.
- `BOT_UID` / `BOT_GID`
  - Used to keep runtime files on bind mounts owned by the host user.
  - In Docker Compose, set these to `id -u` and `id -g`.
  - On startup, the bot aligns `/workspace/system` and `/workspace/threads` to those ids and then continues running as that same uid/gid.

On the current Anthropic runtime, `sessionId` is passed to the agent layer but is not used in provider requests. `temperature` and `cacheRetention` are currently read-only and are not configured by the repo.

## Heartbeat and Scheduler

- `HEARTBEAT_INTERVAL_MIN`
  - `0` disables heartbeat.
  - `30` runs heartbeat every 30 minutes.
- `HEARTBEAT_ACTIVE_LOOKBACK_HOURS`
  - How many recent hours of Slack activity count as active for heartbeat targeting.
- `SCHEDULER_POLL_SEC`
  - How often scheduler runtime state is checked.

Heartbeat runs as an isolated session equivalent to `heartbeat:<channel>`. If it returns exactly `HEARTBEAT_OK`, nothing is posted to Slack.

The scheduler reads custom job definitions from `/workspace/system/jobs.json`, runtime state from `/workspace/system/job-status.json`, and built-in review schedules from `policy.json`. It runs `at`, `every`, `daily`, and `weekly` jobs as isolated sessions equivalent to `cron:<jobId>`.

The scheduler can also be managed from Slack. Typical examples:

- `Show me the schedule list`
- `Show me the manager-review-evening configuration`
- `Add a job to review upcoming AIC deadlines every day at 09:00`
- `Move daily-task-check to 17:00`
- `Delete daily-task-check`
- `Run weekly-notion-agenda-ai-clone now`
- `Move the morning review to 08:30`
- `Stop the evening review`
- `Set heartbeat to every 60 minutes`

Built-in schedules are `morning-review`, `evening-review`, `weekly-review`, and `heartbeat`. These are canonical in `policy.json`, and Slack changes update policy internally. Only custom jobs are stored in `jobs.json`. `nextRunAt`, `lastRunAt`, `lastStatus`, `lastResult`, and `lastError` are stored in `job-status.json`. Immediate execution and test execution are supported only for custom jobs. Built-in review and heartbeat are out of scope for immediate manual execution.

Slack can also request execution against an existing issue. Typical examples:

- `Work on AIC-123`
- `Execute this issue`
- `Do the next step for AIC-123`

This workflow reads the existing issue and runs only the actions that can be executed safely using the current manager-commit surface. Ambiguous targets are never inferred in code; the bot asks for an issue id.

Minimal `jobs.json` example:

```json
[
  {
    "id": "daily-task-check",
    "enabled": true,
    "channelId": "C0123456789",
    "prompt": "Review upcoming AIC deadlines",
    "kind": "daily",
    "time": "09:00"
  }
]
```

`policy.json` and `owner-map.json` are generated automatically on startup. By default, the control room is `C0ALAMDRB9V`, the assistant name is `コギト`, and the fallback owner is `kyaukyuai`. Empty runtime files are also created for `AGENTS.md`, `MEMORY.md`, `AGENDA_TEMPLATE.md`, `jobs.json`, `job-status.json`, and `personalization-ledger.json`. The model is fixed-slot based:

- `AGENTS.md`: common operating rules across planners
- `MEMORY.md`: common project knowledge, terminology, and durable context
- `AGENDA_TEMPLATE.md`: Notion agenda only

If `BOT_UID` and `BOT_GID` are set, those runtime system files remain editable by the host operator without `sudo`.

## Runtime State Files

High-level classification:

- `editable`: `AGENTS.md`, `MEMORY.md`, `AGENDA_TEMPLATE.md`, `HEARTBEAT.md`, `policy.json`, `owner-map.json`, `jobs.json`
- `internal`: `job-status.json`, `followups.json`, `planning-ledger.json`, `notion-pages.json`, `personalization-ledger.json`, `webhook-deliveries.json`
- `derived`: `workgraph-events.jsonl`, `workgraph-snapshot.json`, `sessions/`

Meaning:

- `editable`: safe for direct operator edits
- `internal`: runtime-maintained ledgers and registries; generally read-only for operators
- `derived`: generated artifacts; use recovery/diagnostics rather than manual edits

Update policy:

- `silent-auto-update`: `AGENTS.md`, `MEMORY.md`
- `explicit-slack-update`: `AGENDA_TEMPLATE.md`, `HEARTBEAT.md`, `owner-map.json`
- `manager-commit-only`: `policy.json`, `jobs.json`
- `system-maintained`: `job-status.json`, `followups.json`, `planning-ledger.json`, `notion-pages.json`, `personalization-ledger.json`, `webhook-deliveries.json`
- `rebuild-only`: `workgraph-events.jsonl`, `workgraph-snapshot.json`, `sessions/`

Meaning:

- `silent-auto-update`: the system may update it automatically when confidence is high
- `explicit-slack-update`: only updated via an explicit Slack request plus manager commit
- `manager-commit-only`: only updated through typed proposals and manager commit
- `system-maintained`: directly maintained by runtime operation
- `rebuild-only`: generated state; recover or rebuild instead of editing

## Slack Mentions and Coordination

Slack mention and person-to-person coordination flows are split into three categories:

1. Explicit outbound posting
   - Executed through manager commit only.
   - v1 supports only a single target whose `slackUserId` exists in `owner-map.json`.
   - Default destination is the current thread; control room root is opt-in.
   - DM, arbitrary channels, multiple targets, and extra mentions are out of scope.
2. Review and heartbeat follow-up mentions
   - Used only for internal follow-up notifications.
   - The assignee is mentioned at most once when policy says it is needed.
3. External coordination threads
   - Messages that mention another user but do not mention Cogito are publicly ignored.
   - The thread log and attachments are still persisted.
   - If an exact existing issue can be resolved, the runtime stores `scratch/external-coordination-hint.json`.
   - Later short replies such as `Thanks`, `I’ll confirm`, `Shared`, or `I’ll send this to legal` can be mapped into progress/comments on the hinted issue.
   - Only `Backlog -> In Progress` is auto-promoted from that hinted path; other state changes still require explicit signals.
4. System-generated root threads
   - Top-level review, heartbeat, scheduler, and webhook posts also persist typed issue refs into the actual Slack thread workspace as `scratch/system-thread-context.json`.
   - Later human follow-ups in that same real Slack thread can reuse those issue refs as strong hints.
   - This enables partial success follow-ups such as lowering the priority of one referenced issue while explicitly saying that another subtopic has no existing issue.

## Policy Knobs

`policy.json` exposes these manager knobs:

- `autoCreate`
- `assistantName`
- `autoStatusUpdate`
- `followupCooldownHours`
- `reviewExplicitFollowupCount`
- `mentionOnFirstFollowupCategories`
- `mentionOnRepingCategories`
- `mentionAfterRepingCount`
- `researchAutoPlanMinActions`
- `researchAutoPlanMaxChildren`
- `reviewCadence.morningEnabled`
- `reviewCadence.eveningEnabled`
- `reviewCadence.weeklyEnabled`
- `heartbeatEnabled`
- `heartbeatIntervalMin`
- `heartbeatActiveLookbackHours`

## Slack App Setup

Minimum required Slack configuration:

### Bot Token Scopes

- `channels:history`
- `channels:read`
- `chat:write`
- `files:read`
- `groups:history`
- `groups:read`

### Bot Events

- `message.channels`
- `message.groups`

### Other

- Enable Socket Mode
- Add `connections:write` to the app-level token
- Invite the bot into the dedicated channel with `/invite`

DM is out of scope for v1.

## Local Development

```bash
cp .env.example .env
npm install
npm run dev
```

## Docker Compose

```bash
cp .env.example .env
docker compose up --build
```

## Deploy to exe.dev

On `exe.dev`, this bot only needs Docker Compose on a VM. A public proxy is only required when Linear webhooks are enabled. See [docs/exe-dev-deploy.md](/Users/kyaukyuai/src/github.com/kyaukyuai/pi-slack-linear/docs/exe-dev-deploy.md) for the deployment procedure.

## Verify

1. The bot replies in a thread when a message is posted in the dedicated channel
2. `Create a task` creates an issue
3. A complex request creates a parent issue plus child issues
4. Requests with relative dates create due dates
5. `Set AIC-2 due on 2026-03-20` updates the due date
6. Reviews scheduled at `09:00`, `17:00`, and `Mon 09:30` post to the control room
7. Heartbeat only posts when overdue, blocked, or stale work requires attention
8. Conversation continues in the same thread after a bot restart
9. Optional: new AIC issues created in Linear trigger only safe automatic actions
10. Optional: `pdf / docx / md` attachments can be read from the thread
11. Optional: when `OPENAI_API_KEY` is set, audio/video attachments are lazily transcribed
12. `@other-user` posts without a Cogito mention are still suppressed deterministically
13. Clearly other-directed plain-text posts can also be suppressed through the LLM-first classifier
14. Suppressed coordination threads still persist thread log and attachments, and only create an external-coordination hint when a safe owner-map-backed target can be resolved

## Tests

```bash
npm test
```

## Operator Diagnostics

`manager:diagnostics` uses the same `.env` as the app runtime. Use `./workspace` when running from a host-side repo checkout. The deployed `exe.dev` image does not bundle `scripts/manager-diagnostics.ts`, so production verification on `exe.dev` should either run from the host checkout or use a one-off container that mounts both `scripts/` and `workspace/`.

Inspect thread interpretation:

```bash
npm run manager:diagnostics -- thread C0ALAMDRB9V 1773806473.747499 ./workspace
```

Inspect the bundled incident view for a thread:

```bash
npm run manager:diagnostics -- incident C0ALAMDRB9V 1773806473.747499 ./workspace
```

Inspect issue context:

```bash
npm run manager:diagnostics -- issue AIC-38 ./workspace
```

Inspect recent webhook deliveries:

```bash
npm run manager:diagnostics -- webhook ./workspace
```

Inspect runtime state-file classifications:

```bash
npm run manager:diagnostics -- state-files ./workspace
```

Inspect personalization state and the current runtime `AGENTS.md` / `MEMORY.md`:

```bash
npm run manager:diagnostics -- personalization ./workspace
```

Inspect `MEMORY.md` project coverage and current-state contamination warnings:

```bash
npm run manager:diagnostics -- memory ./workspace
```

Inspect current LLM runtime config and payload preview:

```bash
npm run manager:diagnostics -- llm ./workspace
```

Inspect the lightweight external-boundary smoke checks:

```bash
npm run manager:diagnostics -- boundaries ./workspace
```

Minimal `exe.dev` one-off container example for `boundaries`:

```bash
docker run --rm \
  --env-file /home/exedev/cogito-work-manager/.env \
  -v /home/exedev/cogito-work-manager/scripts:/app/scripts:ro \
  -v /home/exedev/cogito-work-manager/workspace:/workspace \
  cogito-work-manager-bot \
  npm run manager:diagnostics -- boundaries /workspace
```

If `ANTHROPIC_API_KEY` is present, `authSource.source` is `runtime-override`. If it is absent and `workspace/.pi/agent/auth.json` is used, it becomes `auth-storage`. When comparing local and `exe.dev`, focus on `configured.model`, `configured.thinkingLevel`, `configured.maxOutputTokens`, `configured.retryMaxRetries`, and `authSource.source`.
