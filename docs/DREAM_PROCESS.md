# Graph Memory System — Dream Process Design

## Overview

The dream process is a **Claude Code scheduled task** that reads conversation transcripts, extracts entities and relationships, and updates the graph. It runs AS a Claude Code session — meaning Claude itself does the extraction and reasoning, covered by the Max plan. **No separate API key needed.** This is the default path. An optional [API-key runner](#api-key-runner) runs the same prompt through the Messages API instead.

## Key Architectural Decision

In the default setup, the dream process is NOT a standalone script calling the Claude API. It's a scheduled task prompt that Claude executes as a session. This means:
- Entity extraction = Claude reading transcripts and reasoning (Max plan)
- Graph updates = Claude calling MCP tools (graph_relate, graph_boost, etc.)
- Changelog writing = Claude writing files (standard tool)
- In the default scheduled task: no `@anthropic-ai/sdk` use, no API key management, no token cost tracking

The [API-key runner](#api-key-runner) is the opt-in exception. It runs the same prompt through the Messages API (it uses `@anthropic-ai/sdk`, reads an API key and estimates cost), for people who want the dream billed to an API key instead of a Claude plan. The Claude Code scheduled task remains the default.

## Trigger Model

### Primary: Scheduled Task (Nightly)

Stored at `~/.claude/scheduled-tasks/graph-dream-nightly/SKILL.md`. Configured via Claude Desktop's Schedule UI or by asking Claude to schedule it. The SKILL.md file contains the prompt; the schedule (time, recurrence) is set in the Desktop UI. See the full prompt later in this document.

1. Claude reads `~/graph-memory/processed/manifest.json`
2. If no unprocessed transcripts or ingest docs → exit early
3. If pending → run full dream pipeline

### Fallback: SessionStart Hook
```
On every Claude Code session start:
  node check-pending.js
    → Reads manifest.json (< 1ms)
    → Checks ingest/pending/ folder
    → If nothing new → exit (< 2 seconds)
    → If pending AND last dream > 4 hours ago → outputs reminder
    → (Does NOT run extraction — just alerts)
```

The hook is a lightweight Node.js script that checks file timestamps. No LLM call. It can output a notice that pending work exists, prompting the user to run `/graph-dream` if they want immediate processing.

### On-Demand: /graph-dream Skill
```
/graph-dream              # process all pending
/graph-dream --dry-run    # show what would change
/graph-dream --ingest-only # only process drop folder
```

## Transcript Source

Claude Code stores full conversation transcripts locally:

```
~/.claude/projects/<project-path>/<session-id>.jsonl
```

Each JSONL line is a JSON object with fields including:
- `type` — message type
- `message` — content with role
- `timestamp` — when it occurred
- `sessionId` — UUID
- `cwd` — working directory (provides project context)
- `model` — which model was used

**Chunking for large transcripts:** Long sessions (100k+ tokens) need to be processed in chunks. The dream prompt instructs Claude to:
1. Read the first N lines of a JSONL file
2. Extract entities from that chunk
3. Continue to the next chunk
4. Merge results across chunks before writing to graph

### Cloud sessions and Claude Code Projects

Sessions that run in Anthropic's cloud (Claude Code on the web, cloud sessions started from the mobile or desktop app, and Claude Code Projects threads and coordinators) don't write to `~/.claude/projects/` on the home machine, so the dream can't see them. Remote Control sessions are the exception: they run on the home machine and write local transcripts as usual.

The cloud-session collector bridges the gap. It is a recurring scheduled task that runs in the cloud, inside a Project thread (`prompts/collect-cloud-sessions.md`):

```
cloud collector (scheduled, in a Project thread)
  ├── list_thread_sessions / fetch_thread    ← this Project's threads
  ├── fetch_project_timeline                 ← this Project's coordinator
  ├── list_sessions / list_events            ← other cloud sessions
  └── graph_ingest queue (content + meta)    → Graph-Memory connector → ingest/pending/ at home
                                                        │
nightly dream (home machine) ───────────────────────────┘ Step 5b, extracted as conversation
```

It sends text with `graph_ingest`'s inline `content` + `file_name` mode, which is admin-tenant only. Each queued document carries `meta.source: "claude-code-cloud"`, `meta.session_id` and `meta.through`; `graph_ingest status` returns the newest `through` per session as `session_cursors`, so each run only queues what is new. Project sessions are only visible from inside their own Project, so each Project needs its own collector thread.

## Pipeline Stages

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  1a. Discover │     │  2. Claude   │     │  3. Claude   │
│  Transcripts  │────▶│  Extracts    │────▶│  Calls MCP   │
│               │     │  Entities    │     │  to Update   │
│  1b. Discover │────▶│  (reasoning) │     │  Graph       │
│  Ingest Docs  │     │              │     │              │
└──────────────┘     └──────────────┘     └──────────────┘
                                                  │
                                                  ▼
                     ┌──────────────┐     ┌──────────────┐
                     │  5. Write    │◀────│  4. Call      │
                     │  Changelog   │     │  graph_decay  │
                     │  + Manifest  │     │  (maintenance)│
                     └──────────────┘     └──────────────┘
```

### Stage 1a: Discover Transcripts

Claude reads `~/graph-memory/processed/manifest.json`:

```json
{
  "last_dream_run": "2026-04-06T22:47:00Z",
  "transcript_format_version": "1.0",
  "processed": {
    "2eee37f4-4467-448c-8390-1593e6b2447a": {
      "path": "~/.claude/projects/<encoded-project-dir>/2eee37f4.jsonl",
      "processed_at": "2026-04-06T22:47:00Z",
      "entities_extracted": 8,
      "edges_created": 15,
      "file_size_bytes": 932000,
      "line_count": 450
    }
  }
}
```

Claude lists JSONL files in `~/.claude/projects/`, compares against manifest, identifies unprocessed ones.

**Transcript format versioning:** The manifest tracks a `transcript_format_version`. If the JSONL format changes between Claude Code versions (field names, structure, etc.), the dream prompt detects unexpected fields or missing expected fields and logs a warning rather than producing garbage extractions. The prompt instructs Claude to inspect the first few lines of an unprocessed transcript and verify the expected fields (`type`, `message`, `timestamp`, `sessionId`, `cwd`) exist before proceeding.

### Stage 1b: Discover Ingest Documents

Claude checks `~/graph-memory/ingest/pending/` for any files.

**Supported formats:**
| Format | Handling |
|--------|----------|
| `.md`, `.txt` | Read directly |
| `.srt`, `.vtt` | Claude strips timestamps, reads as text |
| `.json` | Claude reads structured data |
| `.html` | Claude reads and ignores markup |
| `.pdf`, `.docx` | Deferred to later phase (scope management) |

**Optional `.meta.json` sidecar** provides context:
```json
{
  "source": "YouTube transcript",
  "author": "Andrej Karpathy",
  "date": "2026-04-04",
  "topic_hints": ["knowledge management", "LLMs"]
}
```

### Stage 2: Entity Extraction (Claude's Reasoning)

For each transcript/document, Claude reads the content and extracts structured information. This is NOT an API call to a separate model — it's Claude in the scheduled task session reasoning about the content.

**What Claude extracts:**
- **Entities:** People, projects, technologies, preferences, decisions, facts
- **Relationships:** How entities connect, with evidence and confidence
- **Reinforcements:** Knowledge that was confirmed or repeated
- **Corrections:** Previous knowledge that was updated
- **Contradictions:** Conflicting information

**Entity resolution:** Claude checks existing entities via `graph_entities` MCP tool before creating new ones. Uses full-text search for fuzzy matching. When uncertain, creates new and flags for review.

**Strict merge policy (fixes reviewer concern):** Claude should NEVER merge entities unless highly confident. Duplicates are preferable to false merges. The changelog flags suspected duplicates for manual review.

**Large transcript handling:** Transcripts over the configured `chunk_size_lines` (default 500, set in `config.json`) are processed in chunks:

1. Claude reads the first chunk, extracts entities/relationships
2. Writes those to the graph via MCP tools
3. Reads the next chunk, extracts more
4. Merges with what was already written (existing entities get boosted, new ones get created)
5. Continues until the file is exhausted

For extremely large sessions (35MB+), Claude first samples ~100 lines spread evenly through the file to identify the main topics, then processes in chunks with that context. This prevents the same entity from being created multiple times across chunks because Claude knows what to expect.

**Merge audit log:** Every entity merge (when Claude determines two entities are the same) is recorded in `~/graph-memory/logs/merge-audit.jsonl`:

```json
{
  "timestamp": "2026-04-06T22:50:00Z",
  "action": "merge",
  "kept_entity": { "id": "auth-module", "type": "Project", "name": "auth module" },
  "merged_entity": { "id": "auth-project", "type": "Project", "name": "auth project" },
  "confidence": 0.9,
  "evidence": "Same codebase discussed in both contexts, same people involved",
  "edges_transferred": 5,
  "dream_run": "2026-04-06",
  "reversible": true
}
```

This audit trail enables:
- Reviewing all merges after a dream run
- Reversing bad merges using `graph_unmerge` MCP tool with the audit log as reference
- Tracking merge confidence over time to improve resolution quality

### Stage 3: Graph Updates (MCP Tool Calls)

Claude calls MCP tools to write to the graph:

- `graph_relate` — create entities and relationships
- `graph_boost` — strengthen existing relationships that were confirmed
- `graph_weaken` — reduce weight on corrected information
- `graph_relate` with CONTRADICTS type — flag contradictions

All updates happen within Neo4j transactions (ACID). If the process crashes mid-update, the current transaction rolls back — no partial state (fixes reviewer concern).

### Stage 4: Maintenance

Claude calls `graph_decay` MCP tool to apply time-based decay:
- All nodes get confidence recalculated based on `last_seen`
- All edges get weight recalculated based on `last_confirmed`
- Nodes/edges below threshold are flagged (not deleted)

### Stage 5: Changelog

Claude writes a markdown changelog:

```markdown
# Dream Process — 2026-04-06

## Summary
- Processed: 3 transcripts, 1 ingest document
- Entities: 5 created, 12 updated, 0 pruned
- Edges: 3 created, 18 strengthened, 2 weakened
- Contradictions: 1 new (unresolved)

## New Entities
- **Project:graph-memory** (confidence: 0.7) — new project for graph-based memory
- **Concept:neo4j** (confidence: 0.6) — graph database choice

## Reinforcements
- alice PREFERS TypeScript: 0.7 → 0.75
- alice KNOWS_ABOUT MCP-servers: 0.6 → 0.65

## Flagged for Review
- Potential duplicate: "auth project" and "authentication module" (not merged)
```

Claude updates `manifest.json` **incrementally after each transcript** (not batched at the end) to prevent reprocessing if the dream crashes mid-run. Ingest files are moved from `pending/` to `completed/` at the end.

## Scheduled Task Prompt

The nightly prompt lives in [`prompts/dream-nightly.md`](../prompts/dream-nightly.md). That file is the source of truth; this document doesn't copy it. The API-key runner reads the same file as its system prompt. Its changelog path is `~/graph-memory/logs/YYYY-MM-DD-HHMMSS.md`, so each run gets its own file.

The prompt covers these steps, in order: read `config.json`, read the manifest and check `ingest/pending/`, process up to `max_transcripts_per_run` transcripts oldest first (updating the manifest after each one), process pending ingest documents, call `graph_decay`, write the changelog, move ingest files to `completed/`, and release the lock. Its rules include: never auto-delete or prune, don't merge entities unless sure, and never store secret values.

## Configuration

```json
// ~/graph-memory/config.json
{
  "dream": {
    "cooldown_hours": 4,
    "max_transcripts_per_run": 10,
    "chunk_size_lines": 500
  },
  "weights": {
    "explicit_statement": 0.7,
    "inferred": 0.3,
    "from_memory_file": 0.5,
    "boost_on_confirm": 0.15,
    "boost_on_mention": 0.05,
    "weaken_on_correct": 0.3,
    "project_context_boost": 0.10
  },
  "decay": {
    "rates": {
      "Person": 0.998,
      "Project": 0.995,
      "Preference": 0.999,
      "Concept": 0.999,
      "Decision": 0.997,
      "Fact": 0.996,
      "Event": 0.993,
      "Object": 0.996
    },
    "edge_rate": 0.997,
    "prune_node_threshold": 0.1,
    "prune_edge_threshold": 0.05,
    "prune_orphan_days": 30
  }
}
```

## Error Handling

Since the dream process IS a Claude Code session, error handling is conversational:
- If Neo4j is down: Claude notices MCP tool failures and reports in the changelog
- If a transcript is unreadable: Claude skips it and logs the error
- If entity extraction produces nothing useful: Claude notes it and moves on
- If the process is interrupted: Neo4j transactions ensure no partial state. Next run picks up where it left off via the manifest.

## Weekly Deep Dream

This is the Claude Code version. A separate scheduled task stored at `~/.claude/scheduled-tasks/graph-dream-weekly/SKILL.md`. Configured via the Claude Desktop Schedule UI on a weekly cadence. Its prompt is [`prompts/dream-weekly.md`](../prompts/dream-weekly.md).

This session:
- Calls `graph_stats` for overall health
- Calls `graph_contradictions` to find all conflicts
- Queries for stale entities, orphans, and weak clusters
- Writes a weekly report to `~/graph-memory/logs/weekly/YYYY-MM-DD.md`
- Suggests consolidation or cleanup actions. It doesn't modify the graph.

The API-key runner has a different weekly job, `--job weekly`. It runs [`prompts/weekly-maintenance.md`](../prompts/weekly-maintenance.md), which also backs up and prunes, and writes `~/graph-memory/logs/weekly-reports/YYYY-MM-DD.md`. See [Weekly maintenance](#weekly-maintenance) below.

## API-key runner

An optional way to run the nightly dream on an Anthropic API key instead of a Claude plan. It runs the same `prompts/dream-nightly.md`, through the Messages API, from a small Node program in `src/dream-runner/`. Nothing about the graph, the manifest or the changelog changes; only who pays for the tokens does.

### How it works

```
graph-dream container (or a Task Scheduler job)
  └── node dist/dream-runner/index.js
        ├── discovery (manifest, projects dir, ingest/pending)  → exits with no API call if nothing is new
        ├── acquires processed/dream.lock (source "api-runner")
        ├── spawns the MCP server over stdio  → graph_* tools, as LOCAL_TENANT_ID
        ├── file tools confined to ~/graph-memory (read-write) and ~/.claude/projects (read-only)
        └── tool-use loop on the Messages API until the model finishes, then releases the lock
```

- **Prompt.** The system prompt is `~/graph-memory/prompts/dream-nightly.md` (the seeded copy, falling back to the one baked into the image) plus a short "Runner notes" section: the runner holds the lock, there's no shell, MarkItDown isn't available, and what to do when the budget runs out.
- **Discovery is the runner's job.** It compares the projects folder against the manifest itself and puts the exact pending list (session id, path, new or delta, previous `processed_at`) in the first message, so the model never lists the projects folder or reads the manifest. Sessions modified in the last `DREAM_SKIP_ACTIVE_MINUTES` (default 30) are left for the next run, which keeps a live session from being half-processed. The first test run without this spent its whole budget on discovery.
- **Transcripts and manifest.** `read_transcript` pages through a pending session with the canonical parser and applies the delta filter (`since`) before anything reaches the model. `update_manifest` merges one entry into `manifest.json` on disk, with the size, line count and timestamp captured when the file was read. Both stand in for steps the prompt describes with `graph_read_transcript` and hand edits.
- **Tools.** Every graph tool the MCP server lists, except the ones the nightly prompt never calls (`graph_cypher`, `graph_prune`, `graph_reembed`, `graph_export`, `graph_ingest`, `graph_unmerge`) and `graph_read_transcript`, which `read_transcript` replaces; override with `DREAM_EXCLUDE_TOOLS`. File access is `list_dir`, `stat_file`, `read_file`, `write_file`, `move_file` and `delete_file`. The lock file can't be written or deleted through them.
- **Large results.** A tool result over `DREAM_MAX_TOOL_RESULT_CHARS` (default 40,000; transcript pages are 75% of it) is saved under `~/graph-memory/dream-runner/spill/` and the model gets the start plus the path to read on from. The spill folder is removed after the run.
- **Cost controls.** No API call when nothing is pending. Prompt caching on the tools and system prompt. Old tool results are cleared server-side once the conversation gets long (context editing), since the manifest and changelog are on disk. A per-run estimate, `DREAM_MAX_COST_USD` (default $3): at 80% of it the model is told to finish the item in hand, write the changelog and stop, with 20 more turns allowed, and the run is cut off at 1.5x. `DREAM_MAX_TURNS` (default 200) limits API requests per run. The wrap-up allows 20 more requests, even past it.
- **Binary ingest files** (PDF, Office, images) need MarkItDown, which the runner doesn't have. They stay in `pending/` and don't count as pending work, so they don't trigger paid runs on their own.
- **Logs.** Each run writes `~/graph-memory/logs/dream-runner/<timestamp>.log` (one line per turn with the tools called and the running cost estimate) and appends a summary line to `logs/dream-runner/runs.jsonl`. The dream's own changelog and audit log are written as usual.

### API key

The runner reads the key at run time from `ANTHROPIC_API_KEY`, or from the file named by `ANTHROPIC_API_KEY_FILE`. The file can hold the bare key or an `ANTHROPIC_API_KEY=...` line; a folder holding exactly one file also works. The key is never logged, never passed to the MCP server process, and should never be put in `.env` or committed. In compose, set `ANTHROPIC_API_KEY_HOST_FILE` in `.env` to the key file's path on the host; it's mounted read-only at `/run/secrets/anthropic_api_key`.

### Settings

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY_HOST_FILE` | none | Host path of the key file (compose only) |
| `ANTHROPIC_API_KEY_FILE` | none | Runner: path to the key file (set by compose; outside compose, use this or `ANTHROPIC_API_KEY`) |
| `DREAM_SCHEDULE` | `22:47` (compose), `02:30` (runner) | Daily run time for `--daemon`, 24-hour local time |
| `DREAM_TZ` | `UTC` | IANA time zone the schedule is read in (compose sets `TZ` from it) |
| `DREAM_MODEL` | `claude-opus-5-5` | `claude-sonnet-5-5` costs about half as much per token |
| `DREAM_EFFORT` | `medium` | `low`, `medium`, `high`, `xhigh` or `max` |
| `DREAM_MAX_COST_USD` | `3` | Per-run cost estimate. At 80% the model is told to wrap up; the run stops at 1.5x |
| `DREAM_MAX_TURNS` | `200` | API requests per run. The wrap-up allows 20 more, even past this |
| `DREAM_MAX_TOOL_RESULT_CHARS` | `40000` | Tool results over this are saved to a file; the model reads on from there |
| `DREAM_PROMPT` | `~/graph-memory/prompts/dream-nightly.md`, else the copy in the image | Nightly system prompt file |
| `DREAM_WEEKLY_PROMPT` | `~/graph-memory/prompts/weekly-maintenance.md`, else the copy in the image | Weekly system prompt file |
| `DREAM_PROJECTS_DIR` | `~/.claude/projects` (compose: `/root/.claude/projects`) | Transcript folder; read-only to the runner |
| `DREAM_MCP_SERVER` | `dist/mcp-server/index.js` next to the runner | MCP server the runner starts over stdio |
| `DREAM_FALLBACKS` | on for Opus/Sonnet 5.x and Fable 5.1 | `off` disables server-side refusal fallbacks |
| `DREAM_EXCLUDE_TOOLS` | see above | Comma-separated graph tools to hide; empty keeps all |
| `DREAM_SKIP_ACTIVE_MINUTES` | `30` | Leave sessions modified this recently for the next run; `0` turns it off |
| `DREAM_WEEKLY_SCHEDULE` | `off` | Weekly maintenance in the daemon, e.g. `Sun 06:00` |
| `DREAM_WEEKLY_MAX_COST_USD` | `1.5` | Weekly job's budget (per-run estimate) |
| `DREAM_WEEKLY_EXCLUDE_TOOLS` | see Weekly maintenance | Graph tools hidden from the weekly job |
| `DREAM_NOTIFY_TOKEN_HOST_FILE` | none | Compose only: host path of the notify token file, shared with gws-mcp. Sets `DREAM_NOTIFY_TOKEN_FILE` |
| `DREAM_NOTIFY_TOKEN_FILE` | none | Path to the notify token file as the runner sees it. Required outside compose |
| `DREAM_NOTIFY_URL` | compose: `http://gws-mcp:3849/notify`; none in the runner | gws-mcp's notify listener. Required outside compose. Email is off unless this and `DREAM_NOTIFY_TOKEN_FILE` are both set |

### Running it

Pick one of these, and turn off the Claude Desktop scheduled task (`graph-dream-nightly`) once you have, so the two don't both run. If they overlap, the lock makes the second one exit, but each still uses its own budget.

1. **Always-on container.** Add `COMPOSE_PROFILES=dream` and `ANTHROPIC_API_KEY_HOST_FILE=...` to `.env`, then `docker compose up -d`. The `graph-dream` service waits for `DREAM_SCHEDULE` each day. `docker logs graph-memory-dream` shows when the next run is.
2. **Windows Task Scheduler.** Leave the profile off and run `.\scripts\register-dream-task.ps1 -At 22:47` from the graph-memory folder. The task runs `docker compose run --rm graph-dream node dist/dream-runner/index.js --job nightly` daily and catches up after sleep. Docker Desktop must be running at the scheduled time. Options:
   - `-Job weekly -DayOfWeek Sunday -At 06:00` registers the weekly job (`--job weekly`). `-DayOfWeek` defaults to `Sunday`.
   - `-ComposeDir <folder>` sets the folder that holds `docker-compose.yml` and `.env`. It defaults to the current folder.
   - `-TaskName <name>` sets the Task Scheduler name. The default is `graph-memory nightly dream (API key)` or `graph-memory weekly maintenance (API key)`.
   - `-Unregister` removes the task. Add `-Job weekly` to remove the weekly one.

To try one run by hand: `docker compose run --rm graph-dream node dist/dream-runner/index.js` (add `--force` to run even when the quick check finds nothing).

### Weekly maintenance

The same runner can run `prompts/weekly-maintenance.md` with `--job weekly`, or on a schedule in the daemon with `DREAM_WEEKLY_SCHEDULE` (e.g. `Sun 06:00`; off by default). It differs from the nightly job in these ways:

- It always runs; there's no pending check.
- It gets `graph_export`, `graph_cypher` and `graph_prune`, which the prompt's backup, analysis and prune steps need. Hidden by default: `graph_merge` (merging is the reviewer's call, rule 6), `graph_reembed`, `graph_ingest`, `graph_unmerge` and `graph_read_transcript`. Override with `DREAM_WEEKLY_EXCLUDE_TOOLS`.
- Its own budget, `DREAM_WEEKLY_MAX_COST_USD` (default $1.50). Past the wrap-up point the model is told not to run the prune execute step.
- **Email comes from the runner, not the model.** Step 12 needs a shell, Python and `gws`, so the model skips it; once the run finishes, the runner emails the report it wrote (see Email below). The model never gets a mail tool.
- The lock source is `api-runner-weekly`. In the daemon, when both jobs fall due together, the weekly runs first and the nightly right after.

### Email

The runner sends mail after every run when email is set up (`notify.ts`). In compose, that means `DREAM_NOTIFY_TOKEN_HOST_FILE` is set. Outside compose, set both `DREAM_NOTIFY_URL` and `DREAM_NOTIFY_TOKEN_FILE`. Email is off unless both are set.

- **Nightly, completed:** a summary, subject `Graph dream — <date>: <N> sessions, <E> entities, <D> edges (~$cost)`, with the counts `update_manifest` recorded, what discovery found, and the model's closing summary.
- **Nightly, nothing pending:** subject `Graph dream — <date>: nothing new (~$0.00)`. The body says no API call was made, so a quiet night still confirms the runner is alive.
- **Weekly, completed:** the report from `logs/weekly-reports/`, subject `Weekly Graph Maintenance — <date> (<N> action items, ~$cost)`.
- **Any run that doesn't finish cleanly** (error, budget stop, turn limit, refusal, lock held): a short alert with the outcome and the last 40 log lines.

Every mail starts with the run's estimated cost (turns, model) and the API spend so far this calendar month, summed from `logs/dream-runner/runs.jsonl`. These are the runner's estimates from its price table; the Console's usage page is the authority.

Mail goes through gws-mcp's send-only notify listener (`POST /notify` with a bearer token). gws-mcp sends from its `NOTIFY_ACCOUNT` to its fixed `NOTIFY_TO`, so the runner holds no Gmail credential and the token can't mail anyone else. By default the listener's port isn't published: `graph-dream` reaches it as `gws-mcp:3849` over the shared `mcp-notify` docker network, which both compose files declare. Host tasks (`task.js`) can't use that name. Publish the listener on a loopback port (127.0.0.1) so they can reach it. To set it up, write one random value (32+ characters) to a file, point gws-mcp's `NOTIFY_TOKEN_HOST_FILE` and this project's `DREAM_NOTIFY_TOKEN_HOST_FILE` at it, set `NOTIFY_ACCOUNT` and `NOTIFY_TO` for gws-mcp, and restart both. A failed send is logged and never fails the run. The report is plain text (it's Markdown, which reads fine as is).

### Other scheduled tasks

`dist/dream-runner/task.js` runs any other scheduled prompt (a Claude Code scheduled task's SKILL.md, say) on the same API key, with only what its task file grants. There's no shell. A task file is JSON:

```json
{
  "name": "site-daily-check",
  "prompt_file": "C:/Users/you/.claude/scheduled-tasks/site-daily-check/SKILL.md",
  "notes": "Where the prompt says `python tools/stats.py \"...\"`, call stats_query.",
  "model": "claude-sonnet-5-5",
  "effort": "medium",
  "max_cost_usd": 1,
  "workdir": "C:/Users/you/Projects/site",
  "write_paths": ["reports"],
  "commands": [{
    "name": "stats_query",
    "description": "Run one read-only stats query.",
    "exe": "C:/Python312/python.exe",
    "args": ["tools/stats.py"],
    "arg": { "name": "query", "description": "A SELECT statement", "pattern": "^\\s*SELECT\\b" },
    "flags": ["--raw"]
  }],
  "http": [
    { "prefix": "https://api.example.com/graphql", "methods": ["POST"],
      "bearer_file": "~/.example/read-token", "vars": { "ACCOUNT_ID": "~/.example/account-id" } },
    { "prefix": "https://www.example.org/", "methods": ["GET"] }
  ],
  "mcp_servers": [{ "name": "analytics", "command": "C:/Users/you/.local/bin/analytics-mcp.exe",
                    "env": { "GOOGLE_APPLICATION_CREDENTIALS": "C:/Users/you/.creds/adc.json" },
                    "tools": ["run_report"] }],
  "email": { "url": "http://127.0.0.1:3850/notify/site", "token_file": "~/.config/notify-site-token", "max_per_run": 2 }
}
```

What the model gets:

- `list_dir`, `read_file`: anywhere under `workdir`. `write_file`, `edit_file`: only under `write_paths`. Symlinks out are refused.
- One tool per command. The executable and its leading args are fixed. The model supplies one argument, which must match `pattern`, plus flags from `flags`. It's spawned without a shell, in `workdir`, with a 120 s timeout unless the command sets `timeout_s`.
- `http_request` to the listed prefixes and methods. The runner adds the bearer token and fills `{{VAR}}` from files, so the model never sees either.
- The allowlisted tools of each stdio MCP server.
- `send_email`, through a gws-mcp notify profile: the sender and recipient are fixed there, and there's an optional `html` flag. At most `max_per_run` sends per run.

Runs log to `~/graph-memory/logs/dream-runner/<run_id>-<name>.log` and append to the same `runs.jsonl` as the dream, so the dream's "API spend this month" line counts them. If a run doesn't complete, the runner emails an alert through the same profile. These tasks run on the host, not in the container, so they can use local tools. Schedule one with `scripts/register-api-task.ps1 -TaskFile <file> -At HH:MM`. The script:

- Registers the Task Scheduler job `API task - <name>`. `-At` defaults to `08:00`. `-Weekly -DayOfWeek <day>` makes it weekly (the day defaults to Monday). `-RepoDir` defaults to the current folder, which must have a built `dist/`.
- Sets `ANTHROPIC_API_KEY_FILE` to `-ApiKeyFile` for that process only. The default is a file named `claude-api-key` in your user profile folder. The script never reads the key.
- Appends the runner's stderr to `~/graph-memory/logs/dream-runner/<name>.scheduler.log`. Per-run logs stay in the same folder.
- `-Unregister` removes the job. Pass the same `-TaskFile`.

Defaults when a task file leaves them out (`task.ts`): `model` `claude-sonnet-5-5`, `effort` `medium`, `max_cost_usd` `1`, `max_turns` `60`, `log_dir` `~/graph-memory/logs/dream-runner`, `email.max_per_run` `2`. At 80% of `max_cost_usd` the model is told to wrap up, with 10 more turns allowed. The run stops at 1.5x.

### What stays on the subscription

The cloud-session collector (`prompts/collect-cloud-sessions.md`) still runs inside a Claude Code Projects thread, because the tools that list cloud sessions only exist there. It only queues text into `ingest/pending/`; the extraction itself happens in the nightly dream, which is the part this runner moves to the API key.

## Jev judgments (optional)

Two opt-in features use [TypeSafe's Jev](https://docs.typesafe.ai), a model that returns typed judgments (a choice, a probability, a score) instead of text. Input tokens cost $0.042 per million and output is free, so a judgment costs a few hundredths of a cent. Both features are off by default, both have a cost cap, and both keep anything that looks like a personal identifier (an email address, SSN, date of birth or card number) on the machine.

The key is read at run time from the file named by `JEV_API_KEY_FILE` (a bare key, or a `JEV_API_KEY=...` line). In compose, set `JEV_API_KEY_HOST_FILE` in `.env` to the file's host path. It is mounted read-only into `graph-memory-mcp` and `graph-dream`, and `JEV_API_KEY_FILE` is set for you. The key is never logged.

### Verb selection (`JEV_VERB_SELECT=on`)

When `graph_relate` (single or batch) is about to store an edge as `RELATED_TO`, because the writer asked for it or because it asked for a verb outside the vocabulary, Jev picks from the documented verbs in `src/shared/types.ts`, with an explicit "keep RELATED_TO" option. The chosen verb is used only when all of these hold:

- it is in `RELATIONSHIP_TYPES`, and isn't `ALIAS_OF`, `CONTRADICTS` or `SUPERSEDES` (identity-level verbs stay a human call)
- its Choice confidence is at least `JEV_VERB_MIN_CONFIDENCE` (0.55)
- Jev's separate judgment that the evidence names a specific relationship is at least 0.5
- the verb is defined for the source node's type (for example `WORKS_AT` only from a `Person`)

Otherwise the edge is stored as `RELATED_TO`, exactly as before. That includes a timeout (`JEV_TIMEOUT_MS`, 8 s), an HTTP error and a spent cap (`JEV_VERB_MAX_COST_USD_PER_DAY`, $0.05 per server process, reset daily). A relabelled edge carries `verb_selected_by: "jev"`, `verb_selection_confidence` and, when an unknown verb was asked for, `verb_requested`. The tool result lists each decision under `verb_selection` (single) or `verb_selections` (batch). The dream runner's graph server inherits the setting from the `graph-dream` container, so nightly writes use it too.

### Duplicate check (`JEV_DUPLICATE_CHECK=on`)

After a nightly API-runner dream completes, the runner takes up to `JEV_DUPLICATE_LIMIT` (30) candidate pairs from `graph_merge_suggestions` at `JEV_DUPLICATE_MIN_SCORE` (0.6). It reads each entity's description, aliases and relationships with `graph_query`, and asks Jev four questions: `link_state` (a 0-2 score from "different things" to "the same thing"), `one_contains_other`, `name_variant` and `only_shares_context`. A pair is flagged `likely_duplicate` when `link_state >= JEV_DUPLICATE_LINK_FLOOR` (0.3) and `one_contains_other <= JEV_DUPLICATE_CONTAINS_CEILING` (0.4). Those defaults were fitted on a small labelled set, so check them against your own pairs before you rely on them.

Every judged pair is appended to `~/graph-memory/logs/jev-duplicates.jsonl` with its scores and verdict. **Nothing is merged or aliased.** Review the file and use `graph_merge` or `graph_alias` yourself. The run log gets a one-line summary. A failure here is logged and never changes the dream run's outcome. The cap is `JEV_DUPLICATE_MAX_COST_USD` ($0.02 per run).

To run only the check: `docker compose run --rm graph-dream node dist/dream-runner/index.js --job duplicates`. It is read-only and needs no Anthropic key.
