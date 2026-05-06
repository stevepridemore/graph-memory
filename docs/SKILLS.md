# Graph Memory System — Skill Wrappers (Slash Commands)

## Overview

These skills provide slash-command interfaces to the graph memory system. They live at `~/.claude/skills/` so they're available globally in every Claude Code session — desktop app, CLI, or IDE.

Each skill is a thin wrapper that calls the `graph-memory` MCP server tools.

## Installation

```bash
mkdir -p ~/.claude/skills/ingest
mkdir -p ~/.claude/skills/graph
mkdir -p ~/.claude/skills/graph-ask
mkdir -p ~/.claude/skills/graph-stats
mkdir -p ~/.claude/skills/graph-dream
mkdir -p ~/.claude/skills/graph-find
mkdir -p ~/.claude/skills/graph-boost
mkdir -p ~/.claude/skills/graph-briefing
```

Then create each `SKILL.md` as described below.

---

## /ingest

**Purpose:** Queue or immediately process a document into the memory graph.

**Location:** `~/.claude/skills/ingest/SKILL.md`

**Usage:**
```
/ingest path/to/file.md
/ingest path/to/transcript.srt --now
/ingest path/to/article.pdf --source "blog post" --author "Karpathy" --topic "LLM wiki"
```

**Behavior:**
- Default: queues file via `graph_ingest` with `action: "queue"`, processed on next dream run
- `--now` flag: Claude reads the file inline, extracts entities, and calls `graph_relate` directly (no separate API call — runs in the current session)
- Optional metadata flags get written to `.meta.json` sidecar
- Confirms what was queued/processed and how many entities were extracted

```yaml
---
name: ingest
description: Ingest a document into the memory graph. Use when the user wants to add a file, transcript, article, PDF, or any document to their knowledge graph for entity extraction.
argument-hint: [file-path] [--now] [--source "type"] [--author "name"] [--topic "hint"]
---

The user wants to ingest a document into the graph memory system.

Arguments: $ARGUMENTS

Parse the arguments:
- First positional argument is the file path (required)
- `--now` flag means process immediately in the current session (Claude reads the file, extracts entities inline, and calls graph_relate directly)
- `--source` optional: document type (e.g. "YouTube transcript", "meeting notes", "article")
- `--author` optional: who wrote/created it
- `--topic` optional: topic hints for better extraction (comma-separated)

Steps:
1. Verify the file exists at the given path using the Read tool
2. If `--now` is NOT present (default — queue for later):
   a. Call the `graph_ingest` MCP tool with action: "queue", file_path, and meta
   b. Report: file is queued and will be processed on the next dream run
3. If `--now` IS present (immediate processing — you do the extraction inline):
   a. Read the file content directly
   b. Read the .meta.json sidecar if it exists alongside the file
   c. Extract entities and relationships from the content (you reason about it)
   d. For each entity: check if it exists via `graph_entities` tool first
   e. Call `graph_relate` for each new entity and relationship
   f. Call `graph_boost` for any reinforcements of existing knowledge
   g. Report: how many entities and edges were extracted
   h. Move the file to the completed folder or note that it was processed inline

If no file path is provided, ask the user for one.
```

---

## /graph

**Purpose:** Query the memory graph. The primary way to explore what the system knows.

**Location:** `~/.claude/skills/graph/SKILL.md`

**Usage:**
```
/graph Anna
/graph Project X --hops 3
/graph React --type Concept
/graph "auth module" --related
```

**Behavior:**
- Queries the graph starting from the given entity name(s)
- Automatically passes the current working directory as `project_context` for affinity scoring
- Shows connected entities, relationship types, and weights
- `--hops N` overrides default traversal depth
- `--type` filters by entity type
- `--related` shows all entities related to the query entity

```yaml
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
```

---

## /graph-stats

**Purpose:** Dashboard view of graph health and status.

**Location:** `~/.claude/skills/graph-stats/SKILL.md`

**Usage:**
```
/graph-stats
```

**Behavior:**
- Shows node/edge counts by type
- Shows health metrics (orphans, contradictions, stale nodes)
- Shows pending ingest documents and transcripts
- Shows last dream run timestamp

```yaml
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
```

---

## /graph-bootstrap

**Purpose:** One-time bulk import of existing knowledge into the graph.

**Location:** `~/.claude/skills/graph-bootstrap/SKILL.md`

**Usage:**
```
/graph-bootstrap
/graph-bootstrap --memory-only
/graph-bootstrap --transcripts-only
/graph-bootstrap --dry-run
```

**Behavior:**
- Processes all memory `.md` files in `~/.claude/projects/*/memory/` (high priority, curated knowledge)
- Then processes unprocessed conversation transcripts (same as dream process)
- Boosts existing entities rather than creating duplicates
- Uses specific relationship types (not just RELATED_TO)
- `--memory-only` skips transcripts, `--transcripts-only` skips memory files
- `--dry-run` shows what would change without writing
- Stops after `max_transcripts_per_run` transcripts — run again for more

---

## /graph-dream

**Purpose:** Manually trigger the dream process.

**Location:** `~/.claude/skills/graph-dream/SKILL.md`

**Usage:**
```
/graph-dream
/graph-dream --dry-run
/graph-dream --ingest-only
```

**Behavior:**
- Runs the dream pipeline on demand
- `--dry-run` shows what would change without writing
- `--ingest-only` only processes the ingest queue, skips transcripts

```yaml
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

Steps:
1. Check for lock file at ~/.claude/graph-memory/processed/dream.lock
   - If it exists and was created less than 2 hours ago, report "Dream process already running" and exit
   - Otherwise, create the lock file with: {"pid": 0, "timestamp": "<now>", "source": "manual-graph-dream"}
2. Read ~/.claude/graph-memory/processed/manifest.json to find unprocessed transcripts
3. Check ~/.claude/graph-memory/ingest/pending/ for new documents
4. If nothing pending, report "No pending work", delete the lock file, and exit

5. For each unprocessed transcript (JSONL files):
   a. Read the file (chunk if large — ~500 lines per chunk)
   b. Extract entities, relationships, reinforcements, corrections, contradictions
   c. Check existing entities via graph_entities before creating new ones
   d. Call graph_relate for new entities/relationships
   e. Call graph_boost for reinforcements
   f. Call graph_weaken for corrections
   g. Use cwd field for project-context boosting
   h. **Update manifest.json immediately** after finishing this transcript (don't batch)

6. For each pending ingest document:
   a. Read the file and any .meta.json sidecar
   b. Extract entities and relationships
   c. Update graph via MCP tools

7. Call graph_decay to apply time-based maintenance

8. Write changelog to ~/.claude/graph-memory/logs/YYYY-MM-DD.md

9. Move ingest files to completed/

10. Delete the lock file at ~/.claude/graph-memory/processed/dream.lock

11. Report summary: transcripts processed, entities created/updated, edges, contradictions

If --dry-run, describe what you would extract and update but do NOT call any graph write tools. Still skip the lock.
If --ingest-only, skip step 5 entirely.

IMPORTANT: Never merge entities unless highly confident they are the same. Flag suspected duplicates in the changelog instead.
IMPORTANT: Always delete the lock file when done, even if you encountered errors.
IMPORTANT: NEVER extract API keys, passwords, tokens, secrets, or credentials into graph entities. Note that a credential exists but NEVER include the actual value.
```

## /graph-capture

**Purpose:** End-of-session capture for conversations the dream can't see.

**Location:** `~/.claude/skills/graph-capture/SKILL.md`

**Usage:**
```
/graph-capture
/graph-capture --dry-run
/graph-capture --topic <focus>
/graph-capture --since-message <uuid>
```

**Behavior:**
- Reviews the current conversation and writes any new entities, edges, decisions, or facts that weren't already captured in flight via inline tool calls
- Necessary for **claude.ai web** and **Claude Desktop chats** — those conversations live server-side or in Electron app data, so the nightly dream's transcript walker can't see them. The dream extracts only Claude Code sessions (`~/.claude/projects/*/*.jsonl`)
- For Claude Code conversations, this is still useful as a "commit my recent thinking" command — but the dream will eventually pick up the transcript anyway
- **Search-first, three-way branch.** For each candidate, runs both `graph_search` (semantic) and `graph_entities` (exact) before deciding. Classifies as: (A) Not in graph → create; (B) In graph and conversation aligns/extends → reuse + add new edges, or `graph_boost` if just re-mentioned; (C) In graph but conversation contradicts → **invalidate the old edges first** via supersession pattern (or `graph_weaken` / `graph_delete`), then create the corrected version. Never just write a new contradicting edge alongside a wrong one — that strengthens the wrong fact via `last_confirmed`
- **SUPERSEDES is one-directional.** `(new)-[SUPERSEDES]->(old)`, never the reverse and never both
- Calls `graph_validate` after the batch to catch generic-named entities or near-duplicates
- `--dry-run` describes what would be written without committing — review before bulk writes
- `--topic` focuses capture on entities/relationships related to a specific topic mentioned in the conversation
- `--since-message <uuid>` only considers messages from that point onward — useful for partial captures during long conversations

The canonical skill prompt is committed to the repo at [`prompts/graph-capture.md`](../prompts/graph-capture.md). When deploying, copy it to `~/.claude/skills/graph-capture/SKILL.md`. It goes through: candidate inventory → search-first existing-entity check → 3-way classification → relationship planning → weight assignment → batch write → validation → user-facing summary.

**Why the 3-way branch matters:** an early version of this skill ran on a conversation that contained outdated context about an old infrastructure choice. The user corrected the conversation; the skill then created new entities representing the correction *but also* re-confirmed the now-wrong edges by calling `graph_relate` on them (which bumps `last_confirmed`). Net effect: the graph held both the old wrong fact (freshly strengthened) and the new correct one, with no `invalid_at` resolution. The 3-way branch with explicit invalidation prevents this anti-pattern.

---

## /graph-find

**Purpose:** Find contradictions, stale entities, or entities needing review.

**Location:** `~/.claude/skills/graph-find/SKILL.md`

**Usage:**
```
/graph-find contradictions
/graph-find stale
/graph-find orphans
/graph-find strongest
```

```yaml
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

**orphans** — Call `graph_entities` MCP tool with sort_by: "last_seen", limit: 50. Filter the response for entities where `edge_count == 0` (the field is included in the response — no per-entity lookups needed). Show these disconnected entities.

**strongest** — Call `graph_entities` MCP tool with sort_by: "confidence", limit: 20. Show the highest-confidence entities — the core of the knowledge graph.

If no argument is provided, show a brief menu of what's available and ask what they'd like to find.
```

---

## /graph-boost

**Purpose:** Quick way to reinforce or weaken a relationship from the command line.

**Location:** `~/.claude/skills/graph-boost/SKILL.md`

**Usage:**
```
/graph-boost "Alice" "React" KNOWS_ABOUT
/graph-boost weaken "Project X" "Vue" USES_TECH --reason "switched to React"
```

```yaml
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
```

---

## /graph-ask

**Purpose:** Ask arbitrary natural language questions about the graph, translated to Cypher and executed.

**Location:** `~/.claude/skills/graph-ask/SKILL.md`

**Usage:**
```
/graph-ask Which people work on projects that use React?
/graph-ask What decisions were superseded in the last 3 months?
/graph-ask Show me everything within 3 hops of Anna
/graph-ask How many entities of each type exist?
/graph-ask What's the average edge weight for WORKS_ON relationships?
```

**Behavior:**
- Translates natural language to Cypher using the graph schema
- Executes the query and returns results
- Falls back gracefully if the generated query is invalid

```yaml
---
name: graph-ask
description: Ask any natural language question about the memory graph. You generate Cypher directly and execute it. Use when the user has a complex or ad-hoc question that the standard graph tools don't cover — multi-hop traversals, aggregations, time-based filters, conditional queries.
argument-hint: [natural language question]
---

The user wants to ask a natural language question about the memory graph.
You will generate the Cypher query yourself (no separate LLM call needed) and execute it via the graph_cypher MCP tool.

Arguments: $ARGUMENTS

GRAPH SCHEMA (for Cypher generation):

All entity nodes carry both :Entity and their type label (e.g., :Entity:Person).
All entities have: id (STRING), name (STRING), subtype (STRING), confidence (FLOAT),
times_mentioned (INTEGER), first_seen (DATETIME), last_seen (DATETIME), source_file (STRING).

Node labels (9 types):
- Person: role, relationship_to_user, organization, email
  Subtypes: individual, contact, group
- Project: status, stack, description, directory, start_date
  Subtypes: active, paused, completed, abandoned
- Preference: domain, key, value, times_confirmed
  Subtypes: coding_style, tools, workflow, communication, environment
- Concept: category, user_expertise, description
  Subtypes: technology, methodology, domain, pattern, language, framework
- Decision: what, why, context, reversible (BOOLEAN), status, decided_date
  Subtypes: architectural, process, tooling, design, policy
- Fact: domain, content, source, verified (BOOLEAN)
  Subtypes: infrastructure, process, policy, configuration, credential_note
- Event: description, event_date (DATETIME), duration, outcome, location, status
  Subtypes: meeting, deployment, incident, review, milestone, conversation, discovery
- Object: object_type, description, status, url, version
  Subtypes: repository, server, database, document, config, tool, container, service, file
- Alias: alias_text, target_type, target_id (does NOT have :Entity label)

Relationship types (17 total, all have weight FLOAT and last_confirmed DATETIME):
- WORKS_ON (Person→Project): role, since
- PREFERS (Person→Preference): strength
- KNOWS_ABOUT (Person→Concept): depth
- DEPENDS_ON (Project→Project): dependency_type
- USES_TECH (Project→Concept): role
- DECIDED_FOR (Decision→any): —
- SUPERSEDES (Decision→Decision): reason, superseded_date
- CONTRADICTS (any→any): description, detected_date, resolved (BOOLEAN), resolution
- RELATED_TO (any→any): relationship_type (values: similar_to, part_of, enables, impacts, depends_on, alternative_to, derived_from, implements, extends, configured_by)
- ALIAS_OF (Alias→any): —
- PARTICIPATED_IN (Person→Event): role
- OCCURRED_DURING (Event→Project): —
- PRODUCED (Event→Decision|Object|Fact): —
- TRIGGERED_BY (Event→Event): —
- USES (Project|Person→Object): purpose
- HOSTED_ON (Object→Object): —
- PRODUCED_BY (Object→Project|Event): —

Entity names are stored lowercase. Weights are 0.0-1.0.

Steps:
1. Based on the user's question and the schema above, write a Cypher query
2. Call the `graph_cypher` MCP tool with: cypher (your query), params (if needed)
3. Present the results:
   - Show the Cypher query you wrote (in a code block for transparency)
   - Show results in a readable table or list
   - If empty, suggest broader terms or alternative approaches
4. If the query fails (invalid Cypher):
   - Read the error, fix the Cypher, and retry once
   - If still failing, show the error and ask the user to rephrase

RULES:
- Only use read-only Cypher (MATCH/RETURN/WITH/WHERE/ORDER BY/LIMIT/SKIP/UNWIND)
- Include weight > 0.3 filter unless user asks for weak/all connections
- Use ORDER BY weight DESC unless another ordering makes sense
- LIMIT to 50 unless user requests more
- Always show the Cypher you generated for transparency

If no question is provided, ask the user what they'd like to know.
```

---

## /graph-briefing

**Purpose:** Generate a structured session briefing based on the current project and recent graph activity. More useful than a bare "anything pending?" check — gives Claude (and you) context on what's changed, what's unresolved, and what's relevant right now.

**Location:** `~/.claude/skills/graph-briefing/SKILL.md`

**Usage:**
```
/graph-briefing
/graph-briefing --full
```

```yaml
---
name: graph-briefing
description: Generate a session briefing from the memory graph — recent changes, unresolved contradictions, relevant context for the current project. Use at the start of a session to catch up, or when switching projects.
argument-hint: [--full]
---

Generate a structured session briefing from the memory graph.

Arguments: $ARGUMENTS

Steps:
1. Call `graph_stats` to get overall health and last dream run timestamp
2. Call `graph_query` with project_context (current working directory), context_level: "minimal"
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
```

---

## Summary

| Command | Purpose | MCP Tool(s) Used |
|---------|---------|-----------------|
| `/ingest <file>` | Add document to knowledge graph | `graph_ingest`, `graph_relate` |
| `/graph <entity>` | Query and explore the graph | `graph_query` |
| `/graph-ask <question>` | Natural language → Cypher queries | `graph_cypher` (Claude writes Cypher) |
| `/graph-stats` | Health dashboard | `graph_stats`, `graph_ingest` |
| `/graph-dream` | Manual dream run (inline) | All graph tools (runs as session) |
| `/graph-briefing` | Session briefing with context | `graph_stats`, `graph_query`, `graph_contradictions` |
| `/graph-find <pattern>` | Audit/review graph | `graph_contradictions`, `graph_entities` |
| `/graph-boost` | Adjust edge weights | `graph_boost`, `graph_weaken` |

All skills run in Claude Code sessions (Max plan). No external API calls needed.

All skills are installed globally at `~/.claude/skills/` and available in every session.
