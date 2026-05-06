# Graph Memory — Weekly Deep Dream Analysis

You are running the weekly graph memory health analysis. Your job is to audit the memory graph, find issues, and write a report with actionable recommendations.

## Step 1: Graph Health Overview

Call `graph_stats` to get the current state:
- Total nodes and edges by type
- Average edge weight
- Orphaned nodes, unresolved contradictions, stale entries
- Pending ingest documents

## Step 2: Unresolved Contradictions

Call `graph_contradictions` to find all unresolved conflicts. For each one:
- Assess whether it's a **genuine contradiction** (both can't be true) or a **supersession** (one replaced the other over time)
- For supersessions: recommend setting `invalid_at` on the old edge via `graph_relate`
- For genuine contradictions: recommend which is more likely correct based on recency, weight, and source

## Step 3: Stale Entities

Find entities that may need pruning. Run via `graph_cypher`:

```cypher
MATCH (n:Entity)
WHERE n.confidence < 0.2 AND n.last_seen < datetime() - duration('P90D')
RETURN labels(n) AS types, n.id, n.name, n.confidence, n.last_seen
ORDER BY n.confidence ASC
LIMIT 30
```

For each stale entity, note whether it has any remaining relationships that might still be valuable.

## Step 4: Orphaned Nodes

Find entities with no relationships:

```cypher
MATCH (n:Entity)
WHERE NOT (n)-[]-()
RETURN n.id, n.name, labels(n) AS types, n.confidence, n.last_seen
ORDER BY n.last_seen ASC
```

Recommend whether each orphan should be pruned or connected to something.

## Step 5: Weak Clusters

Find entities with only very low-weight connections:

```cypher
MATCH (n:Entity)-[r]-()
WITH n, max(r.weight) AS maxWeight, count(r) AS edgeCount
WHERE maxWeight < 0.3
RETURN n.id, n.name, labels(n) AS types, maxWeight, edgeCount
ORDER BY maxWeight ASC
LIMIT 20
```

These entities exist in the graph but are barely connected — they may represent knowledge that's fading or was never well-established.

## Step 6: Potential Duplicates

Search for entities with similar names that might be the same thing. Check common patterns:
- Same name, different type (e.g., "react" as both Concept and Object)
- Abbreviations vs full names
- Singular vs plural
- With/without hyphens or spaces

Use `graph_entities` searches for common project and person names, and flag any that look like duplicates.

## Step 7: Dream Process Health

Check the manifest at `~/graph-memory/processed/manifest.json`:
- When was the last dream run?
- How many transcripts have been processed total?
- Are there unprocessed transcripts piling up?
- Review the most recent changelog in `~/graph-memory/logs/` for any flagged issues

## Step 8: Write Weekly Report

Write the report to `~/graph-memory/logs/weekly/YYYY-MM-DD.md`:

```markdown
# Weekly Graph Analysis — YYYY-MM-DD

## Action Required
- [ ] Actionable items listed here (contradictions to resolve, duplicates to merge, etc.)

## Graph Health
- Nodes: N total (breakdown by type)
- Edges: N total (breakdown by type)
- Average weight: X.XX
- Orphaned nodes: N
- Stale entities: N
- Unresolved contradictions: N

## Contradictions
Description and recommendation for each.

## Stale Entities
List with recommendation (prune or keep).

## Orphaned Nodes
List with recommendation.

## Weak Clusters
Entities that are barely connected.

## Potential Duplicates
Suspected duplicates with evidence.

## Dream Process Status
- Last run: timestamp
- Transcripts processed: N total
- Backlog: N unprocessed
- Recent issues from changelogs

## Comparison with Last Week
If a previous weekly report exists, note changes:
- Nodes added/removed
- Weight trends
- Resolved vs new contradictions

## Recommendations
Specific actions to improve graph quality.
```

## Rules

1. **Do not modify the graph.** This is a read-only analysis. All changes should be recommended, not executed.
2. **Be specific in recommendations.** Don't just say "review stale entities" — name which ones and why.
3. **Prioritize actionable items.** Put the most important issues at the top under "Action Required".
