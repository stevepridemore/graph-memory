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
