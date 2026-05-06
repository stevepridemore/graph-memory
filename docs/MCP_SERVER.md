# Graph Memory System — MCP Server Design

## Overview

The `graph-memory-mcp` server is a thin wrapper around Neo4j. It executes Cypher queries and returns results. **No LLM calls — all intelligence stays in Claude Code sessions (Max plan).** 20 tools total.

This means:
- No API key needed
- No `@anthropic-ai/sdk` dependency
- Fast and predictable — every tool call is just a database operation
- Claude in the session handles entity extraction, Cypher generation, and reasoning

### Design Patterns

- **Tool annotations:** Each tool is annotated with `readOnlyHint`, `destructiveHint`, and `idempotentHint` so Claude can reason about which tools are safe to call speculatively.
- **Multi-label nodes:** All entity nodes carry `:Entity` plus their type label. Tools that search across types use the `:Entity` label; tools that filter use specific labels.
- **Confidence-max MERGE pattern:** Write tools use `MERGE` with a hybrid update strategy — take max for explicit evidence, additive boost for mentions.

## Registration

Local stdio transport (Claude Code / Claude Desktop on the same machine):

```jsonc
// ~/.claude/settings.json
{
  "mcpServers": {
    "graph-memory": {
      "command": "docker",
      "args": ["exec", "-i", "graph-memory-mcp", "node", "dist/mcp-server/index.js"]
    }
  }
}
```

Remote clients (claude.ai web, multi-device) connect via HTTPS to `https://your-host.example/mcp` using OAuth 2.1 bearer tokens. See [REMOTE.md](REMOTE.md).

## Connection Management

```typescript
import neo4j, { Driver } from 'neo4j-driver';

// Single driver instance, connection pooled
const driver: Driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD)
);

// Read queries use executeRead (auto-retry on transient failures)
// Write queries use executeWrite
```

The driver handles connection pooling, retries, and session management automatically. No lock files needed — Neo4j manages concurrent access internally.

---

## Tool Definitions

### graph_query

**Purpose:** Traverse from entities, return relevant subgraph with weights. Applies project-context affinity when provided.

**Input:**
```json
{
  "entities": ["string"],
  "entity_types": ["string"],
  "max_hops": 2,
  "min_weight": 0.3,
  "limit": 20,
  "project_context": "string",
  "context_level": "minimal" | "full" | "relations-only",
  "current_only": true
}
```

**`context_level`** controls response size (default: `full`):
- `minimal` — just id, name, type, confidence per node. No properties, no source files. Fast for scanning/listing.
- `full` — all properties, source files, edge details with provenance. For deep dives.
- `relations-only` — id, name, type per node + all edge details. For graph structure analysis.

**`current_only`** (default: `true`) — when true, only returns edges where `invalid_at IS NULL` (current facts). Set to `false` to include superseded edges for historical queries.

**Output (context_level: "full"):**
```json
{
  "nodes": [
    {
      "id": "project-x",
      "type": "Project",
      "name": "Project X",
      "properties": { "status": "active", "stack": "React, Node.js" },
      "confidence": 0.85,
      "source_file": "~/.claude/.../project_x.md"
    }
  ],
  "edges": [
    {
      "from": "alice",
      "to": "project-x",
      "type": "WORKS_ON",
      "weight": 0.9,
      "effective_weight": 0.9,
      "properties": { "role": "lead" },
      "valid_at": "2026-03-01T...",
      "invalid_at": null,
      "source_session": "abc-123",
      "source_type": "conversation"
    }
  ],
  "source_files": ["~/.claude/projects/<encoded-project>/memory/project_x.md"]
}
```

> **Note:** All paths in MCP server responses use fully resolved Windows paths (via `os.homedir()`). The `~/` shorthand is used only in documentation for readability.

**Output (context_level: "minimal"):**
```json
{
  "nodes": [
    { "id": "project-x", "type": "Project", "name": "Project X", "confidence": 0.85 }
  ],
  "edge_count": 12
}
```

**Behavior:**
1. For each entity name, query using full-text search index (fuzzy)
2. Execute Cypher traversal with hop and weight constraints
3. If `project_context` provided:
   a. Resolve to a Project node (match by directory path or name)
   b. Calculate hop distance from each result to active project
   c. Apply affinity multiplier (1.3 at 1 hop, 1.15 at 2 hops)
   d. Sort by effective weight
4. Deduplicate and return results with source file paths

---

### graph_relate

**Purpose:** Create or strengthen relationships between entities. Supports single or batch operations. Creates entities if they don't exist.

**Annotation:** `idempotentHint: true`

**Input (single):**
```json
{
  "from_name": "string",
  "from_type": "string",
  "to_name": "string",
  "to_type": "string",
  "relation": "string",
  "weight": 0.5,
  "properties": {},
  "evidence": "string",
  "valid_at": "datetime",
  "source_session": "string",
  "source_transcript": "string",
  "source_type": "conversation"
}
```

**Input (batch — for dream process):**
```json
{
  "batch": {
    "entities": [
      { "localId": "proj-gm", "name": "graph-memory", "type": "Project", "properties": { "status": "active" } },
      { "localId": "neo4j", "name": "neo4j", "type": "Concept", "properties": { "category": "technology" } },
      { "localId": "alice", "name": "alice", "type": "Person" }
    ],
    "relations": [
      { "from": "alice", "to": "proj-gm", "relation": "WORKS_ON", "weight": 0.7, "properties": { "role": "lead" } },
      { "from": "proj-gm", "to": "neo4j", "relation": "USES_TECH", "weight": 0.6 }
    ],
    "source_session": "abc-123",
    "source_transcript": "~/.claude/projects/.../abc-123.jsonl",
    "source_type": "conversation"
  }
}
```

The `localId` field allows referencing entities within the same batch call before they have real IDs. The `from` and `to` fields in relations match against `localId` first, then fall back to existing entity name lookup. This enables creating a connected subgraph atomically in a single call — critical for dream process efficiency.

**Output (single):**
```json
{
  "action": "created" | "strengthened",
  "edge": { "from": "...", "to": "...", "type": "...", "weight": 0.65 },
  "created_entities": ["entity-name"]
}
```

**Output (batch):**
```json
{
  "entities_created": 3,
  "entities_merged": 1,
  "edges_created": 2,
  "edges_strengthened": 0,
  "details": [
    { "entity": "graph-memory", "action": "created" },
    { "entity": "neo4j", "action": "merged" },
    { "edge": "alice→WORKS_ON→graph-memory", "action": "created", "weight": 0.7 }
  ]
}
```

**Behavior:**
- **Single mode:** Uses `MERGE` to find-or-create both nodes and the relationship in a single transaction. If the relationship exists, applies confidence-max update (take max of current and new weight for explicit evidence, additive boost for mentions). Sets `valid_at` if provided. Atomic.
- **Batch mode:** Resolves all `localId` references, creates all entities, then creates all relationships in a single Neo4j transaction. If any step fails, the entire batch rolls back. Provenance fields (`source_session`, `source_transcript`, `source_type`) are applied to all edges in the batch.
- **Supersession handling:** If a new edge contradicts an existing one (same endpoints, same type, different target), the old edge's `invalid_at` is set to the new edge's `valid_at` rather than creating a CONTRADICTS relationship. This is the default for factual updates. True contradictions (ambiguous, unresolved) still use the CONTRADICTS edge type.

---

### graph_boost

**Purpose:** Increase edge weight when user confirms recalled information.

**Input:**
```json
{
  "from_name": "string",
  "to_name": "string",
  "relation": "string",
  "amount": 0.15,
  "reason": "string"
}
```

**Output:**
```json
{
  "previous_weight": 0.6,
  "new_weight": 0.75,
  "edge": { "from": "...", "to": "...", "type": "..." }
}
```

---

### graph_weaken

**Purpose:** Decrease edge weight when user corrects a fact.

**Input:**
```json
{
  "from_name": "string",
  "to_name": "string",
  "relation": "string",
  "amount": 0.2,
  "reason": "string"
}
```

**Output:**
```json
{
  "previous_weight": 0.7,
  "new_weight": 0.5,
  "edge": { "from": "...", "to": "...", "type": "..." },
  "pruned": false
}
```

---

### graph_entities

**Purpose:** Browse/search the entity catalog.

**Input:**
```json
{
  "search": "string",
  "type": "string",
  "min_confidence": 0.0,
  "sort_by": "confidence" | "last_seen" | "name",
  "limit": 20
}
```

**Output:**
```json
{
  "entities": [
    {
      "id": "project-x",
      "type": "Project",
      "name": "Project X",
      "confidence": 0.85,
      "edge_count": 12,
      "last_seen": "2026-04-06T...",
      "source_file": "..."
    }
  ],
  "total": 47
}
```

---

### graph_contradictions

**Purpose:** Find unresolved contradictions across all node types.

**Input:**
```json
{
  "include_resolved": false
}
```

**Output:**
```json
{
  "contradictions": [
    {
      "node_a": { "id": "...", "type": "Fact", "content": "Project X uses Vue" },
      "node_b": { "id": "...", "type": "Fact", "content": "Project X uses React" },
      "description": "Conflicting tech stack for Project X",
      "detected_date": "2026-04-05T...",
      "resolved": false
    }
  ],
  "count": 1
}
```

---

### graph_ingest

**Purpose:** Queue or immediately process a document for ingestion. Status check for ingest queue.

**Input:**
```json
{
  "action": "queue" | "status",
  "file_path": "string",
  "meta": {
    "source": "string",
    "author": "string",
    "date": "string",
    "topic_hints": ["string"],
    "weight_override": 0.6
  }
}
```

**Note:** `action: "process"` (immediate ingestion) is handled by the `/ingest --now` skill, which runs entity extraction in the Claude Code session and calls `graph_relate` directly. The MCP tool only handles queueing (filesystem copy) and status (filesystem read). No LLM needed.

**Output (queue):**
```json
{
  "action": "queued",
  "file": "karpathy-llm-wiki.srt",
  "destination": "~/graph-memory/ingest/pending/karpathy-llm-wiki.srt",
  "meta_written": true
}
```

**Output (status):**
```json
{
  "pending": [
    { "file": "meeting-notes.md", "queued_at": "2026-04-06T14:30:00Z", "size": "2.1 KB" }
  ],
  "recently_completed": [
    { "file": "karpathy-llm-wiki.srt", "processed_at": "2026-04-06T23:00:00Z", "entities": 12, "edges": 18 }
  ],
  "pending_count": 1,
  "completed_count": 5
}
```

---

### graph_cypher

**Purpose:** Execute a pre-formed Cypher query against Neo4j. **Read-only.** Claude generates the Cypher in the session — this tool just runs it.

**Input:**
```json
{
  "cypher": "string",
  "params": {}
}
```

**Output:**
```json
{
  "cypher": "MATCH (p:Person)-[w:WORKS_ON]->(proj:Project) ...",
  "results": [
    { "p.name": "alice", "proj.name": "graph-memory", "w.weight": 0.85 }
  ],
  "result_count": 1,
  "execution_time_ms": 12
}
```

**Safety:**
- **Primary defense — `executeRead` transaction mode:** The query is executed via Neo4j's read-only transaction (`session.executeRead()`). Neo4j itself rejects ANY write operation at the database level, regardless of what the Cypher contains. This is the definitive guard — it cannot be bypassed by clever Cypher construction, Unicode tricks, or comment injection. No application-level clause whitelist is needed.
- **5-second query timeout** to prevent runaway traversals.
- Writes go through dedicated tools (`graph_relate`, `graph_boost`, `graph_prune`, etc.) with proper validation.

---

### graph_decay

**Purpose:** Apply time-based decay to all node confidence and edge weights. Called by the dream process during maintenance.

**Input:**
```json
{
  "dry_run": false
}
```

**Output:**
```json
{
  "nodes_decayed": 45,
  "edges_decayed": 120,
  "nodes_flagged_for_pruning": 3,
  "edges_below_threshold": 7,
  "details": [
    { "type": "Project", "name": "old-project", "old_confidence": 0.15, "new_confidence": 0.12 }
  ]
}
```

**Behavior:**
Runs a single Cypher query per node type that calculates decay based on `last_seen` / `last_confirmed` timestamps and the configured decay rates. Uses Neo4j transactions so it's all-or-nothing — no partial decay on failure (fixes reviewer's concern about crash mid-maintenance).

```cypher
// Example: decay all Project nodes
MATCH (n:Project)
WHERE n.last_seen < datetime() - duration('P1D')
WITH n, n.confidence * (0.995 ^ duration.between(n.last_seen, datetime()).days) AS new_conf
SET n.confidence = CASE WHEN new_conf < 0.01 THEN 0.01 ELSE new_conf END
RETURN count(n) AS decayed
```

---

### graph_prune

**Purpose:** Remove entities and edges that have decayed below threshold. Provides a preview before destructive action. Called after reviewing `graph_decay` results or `graph_find stale` output.

**Annotation:** `destructiveHint: true`

**Input:**
```json
{
  "mode": "preview" | "execute",
  "node_threshold": 0.1,
  "edge_threshold": 0.05,
  "include_orphans": true,
  "max_age_days": 90
}
```

- `mode: "preview"` (default) — returns what would be pruned without deleting anything.
- `mode: "execute"` — actually deletes. Requires explicit confirmation from the user (Claude should ask before calling with execute).
- `node_threshold` — prune nodes with confidence below this AND no edges with weight above `edge_threshold`. Defaults to config value (`decay.prune_node_threshold`).
- `edge_threshold` — prune edges with weight below this. Defaults to config value (`decay.prune_edge_threshold`).
- `include_orphans` — also prune nodes with zero edges, regardless of confidence, if `last_seen` is older than `max_age_days`.
- `max_age_days` — age threshold for orphan pruning (default: 30, from config `decay.prune_orphan_days`).

**Output (preview):**
```json
{
  "mode": "preview",
  "nodes_to_prune": [
    { "id": "old-project", "type": "Project", "name": "Old Project", "confidence": 0.08, "last_seen": "2025-11-15T...", "edge_count": 0 }
  ],
  "edges_to_prune": [
    { "from": "alice", "to": "old-project", "type": "WORKS_ON", "weight": 0.03 }
  ],
  "node_count": 1,
  "edge_count": 1
}
```

**Output (execute):**
```json
{
  "mode": "executed",
  "nodes_pruned": 1,
  "edges_pruned": 1,
  "details": [
    { "action": "deleted_node", "id": "old-project", "type": "Project" },
    { "action": "deleted_edge", "from": "alice", "to": "old-project", "type": "WORKS_ON" }
  ]
}
```

**Behavior:**
1. Query for all nodes with `confidence < node_threshold` that have no edges with `weight > edge_threshold`
2. Query for all edges with `weight < edge_threshold`
3. If `include_orphans`: also find nodes with zero edges and `last_seen` older than `max_age_days`
4. In preview mode: return the lists without modifying anything
5. In execute mode: delete edges first, then nodes, in a single transaction
6. Alias nodes pointing to pruned entities are also removed

---

### graph_unmerge

**Purpose:** Split a falsely merged entity back into two separate nodes, redistributing edges. Reverses a bad merge using the merge audit log.

**Why this exists:** The reviewer identified that false entity merges are silent and catastrophic. "Anna" and "Anne" merged = every query about either returns contaminated results. This tool provides an undo path.

**Input:**
```json
{
  "entity_id": "string",           // the merged entity to split
  "new_entity_name": "string",     // name for the split-off entity
  "new_entity_type": "string",     // node label for the split-off entity
  "edges_to_move": [               // edges identified by composite key (no internal IDs)
    {
      "other_entity_id": "string", // the entity on the other end of the edge
      "relation_type": "string",   // e.g. "WORKS_ON", "KNOWS_ABOUT"
      "direction": "in" | "out"    // relative to the entity being split
    }
  ],
  "reason": "string"               // why splitting (logged in merge audit)
}
```

**Output:**
```json
{
  "original": { "id": "anna", "name": "Anna", "remaining_edges": 8 },
  "new_entity": { "id": "anne", "name": "Anne", "moved_edges": 3 },
  "audit_logged": true
}
```

**Behavior:**
1. Create the new entity node with specified properties
2. For each edge in `edges_to_move`:
   - Match the edge using (entity_id)--[relation_type]--(other_entity_id) with direction
   - Delete the edge from the original node
   - Create an equivalent edge on the new node (preserving weight, all properties)
3. Log the split in the merge audit log (`~/.claude/graph-memory/logs/merge-audit.jsonl`)
4. Return summary of what was moved

**Edge identification:** Edges are identified by composite key (`other_entity_id` + `relation_type` + `direction`) rather than internal Neo4j IDs, which are not stable across restarts. If multiple edges exist between the same pair with the same type (rare), all are moved.

**If `edges_to_move` is empty:** Claude can use `graph_query` on the merged entity first to inspect all edges, then decide which to move. The `/graph-ask` skill makes this easy.

---

### graph_stats

**Purpose:** Graph health dashboard.

**Input:** none

**Output:**
```json
{
  "schema_version": "1",
  "nodes": {
    "total": 127,
    "by_type": { "Person": 15, "Project": 8, "Preference": 23, "Concept": 45, "Decision": 12, "Fact": 20, "Event": 9, "Object": 14, "Alias": 4 }
  },
  "edges": {
    "total": 312,
    "by_type": { "WORKS_ON": 18, "PREFERS": 23, "KNOWS_ABOUT": 45, "USES_TECH": 30, "RELATED_TO": 180, "PARTICIPATED_IN": 12, "USES": 8, "CONTRADICTS": 2 }
  },
  "health": {
    "avg_weight": 0.52,
    "orphaned_nodes": 3,
    "unresolved_contradictions": 1,
    "stale_nodes": 8,
    "last_dream_run": "2026-04-06T23:00:00Z",
    "pending_ingest_docs": 1,
    "total_ingested_docs": 5
  }
}
```

---

### graph_delete

**Purpose:** Delete a specific entity and all its edges from the graph.

**Annotation:** `destructiveHint: true`

**Input:**
```json
{
  "entity_id": "string",
  "reason": "string"
}
```

**Output:**
```json
{
  "deleted": true,
  "entity": { "id": "...", "name": "...", "type": "..." },
  "edges_removed": 4
}
```

**When to use:** When an entity is clearly wrong, a test artifact, or was created by mistake. Claude should confirm with the user before calling.

---

### graph_read_transcript

**Purpose:** Read a session JSONL transcript via the canonical parser, returning normalized text messages. Shields dream process from JSONL format variations between Claude Code versions.

**Input:**
```json
{
  "session_id": "string",
  "file_path": "string",
  "text_only": true
}
```

Provide either `session_id` (resolved to `~/.claude/projects/**/<session_id>.jsonl`) or an explicit `file_path`. `text_only` (default `true`) strips tool calls and returns only human/assistant text.

**Output:**
```json
{
  "messages": [
    { "role": "human", "text": "...", "timestamp": "...", "session_id": "...", "cwd": "..." }
  ],
  "message_count": 42,
  "session_id": "...",
  "cwd": "..."
}
```

**When to use:** In the dream process before entity extraction. Prefer this over raw file reads.

---

### graph_audit

**Purpose:** Append a structured event to `~/graph-memory/logs/dream-audit.jsonl`. Used by the dream process at run checkpoints for observability.

**Input:**
```json
{
  "event": "run_start | run_end | transcript_start | transcript_end | transcript_skipped | entity_created | edge_created | edge_modified | merge_flagged | contradiction_found | ingest_start | ingest_end | decay_applied | format_warning | error",
  "data": {}
}
```

**Output:**
```json
{ "logged": true, "timestamp": "..." }
```

**When to use:** Called by the dream process at the start/end of each run and at key milestones. Not needed during normal conversation.

---

### graph_export

**Purpose:** Write a timestamped JSONL backup of all nodes and edges to `~/graph-memory/backups/`. Prunes old backups beyond the retention count.

**Input:**
```json
{
  "keep": 14,
  "label": "string"
}
```

`keep` (default 14) is the number of backups to retain. `label` is an optional suffix for the filename (e.g. `"pre-migration"`).

**Output:**
```json
{
  "backup_file": "~/graph-memory/backups/2026-05-06T12-00-00.jsonl",
  "node_count": 297,
  "edge_count": 418,
  "size_bytes": 184320,
  "pruned": 2,
  "retained": 14
}
```

**When to use:** Before schema migrations, before bulk imports, or on a scheduled basis via the `/graph-backup` skill.

---

### graph_validate

**Purpose:** Scan the graph for quality issues — generic names, reference language ("the X", "this X"), orphaned low-confidence entities, and near-duplicates. Returns a prioritized issues list.

**Input:**
```json
{
  "source_session": "string",
  "max_issues": 50
}
```

`source_session` (optional) scopes the scan to entities created in one session. `max_issues` (default 50) caps the result size.

**Output:**
```json
{
  "issues": [
    {
      "severity": "high | medium | low",
      "type": "generic_name | reference_language | orphan | near_duplicate",
      "entity_id": "...",
      "entity_name": "...",
      "description": "Name looks like a reference: 'the project'"
    }
  ],
  "issue_count": 7
}
```

**When to use:** After bootstrapping, after a large dream run, or periodically during the weekly deep dream.

---

### graph_communities

**Purpose:** Cluster entities into communities using greedy seed-based BFS through edges above a weight threshold. No GDS or APOC plugin required.

**Input:**
```json
{
  "weight_threshold": 0.4,
  "max_communities": 10,
  "max_hops": 3,
  "min_size": 2
}
```

`max_hops` capped at 4.

**Output:**
```json
{
  "communities": [
    {
      "id": 1,
      "seed_name": "graph-memory",
      "member_count": 12,
      "dominant_type": "Project",
      "members": [ { "id": "...", "name": "...", "type": "..." } ]
    }
  ],
  "total_members": 45,
  "coverage_pct": 72.5
}
```

**When to use:** During the weekly deep dream to surface topic clusters, or when you want to understand the graph's major knowledge areas.

---

### graph_build_context

**Purpose:** Bundle graph health, pending work, last dream run, recent additions, top hubs, contradictions, and an optional topic neighbourhood into a single call. Replaces 4–5 sequential round trips at session start.

**Input:**
```json
{
  "topic": "string",
  "project_cwd": "string",
  "recent_days": 7,
  "hub_count": 5,
  "include_contradictions": true,
  "max_recent": 15
}
```

All fields optional. `topic` triggers a neighbourhood expansion around the named entity.

**Output:** Combined object containing `stats`, `recent_entities`, `top_hubs`, `contradictions` (if `include_contradictions`), and `topic_neighbourhood` (if `topic` provided).

**When to use:** At session start via `/graph-briefing`, or whenever you want a full context snapshot in one tool call.

---

### graph_search

**Purpose:** Hybrid retrieval — embeds the query using the local `bge-small-en` model, finds top-K similar entities via Neo4j's vector index, then optionally expands into the surrounding graph via traversal.

**Input:**
```json
{
  "query": "string",
  "top_k": 10,
  "min_similarity": 0.5,
  "entity_types": ["string"],
  "expand": true,
  "expand_min_weight": 0.3
}
```

`query` is required. `entity_types` filters results to specific node labels. `expand` (default `true`) returns connected nodes and edges around the seed matches.

**Output:**
```json
{
  "seeds": [
    { "id": "...", "name": "...", "type": "...", "similarity": 0.87 }
  ],
  "expansion": {
    "nodes": [ { "id": "...", "name": "...", "type": "..." } ],
    "edges": [ { "from": "...", "to": "...", "type": "...", "weight": 0.7 } ]
  }
}
```

**When to use:** When `graph_query` (keyword-based) doesn't surface the right entities — e.g. for conceptually related queries or when the exact entity name is unknown.

---

### graph_reembed

**Purpose:** Regenerate embeddings for entities. By default fills missing embeddings only (safe to run anytime, idempotent). `force: true` re-embeds all entities — use after changing the embed-text recipe.

**Input:**
```json
{
  "force": false
}
```

**Output:**
```json
{
  "embedded": 42,
  "skipped": 255,
  "errors": 0
}
```

**When to use:** After the MCP server starts fresh with a new embed-text recipe, or when `graph_search` returns poor results due to stale embeddings.

---

## Error Handling

| Error | Response |
|-------|----------|
| Entity not found | Return empty result with `"found": false` |
| Duplicate entity on create | Merge with existing via `MERGE`, return `"action": "merged"` |
| Edge not found (for boost/weaken) | Return error suggesting `graph_relate` instead |
| Invalid weight (out of range) | Clamp to [0.0, 1.0], return warning |
| Neo4j connection failure | Return error: "graph unavailable — is the Docker container running?" |
| Cypher query timeout (>5s) | Kill query, return error suggesting narrower question |
| Neo4j transaction failure | Auto-retry (driver handles transient failures) |

## Performance Targets

| Operation | Target Latency |
|-----------|---------------|
| graph_query (2 hops) | < 100ms |
| graph_relate | < 50ms |
| graph_boost / graph_weaken | < 30ms |
| graph_entities (search) | < 100ms |
| graph_contradictions | < 200ms |
| graph_cypher (read-only) | < 5s (timeout) |
| graph_decay (full graph) | < 2s |
| graph_ingest (queue) | < 100ms |
| graph_ingest (status) | < 50ms |
| graph_prune (preview) | < 200ms |
| graph_prune (execute) | < 500ms |
| graph_unmerge | < 200ms |
| graph_stats | < 150ms |

All easily achievable for a personal-scale graph on local Neo4j.

## Configuration Resilience

All configuration values have **hardcoded defaults** compiled into the MCP server. The `config.json` file is an optional override — if it's missing, corrupted, or has missing keys, the server uses sensible defaults and logs a warning.

```typescript
// Hardcoded defaults (compiled into server)
// NOTE: Neo4j credentials come from environment variables ONLY (NEO4J_URI, NEO4J_USER,
// NEO4J_PASSWORD). They are NOT hardcoded here to avoid leaking into source control.
const DEFAULTS = {
  neo4j: {
    uri: process.env.NEO4J_URI || "bolt://localhost:7687",
    user: process.env.NEO4J_USER || "neo4j",
    password: process.env.NEO4J_PASSWORD  // REQUIRED — no fallback, fail if missing
  },
  weights: {
    explicit_statement: 0.7,
    inferred: 0.3,
    from_memory_file: 0.5,
    boost_on_confirm: 0.15,
    boost_on_mention: 0.05,
    weaken_on_correct: 0.3,
    project_context_boost: 0.10
  },
  decay: {
    rates: { Person: 0.998, Project: 0.995, Preference: 0.999, Concept: 0.999, Decision: 0.997, Fact: 0.996, Event: 0.993, Object: 0.996 },
    edge_rate: 0.997,
    prune_node_threshold: 0.1,
    prune_edge_threshold: 0.05
  },
  query: {
    default_max_hops: 2,
    default_min_weight: 0.3,
    default_limit: 20,
    cypher_timeout_ms: 5000
  },
  affinity: {
    hop_1_multiplier: 1.3,
    hop_2_multiplier: 1.15
  }
};
```

Config loading: `config.json` values deep-merge over defaults. Missing keys use defaults. Invalid values (e.g., weight > 1.0) are clamped with a warning.

## Concurrency

Neo4j handles this natively:
- Multiple simultaneous Bolt connections are fully supported
- Readers don't block writers
- Write-write conflicts on the same node are handled via internal locking (auto-retry by driver)
- MCP server and dream process each maintain their own driver instance
- No application-level lock files needed
- Neo4j transactions ensure atomicity — no partial writes on crash
