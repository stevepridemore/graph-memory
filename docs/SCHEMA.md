# Graph Memory System — Graph Schema (Neo4j)

## Overview

This document defines the Neo4j schema for the graph memory system. Neo4j is schema-optional — nodes and relationships are created dynamically with labels and properties. We define constraints and indexes for performance and data integrity.

### Design Patterns

- **Multi-labeling:** Every node gets an `:Entity` label plus its specific type. This enables querying all entities generically (`MATCH (n:Entity)`) OR by type efficiently (`MATCH (n:Person)`).
- **Subtypes:** Each node type has optional subtypes for finer granularity without schema explosion. Stored as a `subtype` property, not an additional label.
- **Confidence-max updates:** When an edge is reinforced, we take the max of current and new confidence for explicit statements, and additive boost for mentions. Prevents accidental downgrades from lower-confidence re-extraction.
- **Tool annotations:** MCP tools are annotated with `readOnlyHint`, `destructiveHint`, and `idempotentHint` (defined in MCP_SERVER.md).

## Schema Initialization

Run once when setting up the database (stored in `~/.claude/graph-memory/schema/v1.cypher`):

```cypher
// ─── Uniqueness Constraints (on :Entity label for cross-type uniqueness) ───
CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (n:Entity) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT alias_id IF NOT EXISTS FOR (n:Alias) REQUIRE n.id IS UNIQUE;

// ─── Type-Specific Indexes for Common Lookups ───
CREATE INDEX person_name IF NOT EXISTS FOR (n:Person) ON (n.name);
CREATE INDEX project_name IF NOT EXISTS FOR (n:Project) ON (n.name);
CREATE INDEX concept_name IF NOT EXISTS FOR (n:Concept) ON (n.name);
CREATE INDEX event_name IF NOT EXISTS FOR (n:Event) ON (n.name);
CREATE INDEX object_name IF NOT EXISTS FOR (n:Object) ON (n.name);
CREATE INDEX preference_key IF NOT EXISTS FOR (n:Preference) ON (n.domain, n.key);
CREATE INDEX alias_text IF NOT EXISTS FOR (n:Alias) ON (n.alias_text);
CREATE INDEX entity_subtype IF NOT EXISTS FOR (n:Entity) ON (n.subtype);

// ─── Full-Text Search Index (for fuzzy entity resolution) ───
CREATE FULLTEXT INDEX entity_names IF NOT EXISTS
FOR (n:Person|Project|Concept|Decision|Fact|Preference|Event|Object|Reasoning)
ON EACH [n.name, n.id];
```

## Node Types

All nodes carry the `:Entity` label PLUS their specific type label. Example: `(:Entity:Person { ... })`.

**Common properties** shared by ALL entity nodes:

```
{
    id: STRING,                     // unique identifier (lowercase, normalized)
    name: STRING,                   // display name
    subtype: STRING,                // optional finer categorization (see subtypes table)
    confidence: FLOAT,              // 0.0-1.0
    times_mentioned: INTEGER,       // default 1
    first_seen: DATETIME,
    last_seen: DATETIME,
    source_file: STRING             // path to associated memory .md file (if any)
}
```

---

### Person
People the user interacts with.

**Subtypes:** `individual`, `contact`, `group`

```
(:Entity:Person {
    ...common properties,
    role: STRING,                   // e.g. "boss", "spouse", "coworker", "vendor"
    relationship_to_user: STRING,   // e.g. "manager", "friend", "colleague"
    organization: STRING,
    email: STRING
})
```

### Project
Projects, initiatives, or bodies of work.

**Subtypes:** `active`, `paused`, `completed`, `abandoned`

```
(:Entity:Project {
    ...common properties,
    status: STRING,                 // mirrors subtype but can differ during transitions
    stack: STRING,                  // comma-separated tech stack
    description: STRING,
    directory: STRING,              // project directory path (for affinity matching)
    start_date: DATETIME
})
```

### Preference
User preferences, habits, or conventions.

**Subtypes:** `coding_style`, `tools`, `workflow`, `communication`, `environment`

```
(:Entity:Preference {
    ...common properties,
    domain: STRING,                 // mirrors subtype
    key: STRING,                    // e.g. "indentation", "language", "editor"
    value: STRING,                  // e.g. "tabs", "TypeScript", "VS Code"
    times_confirmed: INTEGER        // default 1 (tracks explicit confirmations separately)
})
```

### Concept
Technologies, topics, methodologies, or domains of knowledge.

**Subtypes:** `technology`, `methodology`, `domain`, `pattern`, `language`, `framework`

```
(:Entity:Concept {
    ...common properties,
    category: STRING,               // mirrors subtype
    user_expertise: STRING,         // "none", "beginner", "intermediate", "expert"
    description: STRING
})
```

### Decision
Choices made, with reasoning and context.

**Subtypes:** `architectural`, `process`, `tooling`, `design`, `policy`

```
(:Entity:Decision {
    ...common properties,
    what: STRING,                   // what was decided
    why: STRING,                    // reasoning
    context: STRING,                // surrounding circumstances
    reversible: BOOLEAN,            // default true
    status: STRING,                 // "active", "superseded", "reversed"
    decided_date: DATETIME,
    confidence: FLOAT               // default 0.7 (decisions start higher — they were explicit)
})
```

### Fact
Discrete pieces of knowledge or information.

**Subtypes:** `infrastructure`, `process`, `policy`, `configuration`, `credential_note`

```
(:Entity:Fact {
    ...common properties,
    domain: STRING,                 // mirrors subtype
    content: STRING,                // the fact itself
    source: STRING,                 // where this came from
    verified: BOOLEAN               // default false
})
```

### Event
Things that happened at a specific point in time. Meetings, deployments, incidents, milestones. Events have participants, locations, outcomes, and temporal context that Facts and Decisions don't capture.

**Subtypes:** `meeting`, `deployment`, `incident`, `review`, `milestone`, `conversation`, `discovery`

```
(:Entity:Event {
    ...common properties,
    description: STRING,            // what happened
    event_date: DATETIME,           // when it happened
    duration: STRING,               // optional: "30m", "2h", "all day"
    outcome: STRING,                // what resulted
    location: STRING,               // optional: where (physical or virtual)
    status: STRING                  // "completed", "cancelled", "scheduled"
})
```

**Why Events matter for memory:**
- "We decided to use Neo4j" is a Decision. "The meeting where we decided to use Neo4j" is an Event — it has participants, a date, other topics discussed, and follow-up actions.
- Events are natural hubs connecting People, Projects, Decisions, and Objects in temporal context.
- Asking "what happened last week?" is an Event query, not a Fact query.

### Object
Tangible or digital artifacts. Repositories, servers, databases, documents, config files, tools. Things with a state and a lifecycle that Concepts don't capture.

**Subtypes:** `repository`, `server`, `database`, `document`, `config`, `tool`, `container`, `service`, `file`

```
(:Entity:Object {
    ...common properties,
    object_type: STRING,            // mirrors subtype
    description: STRING,
    status: STRING,                 // "active", "deprecated", "archived", "broken"
    url: STRING,                    // optional: link, path, or address
    version: STRING                 // optional: current version
})
```

**Why Objects matter for memory:**
- "Docker" is a Concept. "The Neo4j container running on localhost:7687" is an Object — it has a specific state, version, and can break.
- "The graph-memory repo" is an Object, not a Project — the Project is the initiative; the Object is the artifact.
- Objects participate in relationships that Concepts can't: `HOSTED_ON`, `USES`, `PRODUCED_BY`.

### Reasoning
Captures *how* a problem was solved — the process and approach, not just the outcome. Useful for explaining why a Decision or Fact exists.

**Subtypes:** `debugging`, `design`, `analysis`, `research`

```
(:Entity:Reasoning {
    ...common properties,
    summary: STRING,                // brief description of the reasoning process
    approach: STRING,               // method used (e.g. "divide and conquer", "root cause analysis")
    outcome_summary: STRING         // what was concluded
})
```

**Key relationships:** `LED_TO` (Reasoning → Decision/Event/Fact) and `INVOLVED_IN` (Reasoning → Person/Project/Concept/Object).

### Alias
Tracks alternate names for entities (for entity resolution). Does NOT carry the `:Entity` label.

```
(:Alias {
    id: STRING,
    alias_text: STRING,             // the alternate name (normalized)
    target_type: STRING,            // which node label the target has
    target_id: STRING               // the id of the canonical entity
})
```

---

## Relationships

All relationships below can connect ANY node types unless explicitly noted. Every relationship has these common properties:

```
{
    weight: FLOAT,                  // 0.0-1.0
    last_confirmed: DATETIME,
    evidence: STRING,               // why this relationship exists

    // ─── Bi-temporal ───
    ingested_at: DATETIME,          // when this edge entered the graph (set once on create, never updated)
    valid_at: DATETIME,             // when this fact became true in reality (nullable)
    invalid_at: DATETIME,           // when this fact stopped being true (null = still valid)

    // ─── Provenance ───
    source_session: STRING,         // session ID of the conversation that sourced this
    source_transcript: STRING,      // path to the JSONL transcript file
    source_type: STRING             // "conversation", "ingest", "manual", "bootstrap"
}
```

**Bi-temporal note:** `ingested_at` records when the edge was added to the database — it is set once on create and never overwritten, even if the edge is later strengthened. `valid_at` / `invalid_at` record when the underlying fact was true in reality (system time vs. world time). This distinction matters for auditing: "when did we learn this?" (`ingested_at`) vs. "when was this true?" (`valid_at`).

### Validity Windows

When a fact is superseded, the old edge's `invalid_at` is set to the new edge's `valid_at`. The old edge is NOT deleted — it remains in the graph with a closed validity window. This enables:
- **Point-in-time queries:** "What did we believe on March 1st?"
- **Temporal chains:** Track how knowledge evolved over time
- **Audit trails:** See when and why a fact changed

Example — tech stack change:
```cypher
// March: "Project X uses Vue" — valid_at: March 1, invalid_at: April 5
// April: "Project X uses React" — valid_at: April 5, invalid_at: null (current)

// Query: "What's the current tech stack?"
MATCH (p:Project)-[r:USES_TECH]->(c:Concept)
WHERE r.invalid_at IS NULL  // only current facts
RETURN p.name, c.name

// Query: "What was the tech stack in March?"
MATCH (p:Project)-[r:USES_TECH]->(c:Concept)
WHERE r.valid_at <= datetime('2026-03-15')
  AND (r.invalid_at IS NULL OR r.invalid_at > datetime('2026-03-15'))
RETURN p.name, c.name
```

The CONTRADICTS relationship type is still used for genuine contradictions (two facts that can't both be true simultaneously and haven't been resolved). Validity windows handle the common case of facts being superseded over time.

### Provenance

Every edge tracks where it came from:
- `source_session` — which Claude Code session ID
- `source_transcript` — path to the JSONL file (for traceability back to raw data)
- `source_type` — how it was created: from a conversation, an ingested document, manual input via skill, or initial bootstrap

This enables: "Why does the graph think X?" → trace back to the exact conversation or document.

### Core Relationships

#### WORKS_ON
Person → Project

```cypher
(p:Person)-[:WORKS_ON {
    ...common properties,
    role: "lead",                   // "lead", "contributor", "reviewer", "stakeholder"
    since: datetime()
}]->(proj:Project)
```

#### WORKS_AT
Person → Organization (or Object/Concept used as org proxy)

```cypher
(p:Person)-[:WORKS_AT {
    ...common properties,
    role: "engineer"
}]->(org)
```

#### REPORTS_TO
Person → Person

```cypher
(p:Person)-[:REPORTS_TO {
    ...common properties
}]->(manager:Person)
```

#### STAKEHOLDER_IN
Person → Decision | Project | Event (interested party, distinct from DECIDED_FOR)

```cypher
(p:Person)-[:STAKEHOLDER_IN {
    ...common properties,
    interest: "technical reviewer"
}]->(d:Decision)
```

#### PREFERS
Person → Preference

```cypher
(p:Person)-[:PREFERS {
    ...common properties,
    strength: "strong"              // "strong", "moderate", "weak", "inferred"
}]->(pref:Preference)
```

#### KNOWS_ABOUT
Person → Concept

```cypher
(p:Person)-[:KNOWS_ABOUT {
    ...common properties,
    depth: "working"                // "surface", "working", "deep", "expert"
}]->(c:Concept)
```

#### DEPENDS_ON
Project → Project

```cypher
(a:Project)-[:DEPENDS_ON {
    ...common properties,
    dependency_type: "hard"         // "hard", "soft", "optional"
}]->(b:Project)
```

#### USES_TECH
Project → Concept

```cypher
(proj:Project)-[:USES_TECH {
    ...common properties,
    role: "primary"                 // "primary", "secondary", "testing", "infrastructure"
}]->(c:Concept)
```

#### DECIDED_FOR
Decision → Project | Concept | Object (any target)

```cypher
(d:Decision)-[:DECIDED_FOR {
    ...common properties
}]->(proj:Project)
```

#### SUPERSEDES
Decision → Decision

```cypher
(new:Decision)-[:SUPERSEDES {
    ...common properties,
    reason: "changed requirements",
    superseded_date: datetime()
}]->(old:Decision)
```

#### CONTRADICTS
Any → Any

Used for **genuine contradictions** — two facts that can't both be true simultaneously and haven't been resolved yet. NOT used for simple supersession (use validity windows for that: set `invalid_at` on the old edge).

Example — contradiction: "Alice prefers tabs" vs "Alice prefers spaces" (both claimed in different contexts, unclear which is true).
Example — NOT a contradiction: "Project X uses Vue" then later "Project X uses React" (this is supersession — set `invalid_at` on the Vue edge).

```cypher
(a)-[:CONTRADICTS {
    ...common properties,
    description: "conflicting claim",
    detected_date: datetime(),
    resolved: false,
    resolution: null
}]->(b)
```

#### RELATED_TO
Any → Any (generic catch-all)

**Allowed `relationship_type` values** (to prevent unbounded variation):
`similar_to`, `part_of`, `enables`, `impacts`, `depends_on`, `alternative_to`, `derived_from`, `implements`, `extends`, `configured_by`

```cypher
(a)-[:RELATED_TO {
    ...common properties,
    relationship_type: "similar_to" // constrained to allowed values above
}]->(b)
```

#### ALIAS_OF
Alias → any Entity

```cypher
(a:Alias)-[:ALIAS_OF { weight: 1.0 }]->(target:Entity)
```

### Event Relationships *(NEW)*

#### PARTICIPATED_IN
Person → Event (who was involved)

```cypher
(p:Person)-[:PARTICIPATED_IN {
    ...common properties,
    role: "presenter"               // "organizer", "presenter", "attendee", "observer"
}]->(e:Event)
```

#### OCCURRED_DURING
Event → Project (links events to project context)

```cypher
(e:Event)-[:OCCURRED_DURING {
    ...common properties
}]->(proj:Project)
```

#### PRODUCED
Event → Decision | Object | Fact (outcomes of events)

```cypher
// A meeting produced a decision
(e:Event)-[:PRODUCED {
    ...common properties
}]->(d:Decision)

// A deployment produced an artifact
(e:Event)-[:PRODUCED {
    ...common properties
}]->(obj:Object)
```

#### TRIGGERED_BY
Event → Event (causal chains)

```cypher
// An incident triggered a review meeting
(review:Event)-[:TRIGGERED_BY {
    ...common properties
}]->(incident:Event)
```

### Reasoning Relationships

#### LED_TO
Reasoning → Decision | Event | Fact (what the reasoning process produced)

```cypher
(r:Reasoning)-[:LED_TO {
    ...common properties
}]->(d:Decision)
```

#### INVOLVED_IN
Reasoning → Person | Project | Concept | Object (what or who the reasoning concerned)

```cypher
(r:Reasoning)-[:INVOLVED_IN {
    ...common properties
}]->(proj:Project)
```

### Object Relationships

#### USES
Project | Person → Object (who/what uses this artifact)

```cypher
(proj:Project)-[:USES {
    ...common properties,
    purpose: "primary database"     // what it's used for
}]->(obj:Object)
```

#### HOSTED_ON
Object → Object (infrastructure relationships)

```cypher
// App hosted on server, container on Docker, DB on container
(app:Object)-[:HOSTED_ON {
    ...common properties
}]->(server:Object)
```

#### PRODUCED_BY
Object → Project | Event (where this artifact came from)

```cypher
(repo:Object)-[:PRODUCED_BY {
    ...common properties
}]->(proj:Project)
```

---

## Weight System

### Weight Scale
All weights are `FLOAT` in range `[0.0, 1.0]`.

| Range | Meaning |
|-------|---------|
| 0.0 - 0.2 | Very weak — inferred, single mention, likely stale |
| 0.2 - 0.4 | Weak — mentioned a few times, not recently confirmed |
| 0.4 - 0.6 | Moderate — mentioned multiple times, some confirmation |
| 0.6 - 0.8 | Strong — explicitly stated, confirmed multiple times |
| 0.8 - 1.0 | Very strong — core fact, frequently confirmed, high confidence |

### Weight Update Strategy

Two update modes depending on how the reinforcement occurs:

**Additive boost (on mention or confirmation):**
```
new_weight = min(weight + boost_amount, 1.0)
```
Used when an entity/edge is mentioned again or the user confirms a recalled fact. Standard boosts: +0.05 for mention, +0.15 for explicit confirmation.

**Confidence-max (on re-extraction with explicit evidence):**
```
new_weight = max(weight, new_evidence_weight)
```
Used when the dream process re-extracts a relationship with a specific confidence score. Prevents a re-extraction at 0.5 from downgrading an edge that was previously boosted to 0.8.

**Combined in practice:**
```cypher
// Dream process re-extraction: take the max
MERGE (a)-[r:WORKS_ON]->(b)
ON CREATE SET r.weight = $weight, r.last_confirmed = datetime()
ON MATCH SET r.weight = CASE
    WHEN $weight > r.weight THEN $weight    // new evidence is stronger
    ELSE r.weight + 0.05                     // just a re-mention, small boost
  END,
  r.last_confirmed = datetime()
```

### Default Weights by Origin
| How the edge was created | Starting weight |
|--------------------------|----------------|
| Explicit user statement ("I prefer X") | 0.7 |
| Inferred from conversation context | 0.3 |
| Extracted from existing memory file | 0.5 |
| User confirmed a recalled fact | boost by +0.15 |
| Mentioned again in new conversation | boost by +0.05 |
| Event with participants | 0.6 (events are explicit by nature) |
| Object in use by project | 0.5 |

### Project-Context Boosting

**Active-project boost during dream extraction:**

Every conversation carries a `cwd` field in the JSONL transcript. During entity extraction, edges connecting entities to the active project get an additional boost:

| Situation | Extra boost |
|-----------|------------|
| Entity discussed while working in its project | +0.10 |
| Entity discussed in a different project | +0.00 (standard weight only) |
| Entity explicitly linked to a project | +0.10 (regardless of cwd) |

**Retrieval-time affinity scoring:**

When `graph_query` runs, edges connected to the active project's subgraph get a retrieval multiplier (not persisted — affects ranking only):

```
effective_weight = stored_weight * project_affinity_multiplier

where:
  1.0   = no project context / entity unrelated
  1.3   = entity within 1 hop of active project
  1.15  = entity within 2 hops of active project
```

**The multiplier does NOT suppress cross-project knowledge.** A globally strong edge (0.9) from another project still beats a weak in-project edge (0.3 × 1.3 = 0.39).

### Example: Affinity in Action
```
Working directory: ~/Documents/Projects/graph-memory
Query entities: ["database"]

Raw results (no affinity):
  1. PostgreSQL  — weight 0.65 (used in domino-auth-project)
  2. Neo4j       — weight 0.55 (used in graph-memory)
  3. SQLite      — weight 0.50 (used in graph-memory)

With project-context affinity (active: graph-memory):
  1. Neo4j       — weight 0.55 × 1.3 = effective 0.72  ← boosted
  2. SQLite      — weight 0.50 × 1.3 = effective 0.65  ← boosted
  3. PostgreSQL  — weight 0.65 × 1.0 = effective 0.65  (other project)
```

### Decay Function

```
new_weight = weight * (decay_rate ^ days_since_last_confirmed)
```

**Decay rates by entity type (configurable in config.json):**
| Entity Type | Daily Decay Rate | Half-life (approx) |
|-------------|-----------------|---------------------|
| Preference | 0.999 | ~693 days |
| Person | 0.998 | ~346 days |
| Project | 0.995 | ~138 days |
| Decision | 0.997 | ~231 days |
| Fact | 0.996 | ~173 days |
| Concept | 0.999 | ~693 days |
| Event | 0.993 | ~99 days (events age fastest — they're temporal by nature) |
| Object | 0.996 | ~173 days |

**Implementation note:** Decay is calculated from absolute `last_seen` / `last_confirmed` timestamps, not incrementally. This means it's correct regardless of how often the dream process runs. The `graph_decay` MCP tool applies this in batch.

### Pruning Threshold
Nodes are flagged for pruning (and eligible for `graph_prune`) when:
- `confidence < 0.1` AND no relationships with `weight > 0.2`, **OR**
- Zero edges (orphaned) AND `last_seen` older than `prune_orphan_days` (default: 30 days)

Flagged nodes appear in dream changelogs. Actual deletion requires `graph_prune` with explicit user confirmation — never auto-deleted.

---

## Example Queries

### "What do I know about Project X?"
```cypher
MATCH (p:Project {name: "project x"})-[r]-(n:Entity)
WHERE r.weight > 0.3
RETURN labels(n) AS types, n.name AS name, type(r) AS relation, r.weight AS weight
ORDER BY r.weight DESC
```

### "Who works on what?"
```cypher
MATCH (p:Person)-[w:WORKS_ON]->(proj:Project)
WHERE w.weight > 0.4
RETURN p.name, proj.name, w.role, w.weight
ORDER BY w.weight DESC
```

### "What happened recently?" (Event query)
```cypher
MATCH (e:Event)
WHERE e.event_date > datetime() - duration('P14D')
OPTIONAL MATCH (e)<-[:PARTICIPATED_IN]-(p:Person)
OPTIONAL MATCH (e)-[:OCCURRED_DURING]->(proj:Project)
RETURN e.name, e.subtype, e.event_date, e.outcome,
       collect(DISTINCT p.name) AS participants,
       collect(DISTINCT proj.name) AS projects
ORDER BY e.event_date DESC
```

### "What objects does this project use?"
```cypher
MATCH (proj:Project {name: "graph-memory"})-[:USES]->(obj:Object)
WHERE obj.status <> "deprecated"
RETURN obj.name, obj.subtype, obj.status, obj.url, obj.version
ORDER BY obj.name
```

### "What came out of that meeting?"
```cypher
MATCH (e:Event {subtype: "meeting"})-[:PRODUCED]->(outcome)
WHERE e.event_date > datetime() - duration('P7D')
RETURN e.name, e.event_date, labels(outcome) AS outcome_type,
       outcome.name, outcome.id
ORDER BY e.event_date DESC
```

### "Infrastructure map — what's hosted where?"
```cypher
MATCH (a:Object)-[:HOSTED_ON]->(b:Object)
RETURN a.name AS service, a.subtype AS type, b.name AS host, b.subtype AS host_type
ORDER BY b.name, a.name
```

### "Find unresolved contradictions"
```cypher
MATCH (a:Entity)-[c:CONTRADICTS]->(b:Entity)
WHERE c.resolved = false
RETURN labels(a) AS type_a, a.id AS id_a,
       labels(b) AS type_b, b.id AS id_b,
       c.description, c.detected_date
```

### "Stale entities needing review"
```cypher
MATCH (n:Entity)
WHERE n.confidence < 0.2
  AND n.last_seen < datetime() - duration('P90D')
RETURN labels(n) AS types, n.name, n.confidence, n.last_seen
ORDER BY n.confidence ASC
```

### "Everything related to a project directory"
```cypher
MATCH (p:Project)
WHERE p.directory CONTAINS 'graph-memory'
MATCH (p)-[r*1..2]-(n:Entity)
WHERE ALL(rel IN r WHERE rel.weight > 0.3)
RETURN DISTINCT labels(n) AS types, n.name, n.confidence
ORDER BY n.confidence DESC
```

---

## Entity Resolution Strategy

### During Extraction (performed by Claude in the session)

Claude handles entity resolution using its reasoning ability — no algorithmic fuzzy matching needed. The dream process prompt instructs Claude to:

1. Check existing entities via `graph_entities` MCP tool before creating new ones
2. Use the full-text search index for fuzzy name matching
3. Check the Alias table for known alternate names
4. When uncertain, create as new and flag for review in the changelog
5. **Never merge without high confidence** — false merges are worse than duplicates

### Alias Management
- When a new alias is discovered, create Alias node linked to canonical entity
- Common patterns: abbreviations, nicknames, project code names
- Dream process reviews potential aliases in each run

### Manual Override via Skills
- `/graph-boost` can adjust relationships
- `/graph-ask` can query for potential duplicates
- Claude can be asked to merge entities during any conversation

## Schema Summary

### Node Types (9 canonical types)
| Type | Subtypes | Decay Half-life | Default Confidence |
|------|----------|-----------------|-------------------|
| Person | individual, contact, group | 346 days | 0.5 |
| Project | active, paused, completed, abandoned | 138 days | 0.5 |
| Preference | coding_style, tools, workflow, communication, environment | 693 days | 0.5 |
| Concept | technology, methodology, domain, pattern, language, framework | 693 days | 0.5 |
| Decision | architectural, process, tooling, design, policy | 231 days | 0.7 |
| Fact | infrastructure, process, policy, configuration, credential_note | 173 days | 0.5 |
| Event | meeting, deployment, incident, review, milestone, conversation, discovery | 99 days | 0.5 |
| Object | repository, server, database, document, config, tool, container, service, file | 173 days | 0.5 |
| Reasoning | debugging, design, analysis, research | 173 days | 0.5 |
| Alias | *(none)* | *(no decay)* | *(n/a)* |

**Ad-hoc types:** claude.ai and other clients sometimes create entities with types not in the canonical list above (e.g., `Organization`, `Technology`, `Artifact`). Neo4j accepts these labels without error. We periodically review ad-hoc types that appear frequently and promote useful ones to the canonical list. The canonical list drives decay rates, schema documentation, and skill instructions.

### Relationship Types (22 total)
| Relationship | From → To | Key Properties |
|-------------|-----------|---------------|
| WORKS_ON | Person → Project | role, since |
| WORKS_AT | Person → Organization/any | role |
| REPORTS_TO | Person → Person | — |
| STAKEHOLDER_IN | Person → Decision/Project/Event | interest |
| PREFERS | Person → Preference | strength |
| KNOWS_ABOUT | Person → Concept | depth |
| DEPENDS_ON | Project → Project | dependency_type |
| USES_TECH | Project → Concept | role |
| USES | Project/Person → Object | purpose |
| DECIDED_FOR | Decision → any | — |
| SUPERSEDES | Decision → Decision | reason, superseded_date |
| CONTRADICTS | any → any | description, detected_date, resolved, resolution |
| RELATED_TO | any → any | relationship_type (constrained set) |
| ALIAS_OF | Alias → any Entity | — |
| PARTICIPATED_IN | Person → Event | role |
| OCCURRED_DURING | Event → Project | — |
| PRODUCED | Event → Decision/Object/Fact | — |
| TRIGGERED_BY | Event → Event | — |
| HOSTED_ON | Object → Object | — |
| PRODUCED_BY | Object → Project/Event | — |
| LED_TO | Reasoning → Decision/Event/Fact | — |
| INVOLVED_IN | Reasoning → Person/Project/Concept/Object | — |

### Vector Index

```cypher
CREATE VECTOR INDEX entity_embedding IF NOT EXISTS
FOR (n:Entity)
ON (n.embedding)
OPTIONS {
  indexConfig: {
    `vector.dimensions`: 384,
    `vector.similarity_function`: 'cosine'
  }
}
```

Powers `graph_search` hybrid retrieval. Embeddings are generated by the local `bge-small-en` model (384 dimensions). Use `graph_reembed` to fill missing embeddings or regenerate after recipe changes.

## Schema Migration Strategy

Schema versions are stored in `~/.claude/graph-memory/schema/`:

```
schema/
├── v1.cypher              # Initial schema (constraints + indexes)
├── migrations/
│   ├── v1_to_v2.cypher    # Add new node type, property, etc.
│   └── ...
└── current_version.txt    # Tracks applied version
```

### Execution Path

**Migrations are applied by the MCP server on startup**, NOT by the dream process or `graph_cypher` (which is read-only). The MCP server's initialization routine:

1. Reads `current_version.txt` (defaults to "0" if missing)
2. Scans `migrations/` for files matching `v{N}_to_v{N+1}.cypher`
3. Applies each pending migration in order using `session.executeWrite()`
4. Updates `current_version.txt` after each successful migration
5. Logs applied migrations to stdout

**This means schema changes take effect on MCP server restart.** Since the server starts fresh with each Claude Code session (stdio transport = new process per session), migrations apply automatically on the next session start.

### Rollback

Neo4j constraint and index creation is idempotent (`IF NOT EXISTS`). For destructive migrations, the migration file should include a comment block with the rollback Cypher. Rollback is manual via Neo4j Browser (`http://localhost:7474`).
