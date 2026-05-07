# Graph Memory

A personal knowledge graph for Claude that survives across sessions, devices, and tools. Built on Neo4j with semantic embeddings, OAuth-secured for use from Claude Code, Claude Desktop, and claude.ai web — all hitting the same graph.

https://github.com/user-attachments/assets/826e5f5a-5759-4b31-83dd-6bd7e0e044b8

*Asked from my phone. Pulls a decision made days ago on my laptop, citing the commit hash.*

> **No external API keys, no LLM provider integration, no per-token costs.** Entity extraction runs inside your Claude sessions (Max plan). Embedding runs locally via [bge-small-en](https://huggingface.co/BAAI/bge-small-en-v1.5). Everything stays on your hardware unless you choose to expose it.

## Why a graph

Built-in memory in Claude Code is "append facts to markdown, grep later." That gets you 80% there but breaks at scale: no relationships, no confidence, no decay, no contradiction detection, no temporal awareness. Two memories that reinforce each other look identical to two memories that contradict each other.

This project replaces flat keyword matching with weighted, relationship-aware retrieval:

- **Weighted edges with configurable decay** — frequently-confirmed knowledge stays strong; stale information fades naturally on per-type half-lives (preferences ~693 days, events ~99 days)
- **Bi-temporal validity** — separate `valid_at` (when fact was true), `invalid_at` (when superseded), `ingested_at` (when learned). Old facts get marked invalid rather than deleted
- **Semantic + structural search** — vector embeddings find conceptually similar entities; graph traversal then expands through real relationships
- **Project-context affinity** — when you're working in a specific project, related entities surface first
- **Contradiction detection** — conflicting facts are flagged, not silently coexisting
- **Full provenance** — every edge traces back to the conversation, transcript, or document that sourced it
- **Dream process** — a scheduled Claude session reviews recent transcripts and ingest documents overnight, extracts new knowledge, applies decay, and writes a changelog

## Architecture

```
                  Claude Code      Claude Desktop      claude.ai web
                       │                  │                  │
                       └────────── OAuth 2.1 Bearer ─────────┘
                                          │
                              https://your-host.example/mcp
                                          │
                                Cloudflare Tunnel
                                          │
                                  docker-compose
                            ┌────────────┴────────────┐
                            ▼                         ▼
                    graph-memory-mcp           graph-memory-neo4j
                    (Node 22 + jose)           (Neo4j 5.20 + APOC)
                    port 3847                  bolt://neo4j:7687
                            │                         │
                            └─── bolt-internal ───────┘
```

Two Docker services, talking over the compose network. The MCP server is the only thing that touches Neo4j directly — it implements OAuth 2.1 itself (RS256 JWTs with dynamic client registration per RFC 7591), validates bearer tokens for `/mcp` calls, and exposes Cloudflare Access only on `/oauth/authorize` for the actual user login. The Neo4j instance has no external listeners.

The dream process is just another Claude session that runs on a schedule, reads transcripts, and calls the same MCP tools any client would call — there's no separate extraction pipeline.

## Schema

**Entity types (canonical):** `Person`, `Project`, `Preference`, `Concept`, `Decision`, `Fact`, `Event`, `Object`, `Reasoning` — plus a few ad-hoc types (Organization, Technology, Artifact, Infrastructure, Feature, Resource) that have emerged organically through use. The schema is permissive on labels.

**Relationship types (canonical, 22):** `WORKS_ON`, `WORKS_AT`, `REPORTS_TO`, `STAKEHOLDER_IN`, `PREFERS`, `KNOWS_ABOUT`, `DEPENDS_ON`, `USES_TECH`, `USES`, `DECIDED_FOR`, `SUPERSEDES`, `CONTRADICTS`, `RELATED_TO`, `ALIAS_OF`, `PARTICIPATED_IN`, `OCCURRED_DURING`, `PRODUCED`, `TRIGGERED_BY`, `HOSTED_ON`, `PRODUCED_BY`, `LED_TO`, `INVOLVED_IN`. The catch-all `RELATED_TO` carries a `relationship_type` subtype property (`similar_to`, `part_of`, `enables`, `impacts`, etc.) for cases where the typed relationships don't fit.

Every node and edge carries:
- `weight` (0.0–1.0) — decays over time on per-type half-lives
- `confidence` — separate from weight, tracks the source's certainty
- `tenant_id` — multi-tenant isolation (single-user by default; multi-user-ready via OAuth email claim)
- `embedding` (nodes) — 384-dim vector for semantic search
- `valid_at` / `invalid_at` / `ingested_at` (edges) — bi-temporal tracking

Full schema in [`docs/SCHEMA.md`](docs/SCHEMA.md).

## Tools

The MCP server exposes about 20 tools across these categories:

| Category | Tools |
|---|---|
| Query | `graph_query`, `graph_search` (semantic), `graph_entities`, `graph_communities`, `graph_build_context` |
| Write | `graph_relate` (single + batch), `graph_boost`, `graph_weaken`, `graph_delete`, `graph_unmerge` |
| Maintenance | `graph_decay`, `graph_prune`, `graph_validate`, `graph_reembed` |
| Operational | `graph_stats`, `graph_export`, `graph_audit`, `graph_ingest`, `graph_read_transcript`, `graph_cypher` (admin only) |

Slash-command wrappers (`/graph`, `/graph-ask`, `/graph-search`, `/graph-stats`, `/graph-dream`, `/graph-briefing`, `/graph-find`, `/graph-backup`, `/graph-capture`, `/ingest`, etc.) install into `~/.claude/skills/`. Full reference: [`docs/SKILLS.md`](docs/SKILLS.md).

`/graph-capture` is the manual companion to the nightly dream: the dream extracts knowledge from Claude Code transcripts in `~/.claude/projects/`, but cannot see claude.ai web conversations or Claude Desktop chats (those live server-side or in Electron app data). Run `/graph-capture` at the end of a substantive claude.ai or Desktop conversation to commit any new entities, decisions, or facts to the graph.

## Prerequisites

**Required:**
- **Node.js 22+** and npm
- **Docker** (Desktop on Windows/macOS, or Docker Engine on Linux) with Docker Compose v2
- **Claude Code** and/or **Claude Desktop** with a **Max** subscription — the dream process runs as a scheduled Claude session, so you need a plan that covers extended sessions without per-token billing
- A few hundred MB of disk for Neo4j + embeddings model

**Optional:**
- **[MarkItDown](https://github.com/microsoft/markitdown)** (`pip install "markitdown[pdf,docx,xlsx,pptx]"`) — enables ingesting binary documents (`.pdf`, `.docx`, `.xlsx`, `.pptx`, `.epub`, `.msg`, `.csv`, `.xml`, `.png`, `.jpg`). Without it, ingest is limited to `.md`, `.txt`, `.json`, `.html`, `.srt`, `.vtt`.
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** — convenient way to grab YouTube/web video subtitle files for ingestion. `yt-dlp --write-auto-sub --sub-lang en --skip-download <url>` writes a `.vtt` you can drop into `ingest/pending/`. Not a runtime dependency; just a tool that produces files graph-memory can already eat.
- **[cloudflared](https://github.com/cloudflare/cloudflared)** + a Cloudflare account — only needed for the multi-device / claude.ai web setup described in [`docs/REMOTE.md`](docs/REMOTE.md). Local-only deployments don't need it.
- **Python 3.10+** — required only by MarkItDown and by `scripts/sync-dream-skill.py`.

## Quick start (single-machine, local only)

For just running the graph on your laptop with stdio access from Claude Code:

```bash
git clone <this-repo>
cd graph-memory
cp .env.example .env
# Edit .env — set NEO4J_PASSWORD to anything ≥8 chars,
# GRAPH_MEMORY_HOME to your data root (e.g. C:\Users\you\graph-memory or ~/graph-memory),
# and CLAUDE_PROJECTS_DIR to your Claude transcripts folder
# (e.g. C:\Users\you\.claude\projects or ~/.claude/projects)
npm install
npm run build
docker compose up -d
```

Then add to `.mcp.json` (project-local) or `~/.claude/.mcp.json` (global). A ready-to-copy template is included at [`.mcp.json.example`](.mcp.json.example):

```json
{
  "mcpServers": {
    "graph-memory": {
      "command": "docker",
      "args": ["exec", "-i", "-e", "MCP_TRANSPORT=stdio",
               "graph-memory-mcp", "node", "/app/dist/mcp-server/index.js"]
    }
  }
}
```

Verify with `/graph-stats` in any Claude Code conversation.

## Multi-device / claude.ai web access

To use the same graph from claude.ai web, your office laptop, your phone, etc., expose the MCP server through Cloudflare Tunnel + Access. The auth flow is OAuth 2.1 with Cloudflare's IdP doing the actual user login.

Step-by-step in [`docs/REMOTE.md`](docs/REMOTE.md). The setup is one-time:

1. Cloudflare Tunnel with `cloudflared` pointing at `https://localhost:3847`
2. A single Cloudflare Access application scoped to `/oauth/authorize` (everything else is public + bearer-token-protected)
3. Server generates an RSA keypair on first run, persists it, exposes via `/oauth/jwks`
4. Claude clients hit `https://your-host.example/mcp`, get a 401 with proper `WWW-Authenticate: Bearer ... resource_metadata="..."`, walk the OAuth flow, store the bearer token, and call subsequent requests with it

This makes the graph reachable from any device or AI tool that speaks MCP + OAuth 2.1.

For Claude Code on remote machines, [`.mcp.json.remote.example`](.mcp.json.remote.example) is the matching client template — copy it to `~/.claude/.mcp.json` (or a project-local `.mcp.json`) and replace `your-host.example` with your tunnel hostname:

```json
{
  "mcpServers": {
    "graph-memory": {
      "type": "http",
      "url": "https://your-host.example/mcp"
    }
  }
}
```

Claude Code walks the OAuth flow on first call and caches the bearer token. claude.ai web uses its own custom-connector UI — the URL is the same.

## Document ingestion

Drop files into `~/graph-memory/ingest/pending/` (or call `graph_ingest` directly). The next dream run extracts entities and relationships into the graph. Native support for `.md`, `.txt`, `.json`, `.html`, `.srt`, `.vtt`. With [MarkItDown](https://github.com/microsoft/markitdown) installed (`pip install "markitdown[pdf,docx,xlsx,pptx]"`), also handles `.pdf`, `.docx`, `.xlsx`, `.pptx`, `.epub`, `.msg`, `.csv`, `.xml`, `.png`, `.jpg`, etc. — converted to Markdown first, then extracted. Original files archive to `ingest/originals/<date>/`.

## Privacy

The graph stores personal information — names of colleagues, decisions, preferences, project details. Treat the database with the same care as a private journal:

- Default deployment is local-only (Docker on `localhost`); nothing leaves your machine
- The optional Cloudflare Tunnel exposure adds OAuth + Cloudflare Access in front
- All data lives under a directory you control (default `~/graph-memory/`)
- A `graph_export` tool produces portable JSONL backups; `~/graph-memory/backups/` is auto-rotated
- Embedding model runs locally — no text leaves the machine for vector search
- Entity extraction runs in your Claude sessions; same trust boundary as Claude itself
- API keys, passwords, and secrets are explicitly excluded from extraction (see `prompts/dream-nightly.md`)

## Tech stack

| Component | Technology |
|---|---|
| Language | TypeScript / Node.js 22 |
| Graph DB | Neo4j Community 5.20 (Docker) with APOC |
| Embedding model | `@huggingface/transformers` running bge-small-en-v1.5 (384-dim, ONNX) |
| Driver | `neo4j-driver` |
| MCP framework | `@modelcontextprotocol/sdk` |
| Auth | `jose` for JWT signing/verification (RS256) |
| Tunnel (optional) | Cloudflare Tunnel (`cloudflared`) + Cloudflare Access |
| Testing | Vitest |

## Status

All planned phases shipped:

- ✅ Phase 0–3: MCP server, dream process, SessionStart hook, slash commands
- ✅ Phase 4: Bootstrap complete (graph populated from transcripts and memory files)
- ✅ Phase 5: bi-temporal modeling, Reasoning entity type, semantic/vector search, community detection, build_context meta-tool
- ✅ Multi-tenant infrastructure (single-user by design, multi-user-ready)
- ✅ OAuth 2.1 + Cloudflare Tunnel for multi-device access
- ✅ Aura → local Neo4j migration with full data preservation

Currently steady-state. Active development is opportunistic; the system runs unattended via the nightly dream process.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system design, data flows, component responsibilities
- [`docs/SCHEMA.md`](docs/SCHEMA.md) — node types, relationship types, decay functions, weight semantics
- [`docs/MCP_SERVER.md`](docs/MCP_SERVER.md) — every MCP tool with input/output schemas
- [`docs/DREAM_PROCESS.md`](docs/DREAM_PROCESS.md) — extraction pipeline, manifest format, changelog structure
- [`docs/SKILLS.md`](docs/SKILLS.md) — slash command definitions
- [`docs/REMOTE.md`](docs/REMOTE.md) — exposing graph-memory via Cloudflare Tunnel + Access
- [`docs/MULTI_TENANT.md`](docs/MULTI_TENANT.md) — tenant isolation model
- [`CLAUDE.md`](CLAUDE.md) — retrieval and chat-write guidelines for Claude

## License

MIT — see [`LICENSE`](LICENSE).
