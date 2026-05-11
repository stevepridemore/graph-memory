---
name: graph-find
description: Find specific patterns in the memory graph — contradictions, stale entities, orphans, or strongest connections. Use when the user wants to audit or review their knowledge graph.
argument-hint: [contradictions|stale|orphans|strongest]
---

The user wants to find specific patterns in the memory graph.

Arguments: $ARGUMENTS

Based on the argument:

**contradictions** — Call `graph_contradictions` MCP tool. Show each pair of conflicting facts with their evidence and detection date. Offer to resolve them.

**stale** — Call `graph_entities` MCP tool with min_confidence: 0.0, sort_by: "confidence", limit: 20. Show the weakest entities that may need reinforcement or pruning.

**orphans** — Call `graph_entities` MCP tool with sort_by: "last_seen", limit: 50. Filter the response for entities where edge_count is 0. Show these disconnected entities.

**strongest** — Call `graph_entities` MCP tool with sort_by: "confidence", limit: 20. Show the highest-confidence entities — the core of the knowledge graph.

If no argument is provided, show a brief menu of what's available and ask what they'd like to find.
