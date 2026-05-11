---
name: graph-dream
description: Manually run the graph memory dream process to extract entities from recent conversations and ingested documents. Use when the user wants to update the graph now rather than waiting for the scheduled run.
argument-hint: [--dry-run] [--ingest-only]
---

The user wants to manually trigger the graph memory dream process. This runs inline
in the current session — you ARE the dream process. No separate script needed.

Arguments: $ARGUMENTS

Parse the arguments:
- `--dry-run` optional: describe what you would do without actually calling graph tools
- `--ingest-only` optional: only process the ingest drop folder, skip conversation transcripts

For the full dream process instructions, read the file:
~/graph-memory/prompts/dream-nightly.md
(seeded into the data dir by the docker container's entrypoint on first start)

Follow those instructions exactly. The key steps are:
1. Read manifest at ~/graph-memory/processed/manifest.json
2. Find unprocessed transcripts in ~/.claude/projects/
3. Check ~/graph-memory/ingest/pending/ for documents
4. If nothing pending, report "No pending work" and exit
5. For each unprocessed transcript: extract entities, call graph_relate/graph_boost/graph_weaken
6. For each ingest document: same extraction process
7. Call graph_decay for maintenance
8. Write changelog to ~/graph-memory/logs/YYYY-MM-DD.md
9. Update manifest.json
10. Move ingest files from pending/ to completed/

If --dry-run, describe what you would extract but do NOT call any graph write tools.
If --ingest-only, skip transcript processing entirely.

IMPORTANT: Never merge entities unless highly confident. Flag suspected duplicates instead.
