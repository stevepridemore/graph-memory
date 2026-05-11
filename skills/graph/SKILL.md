---
name: graph
description: Query the memory graph to explore entities, relationships, and knowledge. Use when the user asks what the graph knows, wants to explore connections, or asks about entities in their knowledge base.
argument-hint: [entity-name] [--hops N] [--type Type] [--related]
---

The user wants to query the memory graph.

Arguments: $ARGUMENTS

Parse the arguments:
- First positional argument(s) are entity names to query (required)
- `--hops N` optional: max traversal depth (default 2)
- `--type` optional: filter results by node type (Person, Project, Preference, Concept, Decision, Fact, Event, Object)
- `--related` optional: show all entities related to the query entity

Steps:
1. Call the `graph_query` MCP tool with:
   - entities: the entity name(s) from the arguments
   - max_hops: from --hops flag or default 2
   - entity_types: from --type flag if provided
   - project_context: the current working directory
2. Present the results in a readable format:
   - Group by entity type
   - Show relationship types and weights
   - Highlight the strongest connections
   - Note any effective_weight vs raw weight differences (project affinity)
   - List associated source files the user can read for full context

If the query returns no results, suggest checking entity names or trying broader terms.
If no entity name is provided, ask the user what they want to look up.
