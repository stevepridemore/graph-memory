# Graph Memory — Bootstrap (Cold Start)

You are running the graph memory bootstrap process. This is a one-time bulk import of existing knowledge from memory files and conversation transcripts into the graph. It is similar to the nightly dream process but designed for first-time population.

## Step 1: Acquire Lock

Check for the lock file at `~/graph-memory/processed/dream.lock`. If it exists and was created less than 2 hours ago, **abort immediately** — another dream/bootstrap process is running.

If no lock (or stale lock >2 hours), create the lock file:
```json
{
  "pid": 0,
  "timestamp": "<current ISO timestamp>",
  "source": "bootstrap"
}
```

**You MUST release this lock when you finish, whether you succeed or fail.**

## Step 2: Load Configuration

Read `~/graph-memory/config.json` for runtime parameters. Use these defaults if missing:

- `chunk_size_lines`: 500
- `max_transcripts_per_run`: 10

## Step 3: Process Memory Files (High Priority)

Memory files are the highest-signal source — they contain curated knowledge the user already deemed worth saving.

Discover all memory files:
```
~/.claude/projects/*/memory/*.md
```

Skip `MEMORY.md` index files — only process the actual memory entries.

For each memory file:

### 3a. Read and Parse Frontmatter

Memory files have YAML frontmatter with `name`, `description`, and `type` (user, feedback, project, reference). Use the type to determine entity mapping:

| Memory Type | Primary Entity Type | Typical Relationships |
|-------------|--------------------|-----------------------|
| user | Person, Preference | PREFERS, KNOWS_ABOUT, USES |
| feedback | Preference, Decision | PREFERS, DECIDED_FOR |
| project | Project, Fact, Event | WORKS_ON, USES_TECH, PARTICIPATED_IN |
| reference | Object, Concept | RELATED_TO, HOSTED_ON |

### 3b. Extract Entities and Relationships

Read the full content. Extract:
- Named entities (people, projects, technologies, tools)
- Stated preferences and decisions
- Facts about infrastructure, processes, configuration
- Relationships between entities

### 3c. Derive Project Context

Claude Code stores transcripts and memory under per-project subdirectories of `~/.claude/projects/`, where the subdirectory name is the project's absolute path with separators replaced by `-` (Windows colons become `-`, slashes/backslashes become `-`). For example, a clone at `~/Documents/Projects/graph-memory` (Linux/macOS) becomes:

```
~/.claude/projects/-home-<you>-Documents-Projects-graph-memory/memory/...
```

On Windows (`C:\Users\<you>\Documents\Projects\graph-memory`):

```
~/.claude/projects/C--Users-<you>-Documents-Projects-graph-memory/memory/...
                   └────────────────────┬───────────────────────┘
                            decoded back to the project's source directory
```

Reverse the encoding to derive the project root, then use that path as project context for affinity scoring (+0.10 boost for in-project entities).

### 3d. Write to Graph

Use `graph_relate` in **batch mode** when possible. Always include provenance:
- `source_type`: `"memory-file"`
- `source_transcript`: the full file path

**Weight guidelines for memory files:**
| Origin | Weight |
|--------|--------|
| Explicit preference or decision in the file | 0.7 |
| Named entity mentioned with clear context | 0.5 |
| Inferred relationship | 0.3 |

### 3e. Entity Resolution

Before creating any entity, call `graph_entities` to check if it already exists. The graph may already have entities from recent chat sessions. **Boost existing entities** (+0.15) rather than creating duplicates.

## Step 4: Process Conversation Transcripts

Read the manifest at `~/graph-memory/processed/manifest.json`. Use the same three-way classification as the nightly dream (see `dream-nightly.md` Step 3):

1. **New** — `session_id` not in manifest → process the entire file
2. **Resumed (delta)** — `session_id` in manifest, but `current line_count > manifest.line_count` (or file_size_bytes/mtime indicates growth) → process only messages with `timestamp > manifest.processed_at`
3. **Already processed, no changes** — manifest entry matches current state → skip

Discover JSONL files:
```
~/.claude/projects/*/*.jsonl
```

Skip files starting with `agent-`. Process oldest first, up to `max_transcripts_per_run`.

For each transcript, follow the same extraction rules as the nightly dream process:

### 4a. Validate Format

Read the first 5 lines. Verify fields: `type`, `message`, `timestamp`, `sessionId`, `cwd`. Skip if format is unexpected.

### 4b. Read Content

- Under 500 lines: read whole file
- 500-5000 lines: process in 500-line chunks
- 5000+ lines: sample ~100 lines first to identify topics, then chunk

### 4c. Extract Knowledge

Focus on knowledge, not conversation mechanics. Extract from user and assistant text content only (skip tool_use, tool_result, thinking blocks):

- People, projects, technologies, preferences, decisions, facts, events, objects
- Use specific relationship types (WORKS_ON, USES_TECH, KNOWS_ABOUT, etc.) — not just RELATED_TO

### 4d. Write to Graph

Use `graph_relate` in batch mode. Include provenance:
- `source_session`: the sessionId from the JSONL
- `source_transcript`: the full file path
- `source_type`: `"conversation"`
- `valid_at`: timestamp from the JSONL line

**Weight guidelines:**
| Origin | Weight |
|--------|--------|
| Explicit user statement | 0.7 |
| Inferred from context | 0.3 |
| In-project entity (cwd matches) | +0.10 boost |
| Repeated/confirmed fact | boost +0.15 |

### 4e. Update Manifest Immediately

After finishing each transcript, **immediately** update `manifest.json`. Do not batch.

## Step 5: Decay Maintenance

Call `graph_decay` with `dry_run: false`.

## Step 6: Write Changelog

Write to `~/graph-memory/logs/bootstrap-YYYY-MM-DD.md`:

```markdown
# Bootstrap — YYYY-MM-DD

## Summary
- Memory files processed: N of N total
- Transcripts processed: N of N total
- Entities: N created, N updated (existing boosted)
- Edges: N created, N strengthened
- Contradictions: N new

## Memory File Entities
- List of entities extracted from memory files

## Transcript Entities
- List of entities extracted from transcripts

## Flagged for Review
- Potential duplicates (not merged)

## Notes
- If max_transcripts_per_run was reached: "N transcripts remaining — run /graph-bootstrap again"
```

## Step 7: Release Lock

Delete `~/graph-memory/processed/dream.lock`. **Mandatory** even on failure.

## Critical Rules

1. **Memory files first, transcripts second.** Memory files are curated and high-signal.
2. **Never merge entities unless highly confident.** Duplicates are safer than false merges.
3. **Boost existing entities** from chat sessions rather than creating duplicates.
4. **Stop after max_transcripts_per_run transcripts.** Run again for more.
5. **Update manifest after each transcript.** Prevents reprocessing on crash.
6. **NEVER extract secrets or credentials.** Note existence only, never the value.
7. **Always release the lock file** when done, even on failure.
8. **Use specific relationship types** — WORKS_ON, USES_TECH, KNOWS_ABOUT, PREFERS, DECIDED_FOR, PARTICIPATED_IN. Only use RELATED_TO when nothing else fits.
9. **Focus on knowledge, not mechanics.** Extract what was discussed, decided, or learned.
