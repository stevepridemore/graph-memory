# Graph Memory System — Dream Process Design

## Overview

The dream process is a **Claude Code scheduled task** that reads conversation transcripts, extracts entities and relationships, and updates the graph. It runs AS a Claude Code session — meaning Claude itself does the extraction and reasoning, covered by the Max plan. **No separate API key needed.**

## Key Architectural Decision

The dream process is NOT a standalone script calling the Claude API. It's a scheduled task prompt that Claude executes as a session. This means:
- Entity extraction = Claude reading transcripts and reasoning (Max plan)
- Graph updates = Claude calling MCP tools (graph_relate, graph_boost, etc.)
- Changelog writing = Claude writing files (standard tool)
- No `@anthropic-ai/sdk` dependency
- No API key management
- No token cost tracking

There is now one opt-in exception: the [API-key runner](#api-key-runner) runs the same prompt through the Messages API for people who want the dream billed to an API key instead of a Claude plan. The Claude Code scheduled task remains the default.

## Trigger Model

### Primary: Scheduled Task (Nightly)

Stored at `~/.claude/scheduled-tasks/graph-dream-nightly/SKILL.md`. Configured via Claude Desktop's Schedule UI or by asking Claude to schedule it. The SKILL.md file contains the prompt; the schedule (time, recurrence) is set in the Desktop UI. See the full prompt later in this document.

1. Claude reads `~/.claude/graph-memory/processed/manifest.json`
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

Claude reads `~/.claude/graph-memory/processed/manifest.json`:

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

Claude checks `~/.claude/graph-memory/ingest/pending/` for any files.

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

**Merge audit log:** Every entity merge (when Claude determines two entities are the same) is recorded in `~/.claude/graph-memory/logs/merge-audit.jsonl`:

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

The nightly dream task prompt (what Claude receives as its session instruction):

```
You are running the graph memory dream process. Your job is to process new conversation
transcripts and ingest documents, extract knowledge, and update the memory graph.

STEPS:

1. READ the config at ~/.claude/graph-memory/config.json for runtime parameters
   (chunk_size_lines, max_transcripts_per_run, etc.). Use hardcoded defaults if missing.

2. READ the manifest at ~/.claude/graph-memory/processed/manifest.json
   - Identify which conversation transcripts have not been processed
   - Check ~/.claude/graph-memory/ingest/pending/ for new documents

3. If nothing is pending, write "No pending work" and exit.

4. For each unprocessed transcript (JSONL files in ~/.claude/projects/),
   up to max_transcripts_per_run (default 10) — process oldest first:
   a. Read the first few lines and verify expected fields exist (type, message,
      timestamp, sessionId, cwd). If the format looks different, log a warning
      and skip this transcript.
   b. Read the file (for large files, process in chunks per config chunk_size_lines,
      default 500 lines)
   c. Extract: entities, relationships, reinforcements, corrections, contradictions
   d. For each entity: check if it exists via graph_entities tool first
   e. NEVER merge entities unless you are highly confident they are the same
   f. Call graph_relate for new entities and relationships. Use batch mode when possible.
      - Always pass provenance: source_session (the sessionId from the JSONL),
        source_transcript (the file path), source_type ("conversation")
      - Always pass valid_at (the timestamp from the JSONL line where the fact was stated)
   g. Call graph_boost for reinforced relationships
   h. Call graph_weaken for corrected information
   i. When a fact supersedes an old one (e.g., tech stack changed), graph_relate handles
      this automatically — it sets invalid_at on the old edge. Note the supersession
      in the changelog.
   j. Track the cwd field for project-context boosting (+0.10 for in-project entities)
   k. For RELATED_TO edges, use only these relationship_type values:
      similar_to, part_of, enables, impacts, depends_on, alternative_to,
      derived_from, implements, extends, configured_by
      If none fit, use the closest match. Do NOT invent new values.
   l. UPDATE manifest.json IMMEDIATELY after each transcript (not batched at end).
      This prevents reprocessing and weight inflation if the dream crashes mid-run.

5. For each pending ingest document:
   a. Read the file and any .meta.json sidecar
   b. Extract entities and relationships (same rules as step 4)
   c. Apply weight guidance from meta if provided
   d. Pass provenance: source_type ("ingest"), source_transcript (the file path)
   e. After processing, note it for moving to completed/

6. Call graph_decay with dry_run: false to apply time-based decay

7. Write a changelog to ~/.claude/graph-memory/logs/YYYY-MM-DD.md
   If max_transcripts_per_run was reached and more transcripts remain, note this
   in the changelog so the next run picks them up.

8. Manifest was updated incrementally in step 4 — verify last_dream_run is current

9. Move processed ingest files from pending/ to completed/

10. Delete the lock file at ~/.claude/graph-memory/processed/dream.lock

IMPORTANT RULES:
- Do NOT auto-delete or prune entities. Only flag them in the changelog.
- When in doubt about entity identity, create a new entity rather than merging.
- Flag suspected duplicates in the changelog for user review.
- If a transcript is very large, process in chunks per config (default 500 lines).
- Always check for existing entities before creating new ones.
- Stop after max_transcripts_per_run transcripts. Remaining work carries to next run.
- NEVER extract API keys, passwords, tokens, secrets, or credentials into graph entities.
  Note the existence of a credential but NEVER the value.
- Always delete the lock file when done, even on failure.
```

## Configuration

```json
// ~/.claude/graph-memory/config.json
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
  },
  "resolution": {
    "merge_only_when_confident": true,
    "flag_duplicates_in_changelog": true
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

A separate scheduled task stored at `~/.claude/scheduled-tasks/graph-dream-weekly/SKILL.md`. Configured via the Claude Desktop Schedule UI on a weekly cadence.

This session:
- Calls `graph_stats` for overall health
- Calls `graph_contradictions` to find all conflicts
- Queries for stale entities, orphans, and weak clusters
- Writes a weekly summary to `~/.claude/graph-memory/logs/weekly/`
- Suggests consolidation or cleanup actions

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
- **Cost controls.** No API call when nothing is pending. Prompt caching on the tools and system prompt. Old tool results are cleared server-side once the conversation gets long (context editing), since the manifest and changelog are on disk. A per-run estimate, `DREAM_MAX_COST_USD` (default $3): at 80% of it the model is told to finish the item in hand, write the changelog and stop, with 20 more turns allowed, and the run is cut off at 1.5x. `DREAM_MAX_TURNS` (default 200) is the hard stop.
- **Binary ingest files** (PDF, Office, images) need MarkItDown, which the runner doesn't have. They stay in `pending/` and don't count as pending work, so they don't trigger paid runs on their own.
- **Logs.** Each run writes `~/graph-memory/logs/dream-runner/<timestamp>.log` (one line per turn with the tools called and the running cost estimate) and appends a summary line to `logs/dream-runner/runs.jsonl`. The dream's own changelog and audit log are written as usual.

### API key

The runner reads the key at run time from `ANTHROPIC_API_KEY`, or from the file named by `ANTHROPIC_API_KEY_FILE`. The file can hold the bare key or an `ANTHROPIC_API_KEY=...` line; a folder holding exactly one file also works. The key is never logged, never passed to the MCP server process, and should never be put in `.env` or committed. In compose, set `ANTHROPIC_API_KEY_HOST_FILE` in `.env` to the key file's path on the host; it's mounted read-only at `/run/secrets/anthropic_api_key`.

### Settings

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY_HOST_FILE` | none | Host path of the key file (compose only) |
| `DREAM_SCHEDULE` | `22:47` (compose), `02:30` (runner) | Daily run time for `--daemon`, 24-hour local time |
| `DREAM_TZ` | `UTC` | IANA time zone the schedule is read in (compose sets `TZ` from it) |
| `DREAM_MODEL` | `claude-opus-5-5` | `claude-sonnet-5-5` costs about half as much per token |
| `DREAM_EFFORT` | `medium` | `low`, `medium`, `high`, `xhigh` or `max` |
| `DREAM_MAX_COST_USD` | `3` | Per-run cost estimate at which the model is told to wrap up |
| `DREAM_MAX_TURNS` | `200` | Hard limit on API requests per run |
| `DREAM_FALLBACKS` | on for Opus/Sonnet 5.x and Fable 5.1 | `off` disables server-side refusal fallbacks |
| `DREAM_EXCLUDE_TOOLS` | see above | Comma-separated graph tools to hide; empty keeps all |
| `DREAM_SKIP_ACTIVE_MINUTES` | `30` | Leave sessions modified this recently for the next run; `0` turns it off |
| `DREAM_WEEKLY_SCHEDULE` | `off` | Weekly maintenance in the daemon, e.g. `Sun 06:00` |
| `DREAM_WEEKLY_MAX_COST_USD` | `1.5` | Weekly job's budget |
| `DREAM_WEEKLY_EXCLUDE_TOOLS` | see Weekly maintenance | Graph tools hidden from the weekly job |
| `DREAM_ALERT_TO` | none | Where reports and alerts go; email is off without it |
| `DREAM_SMTP_USER` | none | SMTP login and From address |
| `DREAM_SMTP_PASSWORD_HOST_FILE` | none | Host path of the app-password file (compose mounts it) |

### Running it

Pick one of these, and turn off the Claude Desktop scheduled task (`graph-dream-nightly`) once you have, so the two don't both run. If they overlap, the lock makes the second one exit, but each still uses its own budget.

1. **Always-on container.** Add `COMPOSE_PROFILES=dream` and `ANTHROPIC_API_KEY_HOST_FILE=...` to `.env`, then `docker compose up -d`. The `graph-dream` service waits for `DREAM_SCHEDULE` each day. `docker logs graph-memory-dream` shows when the next run is.
2. **Windows Task Scheduler.** Leave the profile off and run `.\scripts\register-dream-task.ps1 -At 22:47` from the graph-memory folder. The task runs `docker compose run --rm graph-dream node dist/dream-runner/index.js` daily and catches up after sleep.

To try one run by hand: `docker compose run --rm graph-dream node dist/dream-runner/index.js` (add `--force` to run even when the quick check finds nothing).

### Weekly maintenance

The same runner can run `prompts/weekly-maintenance.md` with `--job weekly`, or on a schedule in the daemon with `DREAM_WEEKLY_SCHEDULE` (e.g. `Sun 06:00`; off by default). It differs from the nightly job in these ways:

- It always runs; there's no pending check.
- It gets `graph_export`, `graph_cypher` and `graph_prune`, which the prompt's backup, analysis and prune steps need. `graph_merge` stays hidden, since merging is the reviewer's call (rule 6). Override with `DREAM_WEEKLY_EXCLUDE_TOOLS`.
- Its own budget, `DREAM_WEEKLY_MAX_COST_USD` (default $1.50). Past the wrap-up point the model is told not to run the prune execute step.
- **Email comes from the runner, not the model.** Step 12 needs a shell, Python and `gws`, so the model skips it; once the run finishes, the runner emails the report it wrote (see Email below). The model never gets a mail tool.
- The lock source is `api-runner-weekly`. In the daemon, when both jobs fall due together, the weekly runs first and the nightly right after.

### Email

With `DREAM_ALERT_TO`, `DREAM_SMTP_USER` and an SMTP password file set, the runner sends mail after a run (`notify.ts`):

- **Weekly, completed:** the report from `logs/weekly-reports/`, subject `Weekly Graph Maintenance — <date> (<N> action items)`.
- **Any run that doesn't finish cleanly** (error, budget stop, turn limit, refusal, lock held): a short alert with the outcome, cost and the last 40 log lines.
- **Nothing** for a normal nightly or a quiet night.

It uses plain SMTP (Gmail with an app password by default; `DREAM_SMTP_HOST` / `DREAM_SMTP_PORT` to change), read from a file like the API key, so it doesn't depend on any OAuth sign-in staying fresh. A failed send is logged and never fails the run. The report is plain text (it's Markdown, which reads fine as is).

### What stays on the subscription

The cloud-session collector (`prompts/collect-cloud-sessions.md`) still runs inside a Claude Code Projects thread, because the tools that list cloud sessions only exist there. It only queues text into `ingest/pending/`; the extraction itself happens in the nightly dream, which is the part this runner moves to the API key.
