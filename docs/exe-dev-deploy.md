# Deploying `cogito-work-manager` on `exe.dev`

This bot can run with Slack Socket Mode alone. If you also enable the Linear issue-created webhook, you need an additional public HTTP endpoint. On `exe.dev`, the standard deployment model is a VM with Docker Compose and a persistent `./workspace` directory.

## Overview

- VM: `exe.dev` Ubuntu VM
- Runtime: Docker Compose
- Persistent data: `./workspace` under the repo
- Outbound integrations:
  - Slack Socket Mode
  - Anthropic
  - Linear API
  - Optional: Notion API
  - Optional: Linear webhook registration
- Bundled CLI: `linear-cli v2.12.3`

You do not need the `exe.dev` HTTP proxy when running Slack Socket Mode only. You only need a public route when `LINEAR_WEBHOOK_ENABLED=true` and Linear must reach `LINEAR_WEBHOOK_PORT`.

## Prerequisites

Prepare the following before deployment.

- `ssh exe.dev` access
- Slack app credentials
  - `SLACK_APP_TOKEN`
  - `SLACK_BOT_TOKEN`
- Linear credentials
  - `LINEAR_API_KEY`
  - `LINEAR_WORKSPACE`
  - `LINEAR_TEAM_KEY`
  - Optional: `LINEAR_WRITE_TIMEOUT_MS`
  - Optional webhook settings
    - `LINEAR_WEBHOOK_ENABLED`
    - `LINEAR_WEBHOOK_PUBLIC_URL`
    - `LINEAR_WEBHOOK_SECRET`
    - `LINEAR_WEBHOOK_PORT`
    - `LINEAR_WEBHOOK_PATH`
- Optional Notion credentials
  - `NOTION_API_TOKEN`
  - `NOTION_AGENDA_PARENT_PAGE_ID`
- Anthropic authentication
  - Preferred: `ANTHROPIC_API_KEY`
  - Alternative: `~/.pi/agent/auth.json`
- Optional OpenAI credentials
  - `OPENAI_API_KEY`
  - Only required when you want audio/video attachment transcription

## 1. Create a VM

```bash
ssh exe.dev new --name pi-linear-bot
```

Then connect:

```bash
ssh pi-linear-bot.exe.xyz
```

## 2. Clone the Repo

```bash
git clone https://github.com/kyaukyuai/cogito-work-manager.git
cd cogito-work-manager
```

If the repo is private, use `gh auth login` or a deploy key.

## 3. Prepare Environment Variables

Create `.env` from the example:

```bash
cp .env.example .env
```

Minimum recommended `.env`:

```env
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...
SLACK_ALLOWED_CHANNEL_IDS=C0ALAMDRB9V
LINEAR_API_KEY=lin_api_...
LINEAR_WORKSPACE=kyaukyuai
LINEAR_TEAM_KEY=AIC
LINEAR_WRITE_TIMEOUT_MS=30000
LINEAR_WEBHOOK_ENABLED=false
LINEAR_WEBHOOK_PUBLIC_URL=https://example.com
LINEAR_WEBHOOK_SECRET=replace-with-long-random-secret
LINEAR_WEBHOOK_PORT=8787
LINEAR_WEBHOOK_PATH=/hooks/linear
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-openai-...
BOT_MODEL=claude-sonnet-4-6
BOT_THINKING_LEVEL=minimal
BOT_MAX_OUTPUT_TOKENS=
BOT_RETRY_MAX_RETRIES=1
BOT_UID=1000
BOT_GID=1000
WORKSPACE_DIR=/workspace
HEARTBEAT_INTERVAL_MIN=30
HEARTBEAT_ACTIVE_LOOKBACK_HOURS=24
SCHEDULER_POLL_SEC=30
WORKGRAPH_MAINTENANCE_INTERVAL_MIN=15
WORKGRAPH_HEALTH_WARN_ACTIVE_EVENTS=200
WORKGRAPH_AUTO_COMPACT_MAX_ACTIVE_EVENTS=500
LOG_LEVEL=info
NOTION_API_TOKEN=secret_...
NOTION_AGENDA_PARENT_PAGE_ID=notion-page-id-...
```

Notes:

- `SLACK_ALLOWED_CHANNEL_IDS` accepts comma-separated channel ids.
- `LINEAR_TEAM_KEY` must be a team key such as `AIC` or `KYA`, not a UUID.
- When `NOTION_API_TOKEN` is set, the bundled `ntn v0.4.0` enables page search, page facts, page content excerpts, database search, and database query.
- When `NOTION_AGENDA_PARENT_PAGE_ID` is also set, agenda pages can be created under that parent page.
- Existing Notion pages can be updated through title changes, append operations, `replace_section` updates limited to `heading_2` sections on Cogito-managed pages, and archive/trash actions. Database row updates and deletes are currently unsupported.
- `/workspace/system/AGENTS.md` can store durable operating rules and reply policies.
- `/workspace/system/MEMORY.md` can store terminology, background knowledge, project overview, members and roles, and roadmap or milestone context. Do not store issue-level due dates or current status there.
- `/workspace/system/AGENDA_TEMPLATE.md` can define the default structure for Notion agendas.
- Runtime `AGENTS.md` and `MEMORY.md` are silent auto-update targets. Candidate facts are written to `/workspace/system/personalization-ledger.json`.
- The repo-root `AGENTS.md` is for development only and is not used as runtime customization.
- If `LINEAR_WEBHOOK_ENABLED=true`, you must also set `LINEAR_WEBHOOK_PUBLIC_URL` and `LINEAR_WEBHOOK_SECRET`.
- The webhook listener binds to `LINEAR_WEBHOOK_PORT` and `LINEAR_WEBHOOK_PATH`.
- Webhook scope is `Issue create` only. No-op stays silent; committed actions and failures notify the control room.
- Headless production setups should prefer `ANTHROPIC_API_KEY`.
- `OPENAI_API_KEY` enables audio/video attachment transcription. Without it, `pdf / docx / txt / md / csv / json` extraction still works, and video/audio remains metadata-only.
- Attachment transcription is lazy on first read, audio-based only, and falls back to metadata-only for files over the 30-minute cap.
- `BOT_THINKING_LEVEL` accepts `off | minimal | low | medium | high | xhigh`.
- `BOT_MAX_OUTPUT_TOKENS` injects `maxTokens` on every LLM call when set.
- `BOT_RETRY_MAX_RETRIES` maps to the SDK retry limit.
- `BOT_UID` / `BOT_GID` keep runtime files owned by the host user. On `exe.dev`, `1000:1000` is usually correct.
- `HEARTBEAT_INTERVAL_MIN=30` is a reasonable default if you want manager review and heartbeat enabled.
- `WORKGRAPH_MAINTENANCE_INTERVAL_MIN=15` runs health checks and auto-compaction checks every 15 minutes.
- `WORKGRAPH_AUTO_COMPACT_MAX_ACTIVE_EVENTS` controls when active `workgraph-events.jsonl` is compacted into the snapshot.

## 4. Optional: Use `auth.json` Instead of `ANTHROPIC_API_KEY`

Only use this if you are not providing `ANTHROPIC_API_KEY`.

From your local machine:

```bash
scp ~/.pi/agent/auth.json pi-linear-bot.exe.xyz:/home/exedev/cogito-work-manager/.pi-auth.json
```

Inside the VM:

```bash
mkdir -p workspace/.pi/agent
cp .pi-auth.json workspace/.pi/agent/auth.json
chmod 600 workspace/.pi/agent/auth.json
```

This is less stable than API-key based auth because it depends on OAuth token freshness.

## 5. Start the Bot

```bash
docker compose up -d --build
```

This image bundles `linear-cli v2.12.3` and `ntn v0.4.0`.

Linear runtime assumptions:

- `issue list/view/create/update --json`
- `issue comment add --json`
- `issue relation add/list --json`
- `team members --json`
- `issue parent/children --json`
- `issue create-batch --file ... --json`
- `webhook list/create/update --json`
- `linear capabilities --json` for runtime-surface validation at startup and in diagnostics

The bot accepts the additive `stateName` field from `issue list --json` while remaining compatible with nested `state.name`. Multiline descriptions and comments use `--description-file` and `--body-file`. Relation add is treated as retry-safe. High-value issue writes can use `LINEAR_WRITE_TIMEOUT_MS` to prefer `timeout_error`; when unset, the repo passes `25000ms`. If `timeout_error` includes `appliedState` or `callerGuidance`, the runtime preserves them for reconciliation.

Slack attachment behavior:

- `pdf / docx / txt / md / csv / json` are eagerly extracted
- audio/video can be lazily transcribed when `OPENAI_API_KEY` is present
- plain-text other-directed messages are evaluated by an LLM-first classifier before public suppression
- suppression and external-coordination hint creation are separate; the thread may stay publicly silent even when no safe hinted Slack target can be stored

Notion behavior:

- page search / page facts / page content excerpt / database search / database query
- agenda page creation under the configured parent page
- title updates, append writes, `replace_section` on managed pages, archive/trash

Check logs:

```bash
docker compose logs -f
```

Expected startup logs include:

- `Slack assistant starting`
- `Slack assistant connected`
- Optional: `Linear issue-created webhook reconciled`
- Optional: `Linear webhook listener started`

## 6. Verify in Slack

Test in an allowlisted channel. Mentioning the bot is not required.

Simple conversation:

```text
Hello
```

Autonomous issue creation:

```text
Add a task for tomorrow's meeting preparation with Tahira-san
```

Task split:

```text
- Investigate the login issue
- Check whether the root cause is on the API side
- Summarize the fix direction
```

List active work:

```text
Show my tasks
```

Complete an issue:

```text
Mark AIC-2 as done
```

Change a due date:

```text
Set AIC-2 due on 2026-03-20
```

Expected behavior:

- The bot replies in a thread
- Clear requests are turned into Linear issues
- Complex requests are split into a parent plus child issues
- Relative dates create due dates
- `Show my tasks` returns active issues
- Conversation continues in the same Slack thread
- Attachment catalogs are created for `pdf / docx / md` and can be read from the manager agent
- When `OPENAI_API_KEY` is set, audio/video attachments are lazily transcribed on first read
- `@other-user` posts that do not mention Cogito are publicly ignored deterministically
- Clearly other-directed plain-text posts can also be publicly ignored through an LLM-first classifier
- Suppressed coordination threads still save thread state and attachments
- If such a coordination thread resolves exactly to an existing issue and to a safe hinted Slack target, later short replies can update that hinted issue
- `Please lower the priority too` in a single-issue follow-up thread is treated as a priority change, not a state change
- Manager review jobs run at `09:00`, `17:00`, and `Mon 09:30`
- Optional: a newly created AIC issue in Linear triggers only safe automatic handling

## 7. Restart and Updates

Update the code:

```bash
git pull
docker compose up -d --build
```

If `BOT_UID` and `BOT_GID` are set, startup will align `/workspace/system` and `/workspace/threads` to those ids and then run the bot under that same uid/gid. This also repairs older root-owned runtime files from previous deployments.

Stop the bot:

```bash
docker compose down
```

## 8. Manager System Files

At startup, the bot creates the following files in `/workspace/system`:

- `policy.json`
- `owner-map.json`
- `followups.json`
- `planning-ledger.json`
- `workgraph-events.jsonl`
- `workgraph-snapshot.json`
- `jobs.json`
- `job-status.json`
- `HEARTBEAT.md`
- `AGENTS.md`
- `MEMORY.md`
- `AGENDA_TEMPLATE.md`
- `notion-pages.json`
- `personalization-ledger.json`
- `webhook-deliveries.json`
- `sessions/`

Classification:

- `editable`: `policy.json`, `owner-map.json`, `jobs.json`, `HEARTBEAT.md`, runtime `AGENTS.md`, `MEMORY.md`, `AGENDA_TEMPLATE.md`
- `internal`: `job-status.json`, `followups.json`, `planning-ledger.json`, `notion-pages.json`, `personalization-ledger.json`, `webhook-deliveries.json`
- `derived`: `workgraph-events.jsonl`, `workgraph-snapshot.json`, `sessions/`

Meaning:

- `editable` can be changed directly by the operator
- `internal` is system-maintained and should generally be treated as read-only
- `derived` is generated and should not be edited manually

Update policy:

- `silent-auto-update`: runtime `AGENTS.md`, `MEMORY.md`
- `explicit-slack-update`: `AGENDA_TEMPLATE.md`, `HEARTBEAT.md`, `owner-map.json`
- `manager-commit-only`: `policy.json`, `jobs.json`
- `system-maintained`: `job-status.json`, `followups.json`, `planning-ledger.json`, `notion-pages.json`, `personalization-ledger.json`, `webhook-deliveries.json`
- `rebuild-only`: `workgraph-events.jsonl`, `workgraph-snapshot.json`, `sessions/`

`explicit-slack-update` means silent updates are not allowed. `AGENDA_TEMPLATE.md` and `HEARTBEAT.md` are replaced only from explicit Slack requests through manager commit. `owner-map.json` is changed only through structured proposals and preview/confirm flow.

Person-to-person Slack coordination is split into three categories:

1. Explicit outbound post
   - A manager-commit action that posts a single message to a single known Slack user.
   - Default destination is the current thread; control room root is opt-in.
2. Review or heartbeat follow-up mention
   - Internal notification only, not arbitrary freeform posting.
3. External coordination thread
   - A post that mentions another person but does not mention Cogito.
   - Publicly ignored, but thread state and attachments are still persisted.
   - If the runtime can resolve an exact existing issue, it stores `scratch/external-coordination-hint.json`.
   - Later short replies such as `Thanks`, `I'll confirm`, `Shared`, or `I'll send this to legal` can become progress or comments on that hinted issue.
   - Only `Backlog -> In Progress` is auto-promoted from this hinted path; all other state changes still require explicit signals.
4. System-generated root thread
   - A top-level review, heartbeat, scheduler, or webhook post.
   - The runtime persists the posted assistant root message into the actual Slack thread workspace and stores typed issue refs in `scratch/system-thread-context.json`.
   - If an older pre-AIC-119 system thread is missing that file, the next human follow-up can lazily recover it from the actual root Slack post before manager handling continues.
   - Later human follow-ups in that real Slack thread can reuse those issue refs as strong hints, including partial-success updates such as lowering one issue's priority while replying that another subtopic has no matching issue.

If `BOT_UID` and `BOT_GID` are correct, these files remain editable by the host operator without `sudo`.

`policy.json` also controls follow-up mention behavior. By default, `blocked / overdue / due_today / due_soon` mention on the first follow-up, while `stale / owner_missing` mention only after one unresolved repeat.

Slack is also the preferred interface for scheduler management. Typical examples:

- `Show me the schedule list`
- `Show me the manager-review-evening configuration`
- `Add a job to review upcoming AIC deadlines every day at 09:00`
- `Move daily-task-check to 17:00`
- `Delete daily-task-check`
- `Run weekly-notion-agenda-ai-clone now`
- `Move the morning review to 08:30`
- `Stop the evening review`
- `Set heartbeat to every 60 minutes`

Notes:

- Built-in review and heartbeat live in `policy.json`
- Only custom jobs are written to `jobs.json`
- `nextRunAt`, `lastRunAt`, `lastStatus`, `lastResult`, and `lastError` live in `job-status.json`
- A built-in `delete` request is implemented internally as `disable`
- Immediate execution of built-in review and heartbeat is out of scope

## 9. Workgraph Maintenance and Diagnostics

Check current workgraph health:

```bash
npm run workgraph:health -- ./workspace
```

Rebuild only the snapshot:

```bash
npm run workgraph:snapshot -- ./workspace
```

Compact the active event log into the snapshot:

```bash
npm run workgraph:compact -- ./workspace
```

Inspect thread or issue context:

```bash
npm run manager:diagnostics -- thread C0ALAMDRB9V 1773806473.747499 ./workspace
npm run manager:diagnostics -- incident C0ALAMDRB9V 1773806473.747499 ./workspace
npm run manager:diagnostics -- issue AIC-38 ./workspace
npm run manager:diagnostics -- webhook ./workspace
npm run manager:diagnostics -- state-files ./workspace
npm run manager:diagnostics -- personalization ./workspace
npm run manager:diagnostics -- memory ./workspace
npm run manager:diagnostics -- workgraph ./workspace
npm run manager:diagnostics -- llm ./workspace
npm run manager:diagnostics -- boundaries ./workspace
```

`manager:diagnostics` reads the repo `.env` and builds the same runtime config as the app. When `ANTHROPIC_API_KEY` is set, `authSource.source=runtime-override`. When it is unset and `workspace/.pi/agent/auth.json` is used, `authSource.source=auth-storage`.

`incident` bundles the last reply, last manager turn, proposal/commit outcome, query continuation, pending clarification, and workgraph context for a thread.

`boundaries` is a lightweight external-dependency smoke check:

- Linear: `linear-cli` version, `auth whoami`, `linear capabilities --json`, and `team list` verification against `LINEAR_TEAM_KEY`
- Notion: `ntn` binary, `--help`, and shell command contract
- Web research: fixture-drift guidance for the DuckDuckGo parser; diagnostics do not perform live fetches

Comparing local vs `exe.dev`:

1. On a local host checkout, run `npm run manager:diagnostics -- llm ./workspace`
2. On the `exe.dev` host checkout, run `npm run manager:diagnostics -- llm ./workspace`
3. To verify the deployed image itself, use a one-off container:

```bash
docker run --rm \
  --env-file /home/exedev/cogito-work-manager/.env \
  -v /home/exedev/cogito-work-manager/scripts:/app/scripts:ro \
  -v /home/exedev/cogito-work-manager/workspace:/workspace \
  cogito-work-manager-bot \
  npm run manager:diagnostics -- llm /workspace
```

4. Compare `configured.model`, `configured.thinkingLevel`, `configured.maxOutputTokens`, `configured.retryMaxRetries`, and `authSource.source`
5. If a difference remains, inspect `.env`, VM credential placement, and whether `auth.json` is being used

You can check `boundaries` the same way:

```bash
docker run --rm \
  --env-file /home/exedev/cogito-work-manager/.env \
  -v /home/exedev/cogito-work-manager/scripts:/app/scripts:ro \
  -v /home/exedev/cogito-work-manager/workspace:/workspace \
  cogito-work-manager-bot \
  npm run manager:diagnostics -- boundaries /workspace
```

Replay recovery:

1. Stop the bot

```bash
docker compose down
```

2. Back up the current workgraph files

```bash
cp workspace/system/workgraph-events.jsonl workspace/system/workgraph-events.jsonl.bak
cp workspace/system/workgraph-snapshot.json workspace/system/workgraph-snapshot.json.bak
```

3. Replay the active event log and rebuild the snapshot

```bash
npm run workgraph:recover -- ./workspace
```

4. Restart the bot and confirm the logs

```bash
docker compose up -d --build
docker compose logs --tail 20 bot
```

Notes:

- `workgraph:recover` rebuilds a fresh snapshot from the current `workgraph-events.jsonl`
- If `workgraph:compact` already emptied the active log, full replay requires the pre-compaction backup or the snapshot
- After recovery, confirm that `Slack assistant connected` appears again

Example heartbeat prompt:

```bash
mkdir -p workspace/system
cat > workspace/system/HEARTBEAT.md <<'EOF'
You are running a periodic heartbeat for this Slack channel.
Check active Linear issues and only report one short actionable update.
If nothing is worth posting, reply exactly HEARTBEAT_OK.
EOF
```

Example custom job file:

```bash
cat > workspace/system/jobs.json <<'EOF'
[
  {
    "id": "daily-task-check",
    "enabled": true,
    "channelId": "C0ALAMDRB9V",
    "prompt": "Review upcoming AIC deadlines",
    "kind": "daily",
    "time": "09:00"
  }
]
EOF
```

## 10. Optional: Run on Boot

The Compose file already uses `restart: unless-stopped`, so containers recover automatically after a Docker daemon restart. If you want stronger host-boot control, wrap `docker compose up -d` in `systemd`, but that is optional for v1.

## 11. Notes on `exe.dev`

- `exe.dev` is a VM environment, so standard Docker workflows work as-is
- No public HTTP proxy is required for Slack Socket Mode
- If you later expose a web UI or a health endpoint, `exe.dev` can proxy ports in the `3000-9999` range
