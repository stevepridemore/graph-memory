# Graph Memory System — Architecture

## Design Principle: No API Key Required

All LLM intelligence runs inside Claude Code sessions (covered by Max subscription). The MCP server is a dumb pipe to Neo4j — it executes Cypher, returns results, nothing more. Entity extraction, Cypher generation, and reasoning all happen in Claude Code where your Max plan covers it.

```
LLM work (Max plan)              Graph operations (local, free)
─────────────────────            ──────────────────────────────
Claude Code sessions             MCP Server → Neo4j
  - Entity extraction              - Execute Cypher queries
  - Cypher generation              - Return results
  - Reasoning/synthesis            - No LLM calls
  - Dream process (scheduled)      - No API key needed
```

## System Overview

```
claude.ai web / Claude Desktop (remote)         Claude Code / Claude Desktop (local)
   │  HTTPS → https://your-host.example.com/mcp     │  stdio MCP (docker exec)
   │  OAuth 2.1 bearer token                          │
   ▼                                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│              graph-memory-mcp (Docker, port 3847)               │
│              Node 22 + Express raw HTTP                         │
│                                                                 │
│  User message → Claude reasons → Graph MCP query                │
│                                   │                             │
│                                   ▼                             │
│                            Relevant subgraph                    │
│                                   │                             │
│                                   ▼                             │
│                       Read associated .md files                 │
│                                   │                             │
│                                   ▼                             │
│                      Enriched context for response              │
│                                                                 │
│  Memory write → .md file                                        │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼──────────────────────┐
              ▼               ▼                      ▼
     ┌──────────────┐ ┌──────────────┐  ┌──────────────────────┐
     │  Markdown     │ │  Transcript  │  │  Ingest Drop Folder  │
     │  Memory Files │ │  Store       │  │  (raw docs to        │
     │  (source of   │ │  (JSONL in   │  │   process)           │
     │   truth)      │ │  ~/.claude/) │  │                      │
     └──────────────┘ └──────────────┘  └──────────────────────┘
              │               │                      │
              └───────────────┼──────────────────────┘
                              │
              ┌───────────────────────────────────────┐
              │    Dream Process (Scheduled Task)      │
              │    Runs AS a Claude Code session        │
              │    (Max plan — no API key needed)       │
              │                                        │
              │  1. Read new transcripts + ingest docs │
              │  2. Claude extracts entities/edges     │
              │  3. Calls MCP tools to update graph    │
              │  4. Decay + maintenance via MCP        │
              │  5. Write changelog                    │
              └───────────────────────────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │  graph-memory-   │
                    │  neo4j (Docker)  │
                    │  Neo4j 5.20 +    │
                    │  APOC            │
                    │  bolt://neo4j:   │
                    │  7687 (internal) │
                    └──────────────────┘
```

## Component Breakdown

### 1. Graph Database (Neo4j Community — Docker)

**Why Neo4j Community:**
- Full ACID-compliant graph database with proper concurrent access
- Readers don't block writers — MCP server and dream process connect simultaneously with zero issues
- Full Cypher query language support
- Official TypeScript driver (`neo4j-driver`) — actively maintained, pure JS, no native bindings
- Docker deployment — sits alongside existing Domino container in WSL2
- Mature ecosystem — GraphAcademy courses, Neogma OGM, active community
- Free for personal use (GPLv3)

**Why not Kuzu:** The `kuzu` npm package is deprecated. Native bindings add Windows compilation complexity. No concurrent access support.

**Deployment:**

```yaml
# docker-compose.yml (in ~/Documents/Projects/graph-memory/ — source repo)
# Run with: docker compose -f ~/Documents/Projects/graph-memory/docker-compose.yml up -d
services:
  graph-memory-mcp:
    # Node 22 + Express HTTP on port 3847
    # Connected to by Cloudflare Tunnel (remote) or docker exec (local stdio)

  graph-memory-neo4j:
    image: neo4j:5.20-community
    # + APOC plugin
    ports:
      - "127.0.0.1:7474:7474"   # Browser UI (optional, for debugging)
      - "127.0.0.1:7687:7687"   # Bolt protocol (host-side access; not used by MCP in prod)
    # MCP service connects as bolt://neo4j:7687 over compose internal network
    volumes:
      - neo4j-data:/data
      - neo4j-logs:/logs
    environment:
      - NEO4J_AUTH=neo4j/<password>
    restart: unless-stopped

volumes:
  neo4j-data:
  neo4j-logs:
```

**Resource footprint:** ~512MB RAM (tunable). Graph data is single-digit MB for personal use. The JVM is the real cost.

**Connection (MCP → Neo4j):** `bolt://neo4j:7687` over the compose internal network. The `127.0.0.1:7687` port binding is for local debugging via Neo4j Browser only.

**Connecting to a managed Neo4j instead:** the same code path also works against Neo4j Aura. Set `NEO4J_URI=neo4j+s://<aura-instance>` in `.env`, drop the `neo4j` service from `docker-compose.yml`, and the MCP container will talk to Aura directly. Local Docker is the default because it's faster, free, and keeps everything on one machine.

**Browser UI:** `http://localhost:7474` — built-in query explorer for debugging and visual inspection. This partially addresses the reviewer's concern about no way to inspect the graph without Claude Code.

### 2. MCP Server (graph-memory-mcp)

A local MCP server that executes Cypher queries against Neo4j. **No LLM calls — it's a thin wrapper.**

For remote access (claude.ai web, multi-device), the MCP server is exposed via Cloudflare Tunnel at `https://your-host.example/mcp` and implements OAuth 2.1 (RFC 8414, RFC 9728, RFC 7591, RFC 7009). See [REMOTE.md](REMOTE.md) for full setup details. The OAuth keypair is generated on first startup and persisted at `~/graph-memory/oauth/{private,public}.pem`.

**Exposed tools (~21 total):**

Each tool is annotated with hints so Claude can reason about safety.

| Tool | Purpose | Needs LLM? | Hint |
|------|---------|-----------|------|
| `graph_query` | Traverse from entities, return subgraph | No | readOnly |
| `graph_relate` | Create/strengthen a relationship | No | idempotent |
| `graph_boost` | Reinforce an edge based on confirmation | No | idempotent |
| `graph_weaken` | Reduce edge weight | No | — |
| `graph_entities` | List entities by type or search | No | readOnly |
| `graph_contradictions` | Find conflicting memories | No | readOnly |
| `graph_ingest` | Queue/status for document ingestion | No | idempotent |
| `graph_cypher` | Execute raw Cypher (read-only via `executeRead()`) | No | readOnly |
| `graph_decay` | Apply decay to all stale edges/nodes | No | — |
| `graph_prune` | Preview/remove decayed nodes and edges | No | destructive |
| `graph_unmerge` | Split falsely merged entities | No | destructive |
| `graph_stats` | Graph health metrics | No | readOnly |
| `graph_delete` | Delete an entity and its edges | No | destructive |
| `graph_read_transcript` | Read and normalize a session JSONL transcript | No | readOnly |
| `graph_audit` | Append a structured event to the dream audit log | No | — |
| `graph_export` | Write a timestamped JSONL backup of all nodes+edges | No | — |
| `graph_validate` | Scan for quality issues (names, orphans, duplicates) | No | readOnly |
| `graph_communities` | Cluster entities via BFS through high-weight edges | No | readOnly |
| `graph_build_context` | Bundle graph health + context into one call | No | readOnly |
| `graph_search` | Hybrid semantic + graph traversal retrieval | No | readOnly |
| `graph_reembed` | Regenerate entity embeddings | No | idempotent |

**Key change from previous design:** `graph_cypher` no longer translates natural language to Cypher. It only executes pre-formed Cypher queries (enforced read-only via Neo4j's `executeRead()` transaction mode). **Claude in the session generates the Cypher itself** — it knows the schema (injected via skill instructions) and can write Cypher directly. No Haiku call needed.

**Registration (local stdio):** Added to `~/.claude/settings.json` under `mcpServers` for Claude Code / Claude Desktop running on the same machine:

```jsonc
{
  "mcpServers": {
    "graph-memory": {
      "command": "docker",
      "args": ["exec", "-i", "graph-memory-mcp", "node", "dist/mcp-server/index.js"]
    }
  }
}
```

### 3. Dream Process (Scheduled Task — IS a Claude Code Session)

**This is the key architectural decision.** The dream process is NOT a standalone script that calls the Claude API. It IS a Claude Code scheduled task — meaning it runs as a full Claude Code session with access to your Max plan.

**What this means:**
- Claude itself reads the transcripts and extracts entities (no API key needed)
- Claude calls the MCP tools to write to the graph (same tools available as in any session)
- Claude writes the changelog
- All covered by your Max subscription

**Trigger conditions (lazy evaluation):**
- Nightly scheduled task checks for new transcripts/ingest docs
- SessionStart hook does a fast filesystem check (no LLM, just file existence)
- If nothing new, the scheduled task prompt can detect this and exit early

**Processing flow:**
```
Scheduled task fires (Claude Code session)
  → Claude reads manifest.json to find unprocessed transcripts
  → Claude reads each JSONL transcript from ~/.claude/projects/
  → Claude extracts entities and relationships (its own reasoning, Max plan)
  → Claude calls graph_relate, graph_boost, etc. via MCP tools
  → Claude calls graph_decay via MCP tool
  → Claude writes changelog to ~/.claude/graph-memory/logs/
  → Claude updates manifest.json
```

### 4. Transcript Store (Already Exists)

Claude Code stores full conversation history locally:

| Location | Format | Content |
|----------|--------|---------|
| `~/.claude/history.jsonl` | JSONL | All user inputs with timestamps and session IDs |
| `~/.claude/projects/<project>/<session-id>.jsonl` | JSONL | Full conversation transcripts |
| `~/.claude/sessions/` | JSON | Session metadata (PID, cwd, start time) |

Each JSONL line includes: `type`, `message`, `timestamp`, `sessionId`, `cwd`, `model`.
The `cwd` field provides project context for affinity scoring.

### 5. Hooks Layer

```jsonc
// ~/.claude/settings.json (hooks section)
{
  "hooks": {
    // On session start: fast filesystem check for pending work
    // NO LLM call — just checks file timestamps
    "SessionStart": [
      {
        "command": "node <absolute-path-to-clone>/dist/hooks/check-pending.js",
        "timeout": 3000
      }
    ]
  }
}
```

**Note:** The reviewer flagged that `PostToolUse` hooks fire on ALL Write operations, not just memory files. We've removed that hook. The dream process handles all graph updates in batch — no real-time file indexing needed.

### 6. Scheduled Tasks

Scheduled tasks are stored at `~/.claude/scheduled-tasks/<task-name>/SKILL.md` and configured via Claude Desktop's Schedule UI (or by asking Claude). The prompt content drives what the session does — see [DREAM_PROCESS.md](DREAM_PROCESS.md) for the full nightly and weekly prompts.

Example tasks:
- **graph-dream-nightly** — processes new transcripts and ingest docs, runs decay, writes changelog. Runs nightly.
- **graph-dream-weekly** — deep health analysis: stats, contradictions, stale nodes, weekly summary.

## Retrieval Trigger: How Claude Knows to Use the Graph

The graph is useless if Claude never queries it. Three mechanisms ensure automatic retrieval:

### 1. Project-Level CLAUDE.md Instruction

A `CLAUDE.md` file in the graph-memory source repo (and optionally in `~/.claude/CLAUDE.md` for global reach) instructs Claude to consult the graph during normal conversations:

```markdown
# Graph Memory

You have access to a graph-based memory system via the `graph-memory` MCP server.

## When to consult the graph

- When the user asks about a **person**, **project**, **past decision**, or **preference** — call `graph_query` before answering from general knowledge
- When the user references something from a **previous conversation** — the graph likely has context
- When you're about to **write a memory file** — check `graph_entities` first to see if related knowledge already exists
- When the user starts a new session — consider offering `/graph-briefing` if the project has graph data

## How to use it

- `graph_query` for structured lookups (entities, relationships, weights)
- `graph_cypher` when you need a custom query (you know the schema — see /graph-ask skill)
- `graph_boost` when the user confirms something you recalled from the graph
- `graph_weaken` when the user corrects something the graph got wrong

## What NOT to do

- Don't query the graph for every message — only when the topic involves recallable knowledge
- Don't mention weights or graph internals to the user unless they ask
- Don't create entities during conversation — that's the dream process's job
```

### 2. MCP Tool Descriptions

Each MCP tool's `description` field is written to help Claude decide when to call it. For example, `graph_query`'s description says: *"Query the memory graph for entities related to a topic. Use this when the user asks about people, projects, decisions, or past context."* Claude's tool-use reasoning picks up on these cues.

### 3. Session Briefing Prompt

The `/graph-briefing` skill (and the SessionStart hook reminder) nudge Claude to load graph context at the start of sessions. This front-loads relevant knowledge so Claude doesn't need to query mid-conversation as often.

## Data Flow Patterns

### Pattern 1: Conversation Retrieval (Real-time, Max plan)
```
User: "How's the auth module going?"
  → Claude extracts entities: ["auth module"]
  → Calls graph_query(["auth module"], hops=2)
  → Graph returns: auth module → Project X (0.9),
                   auth module → OAuth2 (0.7),
                   Project X → You (1.0),
                   Project X → React (0.8)
  → Associated files: project_x.md, auth_decisions.md
  → Claude reads those files for full context
  → Response includes relevant history and context
```

### Pattern 2: Dream Processing (Scheduled task, Max plan)
```
Nightly task fires (Claude Code session)
  → Claude reads manifest, finds 3 unprocessed transcripts
  → For each: reads JSONL, extracts entities and relationships
  → Calls MCP tools to update graph:
     - 5 new entities created via graph_relate
     - 12 edges strengthened via graph_boost
     - 2 new edges created via graph_relate
     - 1 contradiction flagged
  → Calls graph_decay for maintenance
  → Writes changelog to ~/.claude/graph-memory/logs/2026-04-06.md
  → Updates manifest.json
```

### Pattern 3: Natural Language Graph Query (Max plan, no API)
```
User: /graph-ask Which people work on projects that use React?
  → Claude reads the graph schema (embedded in skill instructions)
  → Claude generates Cypher:
     MATCH (p:Person)-[w:WORKS_ON]->(proj:Project)-[u:USES_TECH]->(c:Concept {name: 'react'})
     WHERE w.weight > 0.3 AND u.weight > 0.3
     RETURN p.name, proj.name, w.weight ORDER BY w.weight DESC
  → Calls graph_cypher(cypher=<above>) via MCP
  → Formats and presents results
```

### Pattern 4: Weight Update (During Conversation, Max plan)
```
Claude: "You mentioned preferring tabs for indentation"
User: "Yeah, always tabs"
  → Claude calls graph_boost("user", "tabs", "PREFERS", reason="explicit confirmation")
  → Edge weight: 0.7 → 0.85
```

### Pattern 5: Session Briefing (/graph-briefing)
```
User starts a new session in the graph-memory project
  → User runs /graph-briefing (or Claude proactively offers)
  → Claude calls graph_stats (overall health)
  → Claude calls graph_query(project_context="graph-memory", context_level="minimal")
  → Claude calls graph_contradictions (unresolved conflicts)
  → Presents structured briefing:
     - Last dream run: 10 hours ago, processed 3 transcripts
     - 2 new entities since last session
     - 1 unresolved contradiction flagged
     - Top entities for current project: Neo4j, MCP server, dream process
     - No pending ingest documents
```

### Pattern 6: Batch Dream Update (graph_relate batch mode)
```
Dream process extracts 8 entities and 15 relationships from a transcript
  → Instead of 23 individual tool calls, makes 1 batch call:
     graph_relate({
       batch: {
         entities: [8 entities with localIds],
         relations: [15 relationships referencing localIds],
         source_session: "abc-123",
         source_transcript: "path/to/abc-123.jsonl",
         source_type: "conversation"
       }
     })
  → All created atomically in one Neo4j transaction
  → Provenance and valid_at set on every edge
```

## Directory Structure

```
~/.claude/graph-memory/
├── ingest/                # Drop folder for documents to ingest
│   ├── pending/           # Drop files here — dream process picks them up
│   └── completed/         # Processed files moved here with metadata
├── logs/                  # Dream process changelogs
│   ├── 2026-04-06.md
│   ├── weekly/
│   └── ...
├── processed/             # Tracking file for processed transcripts
│   └── manifest.json
├── schema/                # Schema definition files (for backup/migration)
│   ├── v1.cypher          # Initial schema
│   └── migrations/        # Schema migration scripts
└── config.json            # Graph memory configuration (decay rates, weights, etc.)

~/.claude/projects/        # EXISTING — conversation transcripts (JSONL)
  ├── <project-path>/
  │   ├── <session-id>.jsonl   # Full conversation transcript
  │   └── memory/              # Markdown memory files

<repo-root>/                         # Source code repository (clone of this project)
├── docker-compose.yml     # Neo4j + MCP container definitions
├── docs/
│   ├── ARCHITECTURE.md    # This file
│   ├── SCHEMA.md
│   ├── MCP_SERVER.md
│   ├── DREAM_PROCESS.md
│   ├── REMOTE.md          # Cloudflare Tunnel + OAuth setup
│   ├── MULTI_TENANT.md
│   └── SKILLS.md
├── CLAUDE.md              # Retrieval trigger instructions (also install globally)
├── src/
│   ├── mcp-server/        # MCP server source (thin Neo4j wrapper)
│   ├── hooks/             # Hook scripts (filesystem checks only)
│   └── shared/            # Shared utilities (Neo4j client, config loader)
├── package.json
└── tsconfig.json
```

## Technology Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Language | TypeScript/Node.js | User's comfort zone, Claude Code ecosystem |
| Graph DB | Neo4j Community (Docker) | Full ACID, concurrent access, mature Cypher, free |
| Neo4j Driver | `neo4j-driver` (npm) | Official, pure JS, TypeScript types, actively maintained |
| MCP Framework | `@modelcontextprotocol/sdk` | Standard MCP server toolkit |
| LLM for everything | Claude Code sessions (Max plan) | No API key needed — extraction, Cypher gen, reasoning |
| Hook scripts | Node.js CLI scripts | Fast startup, filesystem checks only |
| Testing | Vitest | Lightweight, TypeScript-native |
| Container | Docker Desktop (WSL2) | Already installed, runs alongside Domino container |

## Scope: Global, Not Project-Based

This system operates at the **user level**, not per-project:

- **Neo4j container, config, logs, ingest folder** all live under `~/.claude/graph-memory/`
- **MCP server** registered in `~/.claude/settings.json` (user-level)
- **Hooks** registered in user-level settings
- **Scheduled tasks** are session-agnostic

**Project context is captured inside the graph, not by scoping the graph:**
- Conversations carry `cwd` in the JSONL transcripts
- Entities get edges linking them to relevant projects
- Retrieval-time affinity scoring boosts in-project entities
- Cross-project knowledge is preserved

## Path Conventions

**In documentation:** `~/.claude/` is used as shorthand for readability.

**In code, hooks, scheduled task prompts, and MCP registration:** Always use fully qualified absolute paths (e.g. `C:\Users\<you>\.claude\...` on Windows or `/home/<you>/.claude/...` on Linux/macOS). Tilde expansion is not guaranteed across all execution contexts on Windows (hooks run as shell commands, scheduled tasks run as Claude sessions, MCP server runs as a Node.js child process — each may handle `~` differently). The MCP server itself uses `os.homedir()` to resolve at startup; downstream code references the resolved `GRAPH_MEMORY_HOME` constant.

The MCP server resolves paths at startup using `os.homedir()` and exposes a `GRAPH_MEMORY_HOME` constant so all components reference the same resolved path.

## Security Considerations

- Neo4j listens only on localhost (Docker port binding `127.0.0.1:7687`); not exposed externally
- MCP server for local clients uses stdio transport (docker exec); for remote clients uses HTTPS via Cloudflare Tunnel
- Remote access is gated by OAuth 2.1: only `/oauth/authorize` requires Cloudflare Access; all other paths use RS256 bearer tokens issued by the server
- No sensitive data stored in graph (entities and relationships only; full content stays in markdown)
- Dream process reads transcripts from local filesystem only
- OAuth keypair at `~/graph-memory/oauth/` should be kept out of backups shared externally

## Backup & Recovery

- **Neo4j data** lives in a Docker volume (`neo4j-data`). Back up with `docker cp` or volume export.
- **Schema** stored in `~/.claude/graph-memory/schema/` as `.cypher` files for rebuild
- **Markdown files** remain the source of truth. If the graph is corrupted, bootstrap script can rebuild from memory files + transcripts.
- **Config and manifest** are small JSON files — include in any backup
- **Recovery procedure:** Stop container → restore volume → restart. Or: drop database → re-run schema → re-run bootstrap.
