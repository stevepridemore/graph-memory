# Graph Memory System — MCP Server Design

## Overview

The `graph-memory-mcp` server is a thin wrapper around Neo4j. It executes Cypher queries and returns results. **No LLM calls — all intelligence stays in Claude Code sessions (Max plan).** 24 tools total.

This means:
- No API key needed
- The server makes no LLM calls. `@anthropic-ai/sdk` is used only by the optional API-key dream runner (`src/dream-runner`)
- Fast and predictable — every tool call is just a database operation
- Claude in the session handles entity extraction, Cypher generation, and reasoning

### Design Patterns

- **Tool annotations:** Each tool is annotated with `readOnlyHint`, `destructiveHint`, and `idempotentHint` so Claude can reason about which tools are safe to call speculatively.
- **Multi-label nodes:** All entity nodes carry `:Entity` plus their type label. Tools that search across types use the `:Entity` label; tools that filter use specific labels.
- **Confidence-max MERGE pattern:** Write tools use `MERGE`. When the new weight is higher, it replaces the stored weight. Otherwise the stored weight gets +0.05, capped at 1.0.

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

`max_hops` is capped at 4, even if a larger value is passed.

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
  "coercions": [ { "kind": "relation", "from": "RUNS_ON", "to": "DEPLOYED_TO" } ]
}
```

`coercions` appears only when a type or verb was changed (see Vocabulary below).

**Output (batch):**
```json
{
  "entities_created": 3,
  "entities_merged": 1,
  "edges_created": 2,
  "edges_strengthened": 0,
  "edges_failed": 0,
  "failed_refs": [],
  "skipped_entities": [],
  "coercions": []
}
```

**Behavior:**
- **Single mode:** Finds or creates both endpoints, then `MERGE`s the edge. These are separate statements, not one transaction. If the edge exists, the weight becomes the new weight when that is higher, otherwise the current weight plus 0.05 (capped at 1.0). Sets `valid_at` if provided.
- **Batch mode:** Resolves `localId` references and writes all entities and relations in one write transaction. An entity or relation that fails validation (an empty name, a `valid_at` that is not a date, or a type or verb rejected under `SCHEMA_ENFORCEMENT=strict`) is skipped and listed in `skipped_entities` or `failed_refs`. Relations whose endpoints do not resolve also go to `failed_refs`. The rest is written. Only a database error rolls back the whole batch. Provenance fields (`source_session`, `source_transcript`, `source_type`) are applied to all edges in the batch. Batch mode does not supersede: `valid_at` is stored, but no other edge is invalidated.
- **Vocabulary (`SCHEMA_ENFORCEMENT`):** Known aliases map to the documented value with no proposal recorded (for example `RUNS_ON` to `DEPLOYED_TO`, or `tool` to `Technology`). An unknown type is stored as `Object`, and the original is kept in `proposed_type`. An unknown verb is stored as `RELATED_TO`, and the original is kept in `proposed_relations`. `coerce` (default) does this. `lenient` writes the input as given. `strict` rejects it.
- **Supersession (single mode):** If `valid_at` is given and the relation is not `FAMILY_OF`, `KNOWS`, `COLLABORATES_WITH`, `MENTOR_OF`, `ALIAS_OF`, `CONTRADICTS` or `RELATED_TO`, current edges of the same type from the same source to a different target get `invalid_at` set to `valid_at`. Without `valid_at`, nothing is superseded. Genuine contradictions still need an explicit `CONTRADICTS` edge.

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
  "amount": 0.3,
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

`pruned` is `true` when the new weight is 0.05 or lower. Nothing is deleted. The tool returns an error if the edge does not exist.

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
      "node_a": { "id": "...", "type": "Fact", "name": "..." },
      "node_b": { "id": "...", "type": "Fact", "name": "..." },
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
  "content": "string",
  "file_name": "string",
  "meta": {
    "source": "string",
    "author": "string",
    "date": "string",
    "topic_hints": ["string"],
    "weight_override": 0.6,
    "session_id": "string",
    "through": "ISO timestamp",
    "last_event_id": "string"
  }
}
```

For `queue`, give either `file_path` (a file on the server, copied into `pending/`) or `content` + `file_name` (text written straight into `pending/`). Inline content is for remote callers that can't reach the server's filesystem, such as the cloud-session collector. It is admin-tenant only, capped at 2 MB, and `file_name` must be a plain basename ending `.md`, `.txt` or `.json`.

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
  "completed_count": 5,
  "session_cursors": {
    "session_01abc": { "through": "2026-10-19T04:58:00Z", "last_event_id": "cmsg_01...", "file": "cloud-session_01abc-20261019045800.md" }
  }
}
```

`session_cursors` lists, per session, the newest `meta.through` among `pending/` and `completed/` sidecars whose `meta.source` is `"claude-code-cloud"`. The cloud-session collector uses it to queue only new messages.

---

### graph_cypher

**Purpose:** Execute a pre-formed Cypher query against Neo4j. **Read-only.** Admin tenant only. Claude generates the Cypher in the session — this tool just runs it.

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
- **30-second transaction timeout** (the `runReadOnly` default) to prevent runaway traversals. The `query.cypher_timeout_ms` config value is not read by this path.
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
  "nodes_flagged_for_pruning": 3
}
```

**Behavior:**
Runs one Cypher statement per node type in `config.decay.rates`, then one for edges. Only these types decay: Person, Project, Preference, Concept, Decision, Fact, Event, Object. `Reasoning` and the other types have no rate and never decay. Nodes and edges with `subtype: 'rule'` on either end are exempt.

Decay is measured from the later of `last_seen` (for edges, `last_confirmed`) and `last_decayed`. Each run stamps `last_decayed`, so repeated runs do not compound. The exponent is whole elapsed days. Confidence and weight are floored at 0.01.

Each statement is its own auto-commit write, so the run is not all-or-nothing. A failure part-way leaves earlier updates in place. With `dry_run: true`, `nodes_decayed` counts the nodes that would decay, and `edges_decayed` is always 0.

```cypher
// Node pass for Project (rate 0.995 from config.decay.rates)
MATCH (n:Project {tenant_id: $tenantId})
WHERE (n.subtype IS NULL OR n.subtype <> 'rule')
WITH n, CASE
    WHEN n.last_decayed IS NULL THEN n.last_seen
    WHEN n.last_seen IS NULL THEN n.last_decayed
    WHEN n.last_decayed > n.last_seen THEN n.last_decayed
    ELSE n.last_seen END AS base_ts
WHERE base_ts IS NOT NULL AND base_ts < datetime() - duration('P1D')
WITH n, n.confidence * ($rate ^ duration.inDays(base_ts, datetime()).days) AS new_conf
SET n.confidence = CASE WHEN new_conf < 0.01 THEN 0.01 ELSE new_conf END,
    n.last_decayed = datetime()
RETURN count(n) AS decayed
```

---

### graph_prune

**Purpose:** Remove entities and edges that have decayed below threshold. Provides a preview before destructive action. Called after reviewing `graph_decay` results or `graph_entities` output.

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
- `node_threshold` — prune nodes with confidence below this AND no edges with weight at or above `edge_threshold`. Defaults to config value (`decay.prune_node_threshold`).
- `edge_threshold` — prune edges with weight below this. Defaults to config value (`decay.prune_edge_threshold`).
- `include_orphans` (default `true`) also prunes nodes with zero edges, `confidence` at or above `node_threshold`, and `last_seen` older than `max_age_days`.
- `max_age_days` — age threshold for orphan pruning (default: 30, from config `decay.prune_orphan_days`).

**Output (preview):**
```json
{
  "mode": "preview",
  "nodes_pruned": 1,
  "edges_pruned": 1,
  "details": [
    { "action": "would_delete_node", "id": "old-project", "type": "Project" },
    { "action": "would_delete_edge", "from": "alice", "to": "old-project", "type": "WORKS_ON" }
  ]
}
```

**Output (execute):**
```json
{
  "mode": "executed",
  "nodes_pruned": 1,
  "edges_pruned": 1,
  "details": []
}
```

**Behavior:**
1. Query for all nodes with `confidence < node_threshold` that have no edges with `weight >= edge_threshold`
2. Query for all edges with `weight < edge_threshold`
3. If `include_orphans`: also find nodes with zero edges and `last_seen` older than `max_age_days`
4. In preview mode: return the lists without modifying anything
5. In execute mode: delete every edge below `edge_threshold` in the tenant, then `DETACH DELETE` the node list. These are separate statements, not one transaction, so a failure part-way leaves earlier deletions in place. `details` is empty in execute mode.
6. Execute does not re-apply the rule-subtype exemption to edges, which preview does. Alias nodes are not touched.

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
3. Log the split in the merge audit log (`$GRAPH_MEMORY_HOME/logs/merge-audit.jsonl`)
4. Return summary of what was moved

**Edge identification:** Edges are identified by composite key (`other_entity_id` + `relation_type` + `direction`) rather than internal Neo4j IDs, which are not stable across restarts. If multiple edges exist between the same pair with the same type (rare), all are moved.

**If `edges_to_move` is empty:** Claude can use `graph_query` on the merged entity first to inspect all edges, then decide which to move. The `/graph-ask` skill makes this easy.

---

### graph_merge

**Purpose:** Consolidate two entities into one. Moves the source's edges onto the target, copies source properties the target lacks, then deletes the source. Inverse of `graph_unmerge`.

**Annotation:** `destructiveHint: true`

**Input:**
```json
{
  "source_id": "string",
  "target_id": "string",
  "reason": "string",
  "dry_run": false
}
```

**Output:**
```json
{
  "source": { "id": "...", "name": "...", "deleted": true },
  "target": { "id": "...", "name": "..." },
  "edges_added": 3,
  "edges_consolidated": 1,
  "self_loops_dropped": 0,
  "properties_adopted": ["..."],
  "dry_run": false,
  "audit_logged": true
}
```

**Behavior:**
1. Both IDs must exist in the caller's tenant. Merging an entity into itself is an error.
2. Direct edges between source and target are dropped, since they would become self-loops (`self_loops_dropped`).
3. Each other edge moves to the target. If the target already has an edge of the same type to the same node, the two are consolidated (`edges_consolidated`) and the higher weight is kept.
4. Properties the target lacks are copied. Reserved keys (`id`, `tenant_id`, `name`, `embedding`, `first_seen`, `last_seen`, `times_mentioned`, `confidence`) are not copied.
5. The target's embedding is cleared. Run `graph_reembed` to rebuild it.
6. The source node is deleted.
7. Each non-dry-run merge appends a line with `reason` to `$GRAPH_MEMORY_HOME/logs/merge-audit.jsonl`. Dry runs are not logged.

With `dry_run: true`, nothing changes. `edges_added` is an upper bound, and `edges_consolidated` is 0. Run a dry run first, since the merge is destructive.

### graph_alias

**Purpose:** Add or remove alternate names for an entity. Later writes and lookups that use an alias resolve to the entity instead of creating a duplicate node.

**Annotation:** `idempotentHint: true`

**Input:**
```json
{
  "entity": "string",
  "add": ["string"],
  "remove": ["string"]
}
```

**Output:**
```json
{
  "id": "robin",
  "aliases": ["Robbie"]
}
```

**Behavior:**
- `entity` is resolved by exact name, case-insensitive name, or alias. The tool returns `No entity found for "..."` if nothing matches.
- Aliases are stored in the entity's `aliases` property. No node is created.
- Alias matching is case-insensitive. An exact entity name takes precedence over an alias.
- If both `add` and `remove` are given, `add` runs first.
- With neither, the current list is returned.

### graph_merge_suggestions

**Purpose:** Surface candidate pairs of entities likely to be the same thing — the read-only counterpart to `graph_unmerge`. LLM-driven extraction (the dream process) reliably produces near-duplicates as the graph grows; this tool flags them for human review.

**Why this exists:** Entity-explosion is the natural failure mode of any LLM-driven extraction pipeline. Without a way to surface duplicates, they pile up and degrade retrieval quality silently. This tool gives operators a triage queue.

**Input:**
```json
{
  "entity_id": "string",                    // optional — scope to one entity's duplicates
  "entity_type": "string",                  // optional — scope to one type (Person, Project, …)
  "min_score": 0.8,                         // optional — combined-score threshold (default 0.8)
  "min_embedding_similarity": 0.85,         // optional — vector floor (default 0.85)
  "limit": 20,                              // optional — max suggestions returned (default 20, max 100)
  "weights": {                              // optional — override default 0.4/0.4/0.2
    "embedding": 0.4,
    "neighbor_jaccard": 0.4,
    "name": 0.2
  },
  "log_to_audit": true                      // optional — emit merge_flagged events (default true)
}
```

**Output:**
```json
{
  "suggestions": [
    {
      "entity_a": { "id": "postgres", "name": "Postgres", "type": "Technology", "edge_count": 7 },
      "entity_b": { "id": "postgresql", "name": "PostgreSQL", "type": "Technology", "edge_count": 4 },
      "score": 0.92,
      "signals": {
        "embedding_similarity": 0.97,
        "name_similarity": 0.50,
        "neighbor_jaccard": 0.85,
        "shared_neighbors": [
          { "id": "graph-memory", "relation": "USES_TECH", "degree": 28, "weight": 0.23 },
          { "id": "letters-workspace", "relation": "USES_TECH", "degree": 3, "weight": 0.48 }
        ]
      },
      "recommended_action": "review"
    }
  ],
  "total_pairs_evaluated": 412,
  "threshold_used": 0.7,
  "scope": { "entity_type": "Technology", "global": false }
}
```

**Scoring:**
```
score = w.embedding · embedding_similarity
      + w.neighbor_jaccard · weighted_jaccard(N(a), N(b))
      + w.name · |tokens(a) ∩ tokens(b)| / |tokens(a) ∪ tokens(b)|

weighted_jaccard(A, B) = Σ weight(n) for n ∈ (A ∩ B)
                       / Σ weight(n) for n ∈ (A ∪ B)
weight(n) = 1 / (1 + ln(degree(n)))
```

Same-type is a hard gate — never suggests cross-type merges. The weighted Jaccard is **hub-aware**: shared neighbors that are themselves connected to many other entities (e.g. the user's own Person node, with ~50 edges) contribute little to the match score, while shared neighbors with few connections contribute close to 1.0. This prevents the false-positive cluster where every pair of entities owned by the same person looks like a duplicate.

**Hub weight examples:** degree 1 → 1.0, degree 2 → 0.59, degree 5 → 0.38, degree 10 → 0.30, degree 50 → 0.20, degree 100 → 0.18.

**Behavior:**
1. Build seed set from `entity_id` / `entity_type` / global (capped at 200 seeds for safety)
2. For each seed, query the `entity_embedding` vector index for top-10 same-type neighbors above `min_embedding_similarity`
3. Dedupe pairs (canonicalised so `a.id < b.id`)
4. For each pair, fetch names + neighbor sets in one Cypher query, compute Jaccard signals
5. Apply weights, filter by `min_score`, rank, return top `limit`
6. If `log_to_audit` (default true), emit one `merge_flagged` event per surfaced pair to `dream-audit.jsonl`

**Performance:** O(seeds × top_k) vector queries. `entity_id`-scoped runs in <500ms for any single entity. `entity_type`-scoped or global runs scale with the seed cap (200 × 10 = 2000 vector queries, ~20s on the 384-dim cosine index).

**When to use:**
- Periodically (weekly?) — global scan to triage the duplicate backlog
- Right after a heavy ingest — type-scoped scan on the entity types most likely affected
- Reactively — when you suspect a specific entity has duplicates, scope to its `entity_id`

**Pairs with:** `graph_unmerge` (inverse — splits false merges) and `graph_merge` (executes an approved merge; run with `dry_run: true` first). To keep two entities separate but linked, use `graph_alias` to add the other name, or `graph_relate` with `ALIAS_OF`.

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
    "pending_ingest_docs": 1
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
  "id": "string"
}
```

**Output:**
```json
{
  "action": "deleted",
  "id": "..."
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

Provide `session_id` (searched for as `~/.claude/projects/*/<session_id>.jsonl`) or `file_path`. If both are given, `file_path` wins. `text_only` (default `true`) returns only messages with non-empty text. Roles are `user`, `assistant` and `system`.

**Output:**
```json
{
  "session_id": "...",
  "cwd": "...",
  "format_version": "v1",
  "line_count": 120,
  "message_count": 42,
  "text_message_count": 30,
  "warnings": [],
  "messages": [
    { "role": "user", "timestamp": "...", "uuid": "...", "parentUuid": "...", "text": "..." }
  ]
}
```

`message_count` counts every parsed message. `messages` holds only the text messages when `text_only` is `true`.

**When to use:** In the dream process before entity extraction. Prefer this over raw file reads.

---

### graph_audit

**Purpose:** Append a structured event to `~/graph-memory/logs/dream-audit.jsonl`. Used by the dream process at run checkpoints for observability.

**Input:**
```json
{
  "event": "run_start | run_end | transcript_start | transcript_end | transcript_skipped | entity_created | entity_resolved | edge_created | edge_modified | merge_flagged | contradiction_found | ingest_start | ingest_end | decay_applied | format_warning | error",
  "data": {}
}
```

**Output:**
```json
{ "logged": true, "event": "...", "timestamp": "..." }
```

**When to use:** Called by the dream process at the start/end of each run and at key milestones. Not needed during normal conversation.

---

### graph_export

**Purpose:** Write a timestamped JSONL backup of the caller's tenant's nodes and edges to `$GRAPH_MEMORY_HOME/backups/` (default `~/graph-memory/backups/`). Prunes old backups beyond the retention count.

**Input:**
```json
{
  "keep": 14,
  "label": "string"
}
```

`keep` (1-30, default 14) is the number of backups to retain. `label` is an optional suffix for the filename (e.g. `"pre-migration"`). Characters other than letters, digits and hyphens in the label are replaced with hyphens. Files are named `backup-<YYYY-MM-DDTHH-MM-SS>[-<label>].jsonl`. The first line is a `meta` record, followed by `node` and `edge` records.

**Output:**
```json
{
  "backup_file": "~/graph-memory/backups/backup-2026-05-06T12-00-00.jsonl",
  "node_count": 297,
  "edge_count": 418,
  "size_bytes": 184320,
  "pruned": 2,
  "retained": 14
}
```

**When to use:** Before schema migrations, before bulk imports, or on a scheduled basis via the `/graph-backup` skill. This is one of two backup layers — see [docs/BACKUP.md](BACKUP.md) for the full runbook covering volume snapshots, logical exports, and disaster-recovery scenarios.

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

`source_session` (optional) scopes the scan to entities created in one session. `max_issues` (1-200, default 50) caps the result size. Checks: names under 3 characters or on a generic-term list (high), names starting with reference language such as "the " (high), isolated entities with confidence at or below 0.4 and at most one mention (low), and entities that share a name ignoring case (medium).

**Output:**
```json
{
  "total_issues": 7,
  "by_severity": { "high": 3, "medium": 1, "low": 3 },
  "scope": "full graph",
  "issues": [
    {
      "entity_id": "...",
      "name": "...",
      "type": "Concept",
      "issue": "...",
      "severity": "high | medium | low"
    }
  ]
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
      "seed_id": "graph-memory",
      "member_count": 12,
      "dominant_type": "Project",
      "members": [ { "id": "...", "name": "...", "type": "..." } ]
    }
  ],
  "coverage": { "total_entities": 120, "assigned": 45, "unassigned": 75 }
}
```

`members` holds at most 30 entries. `member_count` is the full count. Each entity joins at most one community. Communities are listed in the order their seeds were ranked (strong-edge degree), not by size.

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

All fields optional. `recent_days` is 1-90 (default 7). `hub_count` is 1-20 (default 5). `max_recent` is 1-50 (default 15). `include_contradictions` defaults to `true`. `topic` adds a neighbourhood (2 hops, edge weight at least 0.3, up to 15 nodes and 25 edges returned). `project_cwd` applies affinity scoring to that neighbourhood.

**Output:** One object with these keys:
- `generated_at`
- `graph_health`: `nodes`, `edges`, `by_node_type`, `avg_weight`, `orphaned`, `stale`, `unresolved_contradictions`
- `pending_work`: `unprocessed_transcripts`, `pending_ingests`, `last_dream_run`, `hours_since_last_dream`
- `last_dream`: the latest run start and end from `logs/dream-audit.jsonl`, or a summary from `processed/manifest.json` (`source: "manifest"`), or `null`
- `recent_additions`: `days`, `entity_count`, `edge_count`, `entities`
- `top_hubs`
- `contradictions`: the unresolved list, or `null` when `include_contradictions` is false
- `topic_neighbourhood`: `topic`, `node_count`, `edge_count`, `nodes`, `edges`, or `null` when no `topic` is given

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

`query` is required. `top_k` is 1-50 (default 10). `min_similarity` is 0-1 (default 0.5). `entity_types` filters results to node labels from the entity vocabulary; other values are rejected. `expand` (default `true`) adds the neighbours of the seeds. `expand_min_weight` (default 0.3) is the edge weight floor for that expansion.

**Output:**
```json
{
  "query": "...",
  "seeds": [
    { "id": "...", "name": "...", "type": "...", "similarity": 0.87 }
  ],
  "expansion": {
    "nodes": [ { "id": "...", "name": "...", "type": "..." } ],
    "edges": [ { "from": "...", "to": "...", "type": "...", "weight": 0.7 } ]
  }
}
```

`expansion` is `null` when `expand` is false or no seeds match. Only the top 5 seeds are expanded, and at most 30 edges are returned, highest weight first.

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
  "errors": 0,
  "force": false,
  "scope": "all-tenants"
}
```

**When to use:**

| Trigger | `force` | Why |
|---|---|---|
| After `graph_merge` | `false` (default) | The merge clears `target.embedding`; default mode picks it up next call. |
| Bulk-import or restore from `graph_export` finished | `false` | Imported nodes arrive without embeddings (export is JSONL only). |
| Embed-text recipe changed (new fields included in `buildEmbedText`) | `true` | Existing embeddings reflect the old recipe; semantic-search quality drifts until rebuilt. |
| Embedding model swapped (different model id, dimensions, or version) | `true` | Old vectors are no longer comparable to query vectors from the new model. |
| `graph_search` returns obviously poor results despite reasonable queries | `true` | Last-resort diagnostic; consider checking the embed-text recipe first. |

**When NOT to run it:** Don't include in routine maintenance. The default (`force: false`) is idempotent and cheap, but `force: true` re-embeds every node (~10ms per entity, so a few hundred nodes finish in seconds, but multi-thousand-node graphs aren't free). Routine writes already embed at creation time — `graph_reembed` is for catching gaps and recovering from changes that invalidate prior vectors.

**Tenant scope:** When called by an admin tenant, re-embeds across all tenants. Otherwise scoped to the caller's tenant.



---

## Error Handling

| Error | Response |
|-------|----------|
| Entity not found | Return empty result with `"found": false` |
| Duplicate entity on create | `MERGE` matches the existing node. Batch mode counts it in `entities_merged` |
| Edge not found (for boost/weaken) | Tool returns an `Edge not found` error. Use `graph_relate` to create the edge |
| Invalid weight (out of range) | Clamp to [0.0, 1.0]. No warning is returned |
| Neo4j connection failure | Tool returns the driver error. Startup logs say "Is the Docker container running?" |
| Cypher query timeout (30 s) | Neo4j aborts the transaction. Tool returns the driver error |
| Neo4j transaction failure | Auto-retry (driver handles transient failures) |

## Performance Targets

| Operation | Target Latency |
|-----------|---------------|
| graph_query (2 hops) | < 100ms |
| graph_relate | < 50ms |
| graph_boost / graph_weaken | < 30ms |
| graph_entities (search) | < 100ms |
| graph_contradictions | < 200ms |
| graph_cypher (read-only) | < 5s (30 s timeout) |
| graph_decay (full graph) | < 2s |
| graph_ingest (queue) | < 100ms |
| graph_ingest (status) | < 50ms |
| graph_prune (preview) | < 200ms |
| graph_prune (execute) | < 500ms |
| graph_unmerge | < 200ms |
| graph_merge_suggestions (entity_id-scoped) | < 500ms |
| graph_merge_suggestions (entity_type-scoped or global) | scales with seed cap; ~10–20s typical |
| graph_stats | < 150ms |

All easily achievable for a personal-scale graph on local Neo4j.

## Configuration Resilience

All configuration values have **hardcoded defaults** compiled into the MCP server. The `config.json` file is an optional override — if it's missing, corrupted, or has missing keys, the server uses the built-in defaults without logging a warning.

```typescript
// Hardcoded defaults (compiled into server)
// NOTE: Neo4j credentials come from environment variables ONLY (NEO4J_URI, NEO4J_USER,
// NEO4J_PASSWORD). They are NOT hardcoded here to avoid leaking into source control.
const DEFAULTS = {
  neo4j: {
    uri: process.env.NEO4J_URI || "bolt://localhost:7687",
    user: process.env.NEO4J_USER || "neo4j",
    database: process.env.NEO4J_DATABASE || "neo4j",
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
    prune_edge_threshold: 0.05,
    prune_orphan_days: 30
  },
  query: {
    default_max_hops: 2,
    default_min_weight: 0.3,
    default_limit: 20,
    cypher_timeout_ms: 5000   // not read by the query path; graph_cypher uses a 30 s timeout
  },
  affinity: {
    hop_1_multiplier: 1.3,
    hop_2_multiplier: 1.15
  }
};
```

Config loading: `config.json` values deep-merge over defaults. Missing keys use defaults. Weights and decay rates are clamped to [0, 1] without a warning.

## Concurrency

Neo4j handles this natively:
- Multiple simultaneous Bolt connections are fully supported
- Readers don't block writers
- Write-write conflicts on the same node are handled via internal locking (auto-retry by driver)
- MCP server and dream process each maintain their own driver instance
- No application-level lock files needed
- Neo4j transactions ensure atomicity — no partial writes on crash
