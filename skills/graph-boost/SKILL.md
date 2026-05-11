---
name: graph-boost
description: Reinforce or weaken a specific relationship in the memory graph. Use when the user wants to manually adjust edge weights.
argument-hint: [weaken] [entity-from] [entity-to] [relation-type] [--reason "why"]
---

The user wants to manually adjust an edge weight in the memory graph.

Arguments: $ARGUMENTS

Parse the arguments:
- If first argument is "weaken", this is a weaken operation. Otherwise it's a boost.
- Next two positional arguments are the from and to entity names
- Next positional argument is the relationship type (WORKS_ON, PREFERS, KNOWS_ABOUT, etc.)
- `--reason` optional: why the adjustment is being made

Steps:
1. For boost: call `graph_boost` MCP tool with from_name, to_name, relation, and reason
2. For weaken: call `graph_weaken` MCP tool with from_name, to_name, relation, and reason
3. Report the previous and new weight
4. If the edge wasn't found, suggest using `/graph` to find the correct entity names

If insufficient arguments, ask the user to specify the entities and relationship type.
