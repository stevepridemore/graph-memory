---
name: graph-stats
description: Show memory graph health dashboard — node counts, edge counts, contradictions, stale entities, pending ingests, and last dream run. Use when the user asks about graph status, health, or size.
---

The user wants to see the memory graph status.

Steps:
1. Call the `graph_stats` MCP tool (no arguments needed)
2. Call the `graph_ingest` MCP tool with action: "status" to get ingest queue info
3. Present a clean dashboard:

   ## Memory Graph Dashboard

   **Nodes** — total and breakdown by type (Person, Project, Preference, Concept, Decision, Fact, Event, Object)
   **Edges** — total and breakdown by type

   **Health**
   - Average edge weight
   - Orphaned nodes (no connections)
   - Unresolved contradictions
   - Stale nodes (confidence < 0.2)

   **Ingest Queue**
   - Pending documents
   - Recently completed

   **Last dream run** — timestamp and what changed

If there are unresolved contradictions, highlight them and offer to show details.
If there are stale nodes, mention they may need review or will be pruned.
