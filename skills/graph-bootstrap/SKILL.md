---
name: graph-bootstrap
description: Run the one-time bootstrap to populate the memory graph from existing memory files and conversation transcripts. Use when first setting up graph-memory or to catch up on historical data.
argument-hint: [--memory-only] [--transcripts-only] [--dry-run]
---

The user wants to run the graph memory bootstrap process. This is a one-time bulk import
of existing knowledge into the graph. You ARE the bootstrap process -- run it inline.

Arguments: $ARGUMENTS

Parse the arguments:
- `--memory-only` optional: only process memory .md files, skip transcripts
- `--transcripts-only` optional: only process conversation transcripts, skip memory files
- `--dry-run` optional: describe what you would extract without calling graph write tools

Steps:
1. Check for lock file at ~/graph-memory/processed/dream.lock
   - If it exists and was created less than 2 hours ago, report "Dream/bootstrap process already running" and exit
   - Otherwise, create the lock file with: {"pid": 0, "timestamp": "<now>", "source": "manual-bootstrap"}
2. Read ~/graph-memory/config.json for parameters (defaults: chunk_size_lines=500, max_transcripts_per_run=10)

3. Process memory files (unless --transcripts-only):
   a. Find all .md files in ~/.claude/projects/*/memory/ (skip MEMORY.md index files)
   b. Read each file, parse YAML frontmatter (name, description, type)
   c. Extract entities and relationships based on content
   d. Check existing entities via graph_entities before creating (boost if exists)
   e. Call graph_relate in batch mode with source_type: "memory-file"
   f. Use specific relationship types (WORKS_ON, USES_TECH, KNOWS_ABOUT, PREFERS, etc.)

4. Process conversation transcripts (unless --memory-only):
   a. Read manifest.json, find unprocessed JSONL files in ~/.claude/projects/
   b. For each transcript (oldest first, up to max_transcripts_per_run):
      - Validate format (check first 5 lines for expected fields)
      - Read content (chunk large files at 500 lines)
      - Extract entities from user and assistant text blocks only
      - Call graph_relate in batch mode with source_type: "conversation"
      - **Update manifest.json immediately** after each transcript
   c. If max_transcripts_per_run reached, note remaining count

5. Call graph_decay to apply time-based maintenance

6. Write changelog to ~/graph-memory/logs/bootstrap-YYYY-MM-DD.md

7. Delete the lock file at ~/graph-memory/processed/dream.lock

8. Report summary: memory files processed, transcripts processed, entities created/updated, edges created

If --dry-run, describe what you would extract but do NOT call any graph write tools. Skip the lock.

IMPORTANT: Never merge entities unless highly confident. Flag suspected duplicates in the changelog.
IMPORTANT: Always delete the lock file when done, even if you encountered errors.
IMPORTANT: NEVER extract API keys, passwords, tokens, secrets, or credentials into graph entities.
IMPORTANT: Use specific relationship types -- not just RELATED_TO for everything.
IMPORTANT: Memory files are higher signal than transcripts -- process them first.
