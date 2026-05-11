---
name: graph-briefing
description: Generate a session briefing from the memory graph — recent changes, unresolved contradictions, relevant context for the current project. Use at the start of a session to catch up, or when switching projects.
argument-hint: [--full]
---

Generate a structured session briefing from the memory graph.

Arguments: $ARGUMENTS

Steps:
1. Call `graph_stats` to get overall health and last dream run timestamp
2. Call `graph_query` with project_context set to the current working directory, context_level: "minimal"
   to get entities relevant to the current project
3. Call `graph_contradictions` to find any unresolved conflicts
4. If --full flag: also call `graph_ingest` with action: "status" to check pending ingests,
   and call `graph_query` with current_only: false to show recently superseded facts

Present the briefing in this format:

## Session Briefing

**Project:** [current project name from directory]
**Last dream run:** [timestamp] ([how long ago])
**Graph:** [node count] entities, [edge count] relationships

### What's Changed Recently
- [List entities/edges updated since last session, if any]
- [Recently superseded facts — what changed and when]

### Unresolved Contradictions
- [Any CONTRADICTS edges with resolved=false]
- [Or "None — graph is consistent"]

### Relevant to Current Project
- [Top entities connected to active project, by effective weight]
- [Recent events related to this project]
- [Key decisions still active for this project]

### Pending
- [Unprocessed transcripts count]
- [Pending ingest documents]
- [Or "All caught up"]

If the graph is empty or Neo4j is not running, say so and suggest running /graph-dream or the bootstrap.
