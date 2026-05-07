import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { Neo4jClient } from "../shared/neo4j-client.js";
import { GRAPH_MEMORY_HOME } from "../shared/config.js";
import { ENTITY_TYPES, RELATIONSHIP_TYPES } from "../shared/types.js";
import type { EntityType, RelationshipType } from "../shared/types.js";
import { parseTranscriptFile, getTextMessages } from "../shared/transcript-parser.js";
import { appendAuditEvent } from "../shared/dream-audit.js";
import type { DreamAuditEvent } from "../shared/dream-audit.js";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync, appendFileSync, unlinkSync, openSync, readSync, closeSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  resolveTenantFromRequest,
  getStaticTenantId,
  isAdminTenant,
  TenantAuthError,
  verifyCfAccessJwt,
  type VerifiedAccessIdentity,
} from "../shared/auth.js";
import {
  registerClient,
  getClient,
  issueAuthCode,
  consumeAuthCode,
  issueAccessToken,
  issueRefreshToken,
  verifyRefreshToken,
  verifyPkce,
  authorizationServerMetadata,
  protectedResourceMetadata,
  getJwksJson,
  getIssuer,
} from "../shared/oauth.js";

// ─── Tenant request context ──────────────────────────────────────────────────
// Threaded into every tool handler via AsyncLocalStorage. The HTTP request
// handler resolves tenant from headers and runs the handler chain inside this
// store; tool handlers read the current tenant by calling currentTenant().
// For stdio transport (local Claude Desktop / Code), the store is empty and
// currentTenant() falls back to LOCAL_TENANT_ID / BOOTSTRAP_TENANT_ID.

interface TenantContext {
  tenantId: string;
  identity?: VerifiedAccessIdentity;
}
const tenantContext = new AsyncLocalStorage<TenantContext>();

function currentTenant(): string {
  const ctx = tenantContext.getStore();
  return ctx?.tenantId ?? getStaticTenantId();
}
function currentIdentity(): VerifiedAccessIdentity | undefined {
  return tenantContext.getStore()?.identity;
}

// ─── Helpers ───

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// ─── Debug file logger ───

function debugLog(msg: string): void {
  try {
    const logPath = join(GRAPH_MEMORY_HOME, "logs", "startup-debug.log");
    mkdirSync(join(GRAPH_MEMORY_HOME, "logs"), { recursive: true });
    appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* ignore */ }
  process.stderr.write(`[graph-memory] ${msg}\n`);
}

// ─── Per-request access log ───
// One JSONL line per inbound HTTP MCP request. Useful for debugging cross-
// tenant leak suspicions and for usage tracking. Best-effort (never throws).
interface AccessLogEvent {
  timestamp: string;
  tenant_id: string;
  method: string;
  path: string;
  identity_source: "cf-access" | "static";
}
function appendMcpAccessLog(event: AccessLogEvent): void {
  try {
    const logPath = join(GRAPH_MEMORY_HOME, "logs", "mcp-access.jsonl");
    mkdirSync(join(GRAPH_MEMORY_HOME, "logs"), { recursive: true });
    appendFileSync(logPath, JSON.stringify(event) + "\n");
  } catch { /* never throw from logging */ }
}

// ─── Initialize ───

const MCP_TRANSPORT_EARLY = process.env.MCP_TRANSPORT ?? "stdio";
debugLog(`startup transport=${MCP_TRANSPORT_EARLY} pid=${process.pid}`);
debugLog(`NEO4J_URI set=${!!process.env.NEO4J_URI} PASSWORD set=${!!process.env.NEO4J_PASSWORD} USER set=${!!process.env.NEO4J_USER}`);
debugLog(`GRAPH_MEMORY_HOME=${GRAPH_MEMORY_HOME}`);

const client = new Neo4jClient();
const server = new McpServer({
  name: "graph-memory",
  version: "0.1.0",
});

// Initialize schema on startup
try {
  debugLog("calling verifyConnectivity...");
  await client.verifyConnectivity();
  debugLog("verifyConnectivity OK, calling initializeSchema...");
  await client.initializeSchema();
  debugLog("Connected to Neo4j and schema initialized");
  console.error("[graph-memory] Connected to Neo4j and schema initialized");

  // Backfill embeddings asynchronously — don't block startup. First run on a
  // populated graph may take several seconds; subsequent runs are no-ops since
  // the WHERE filter skips entities that already have embeddings.
  void (async () => {
    try {
      debugLog("starting embedding backfill (async)...");
      const result = await client.backfillEmbeddings();
      debugLog(`embedding backfill complete: ${JSON.stringify(result)}`);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      debugLog(`embedding backfill FAILED: ${e.message}`);
    }
  })();
} catch (err) {
  const e = err instanceof Error ? err : new Error(String(err));
  debugLog(`STARTUP CONNECT FAILED: ${e.constructor.name}: ${e.message}`);
  debugLog(`code=${(e as NodeJS.ErrnoException).code ?? 'none'}`);
  debugLog(`stack=${e.stack ?? 'no stack'}`);
  console.error("[graph-memory] Failed to connect to Neo4j:", err);
  console.error("[graph-memory] Is the Docker container running?");
}

// ─── Helper ───

function toolResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function toolError(message: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

// ─── Tool: graph_query ───

server.registerTool("graph_query", {
  title: "Graph Query",
  description:
    "Query the memory graph by canonical entity name. Use when you know the entity name or close-to-canonical form (e.g. \"Steve\", \"graph-memory\"); for natural-language phrasing or synonyms (e.g. \"the knowledge graph project\") prefer graph_search. Returns up to `limit` matching nodes plus the edges that connect them within `max_hops`, with per-edge weight and source provenance.",
  inputSchema: {
    entities: z.array(z.string()).describe("Entity names to search for"),
    entity_types: z.array(z.string()).optional().describe("Filter results to these entity types"),
    max_hops: z.number().optional().default(2).describe("Max traversal depth (default: 2)"),
    min_weight: z.number().optional().default(0.3).describe("Min edge weight to traverse (default: 0.3)"),
    limit: z.number().optional().default(20).describe("Max results (default: 20)"),
    project_context: z.string().optional().describe("Project directory or name for affinity scoring"),
    context_level: z.enum(["minimal", "full", "relations-only"]).optional().default("full").describe("Response detail level (default: full)"),
    current_only: z.boolean().optional().default(true).describe("Only current facts, exclude superseded (default: true)"),
  },
  annotations: { readOnlyHint: true },
}, async (args) => {
  try {
    const result = await client.query(currentTenant(), args.entities, {
      entity_types: args.entity_types as EntityType[] | undefined,
      max_hops: args.max_hops,
      min_weight: args.min_weight,
      limit: args.limit,
      project_context: args.project_context,
      current_only: args.current_only,
    });

    if (args.context_level === "minimal") {
      return toolResult({
        nodes: result.nodes.map((n) => ({
          id: n.id, type: n.type, name: n.name, confidence: n.confidence,
        })),
        edge_count: result.edges.length,
      });
    }

    if (args.context_level === "relations-only") {
      return toolResult({
        nodes: result.nodes.map((n) => ({
          id: n.id, type: n.type, name: n.name,
        })),
        edges: result.edges,
      });
    }

    return toolResult(result);
  } catch (err) {
    return toolError(`graph_query failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// ─── Tool: graph_relate ───

server.registerTool("graph_relate", {
  title: "Graph Relate",
  description:
    "Create or strengthen a relationship between entities. Creates the endpoint entities if they don't exist. Use single mode (from_name/to_name/relation) for one fact at a time. Use batch mode when extracting from a transcript or document — it's atomic, so a partial failure won't leave dangling nodes. Idempotent: re-asserting an existing edge boosts its weight rather than duplicating.",
  inputSchema: {
    // Single mode
    from_name: z.string().optional().describe("Source entity name (single mode)"),
    from_type: z.string().optional().describe("Source entity type (single mode)"),
    to_name: z.string().optional().describe("Target entity name (single mode)"),
    to_type: z.string().optional().describe("Target entity type (single mode)"),
    relation: z.string().optional().describe("Relationship type (single mode)"),
    weight: z.number().optional().describe("Edge weight 0.0-1.0"),
    properties: z.record(z.string(), z.unknown()).optional().describe("Additional properties"),
    evidence: z.string().optional().describe("Why this relationship exists"),
    valid_at: z.string().optional().describe("When this fact became true"),
    source_session: z.string().optional().describe("Session ID for provenance"),
    source_transcript: z.string().optional().describe("Transcript path for provenance"),
    source_type: z.string().optional().describe("Source type: conversation, ingest, manual, bootstrap"),
    // Batch mode
    batch: z.object({
      entities: z.array(z.object({
        localId: z.string(),
        name: z.string(),
        type: z.string(),
        properties: z.record(z.string(), z.unknown()).optional(),
      }).strict()),
      relations: z.array(z.object({
        from: z.string(),
        to: z.string(),
        relation: z.string(),
        weight: z.number(),
        properties: z.record(z.string(), z.unknown()).optional(),
        evidence: z.string().optional(),
        valid_at: z.string().optional(),
      }).strict()),
      source_session: z.string().optional(),
      source_transcript: z.string().optional(),
      source_type: z.string().optional(),
    }).optional().describe("Batch mode: create multiple entities and relationships atomically"),
  },
  annotations: { idempotentHint: true },
}, async (args) => {
  try {
    const tenantId = currentTenant();
    // Batch mode
    if (args.batch) {
      const result = await client.batchRelate(tenantId, {
        entities: args.batch.entities.map((e) => ({
          ...e,
          type: e.type as EntityType,
        })),
        relations: args.batch.relations.map((r) => ({
          ...r,
          relation: r.relation as RelationshipType,
        })),
        source_session: args.batch.source_session,
        source_transcript: args.batch.source_transcript,
        source_type: args.batch.source_type,
      });
      return toolResult(result);
    }

    // Single mode
    if (!args.from_name || !args.from_type || !args.to_name || !args.to_type || !args.relation) {
      return toolError("Single mode requires from_name, from_type, to_name, to_type, and relation");
    }

    // Prefer existing entity ID by name lookup over slug generation — prevents duplicate nodes
    const fromId = (await client.findEntityIdByName(tenantId, args.from_name)) ?? slugify(args.from_name);
    const toId = (await client.findEntityIdByName(tenantId, args.to_name)) ?? slugify(args.to_name);

    // Ensure entities exist (within tenant)
    await client.createEntity(tenantId, args.from_type as EntityType, fromId, args.from_name, {}, args.weight ?? 0.5);
    await client.createEntity(tenantId, args.to_type as EntityType, toId, args.to_name, {}, args.weight ?? 0.5);

    const edge = await client.createRelationship(
      tenantId,
      fromId,
      toId,
      args.relation as RelationshipType,
      args.weight ?? 0.5,
      args.properties ?? {},
      {
        source_session: args.source_session,
        source_transcript: args.source_transcript,
        source_type: args.source_type,
        source_tenant: tenantId,
      },
      args.valid_at,
    );

    return toolResult({
      action: "created",
      edge: { from: edge.from, to: edge.to, type: edge.type, weight: edge.weight },
    });
  } catch (err) {
    return toolError(`graph_relate failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// ─── Tool: graph_delete ───

server.registerTool("graph_delete", {
  title: "Graph Delete",
  description:
    "Permanently delete an entity node and all its edges by ID. Use for removing duplicate or erroneous nodes. Cannot be undone.",
  inputSchema: {
    id: z.string().describe("Entity ID to delete"),
  },
  annotations: { destructiveHint: true },
}, async (args) => {
  try {
    const deleted = await client.deleteEntity(currentTenant(), args.id);
    if (!deleted) {
      return toolError(`No entity found with id: ${args.id}`);
    }
    return toolResult({ action: "deleted", id: args.id });
  } catch (err) {
    return toolError(`graph_delete failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// ─── Tool: graph_boost ───

server.registerTool("graph_boost", {
  title: "Graph Boost",
  description:
    "Increase an edge's weight when the user confirms recalled information. Call this when the user says 'yes', 'exactly', or confirms something you retrieved from the graph. Persists immediately; weight clamps at 1.0 so repeated boosts saturate rather than overflow. Returns the previous and new weight.",
  inputSchema: {
    from_name: z.string().describe("Source entity name or ID"),
    to_name: z.string().describe("Target entity name or ID"),
    relation: z.string().describe("Relationship type (e.g. WORKS_ON, PREFERS)"),
    amount: z.number().optional().default(0.15).describe("Boost amount (default: 0.15)"),
    reason: z.string().optional().describe("Why boosting"),
  },
  annotations: { idempotentHint: true },
}, async (args) => {
  try {
    const tenantId = currentTenant();
    const fromId = (await client.findEntityIdByName(tenantId, args.from_name)) ?? slugify(args.from_name);
    const toId = (await client.findEntityIdByName(tenantId, args.to_name)) ?? slugify(args.to_name);
    const result = await client.boost(tenantId, fromId, toId, args.relation as RelationshipType, args.amount);
    return toolResult({
      previous_weight: result.previous_weight,
      new_weight: result.new_weight,
      edge: { from: fromId, to: toId, type: args.relation },
    });
  } catch (err) {
    return toolError(`graph_boost failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// ─── Tool: graph_weaken ───

server.registerTool("graph_weaken", {
  title: "Graph Weaken",
  description:
    "Decrease an edge's weight when the user corrects a recalled fact. Call this when the user says 'no', 'that's wrong', or corrects something from the graph. Persists immediately; weight clamps at 0.0. Returns an error if the edge doesn't exist — use graph_delete to remove an entity outright. To replace a fact rather than weaken it, prefer graph_relate with the new fact and SUPERSEDES.",
  inputSchema: {
    from_name: z.string().describe("Source entity name or ID"),
    to_name: z.string().describe("Target entity name or ID"),
    relation: z.string().describe("Relationship type"),
    amount: z.number().optional().default(0.3).describe("Weaken amount (default: 0.3)"),
    reason: z.string().optional().describe("Why weakening"),
  },
  annotations: { idempotentHint: true },
}, async (args) => {
  try {
    const tenantId = currentTenant();
    const fromId = (await client.findEntityIdByName(tenantId, args.from_name)) ?? slugify(args.from_name);
    const toId = (await client.findEntityIdByName(tenantId, args.to_name)) ?? slugify(args.to_name);
    const result = await client.weaken(tenantId, fromId, toId, args.relation as RelationshipType, args.amount);
    return toolResult({
      previous_weight: result.previous_weight,
      new_weight: result.new_weight,
      edge: { from: fromId, to: toId, type: args.relation },
      pruned: result.new_weight <= 0.05,
    });
  } catch (err) {
    return toolError(`graph_weaken failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// ─── Tool: graph_entities ───

server.registerTool("graph_entities", {
  title: "Graph Entities",
  description:
    "Browse or search the entity catalog. Use to check if an entity exists before creating one with graph_relate, or to list entities of a given type. For relationship-aware lookups (entity + its neighbors) use graph_query instead. Returns up to `limit` entities ordered by `sort_by`; pagination is single-page (raise `limit` if you need more).",
  inputSchema: {
    search: z.string().optional().describe("Full-text search query"),
    type: z.string().optional().describe("Filter by entity type (Person, Project, Concept, etc.)"),
    min_confidence: z.number().optional().describe("Min confidence threshold"),
    sort_by: z.enum(["confidence", "last_seen", "name"]).optional().default("confidence").describe("Sort order (default: confidence)"),
    limit: z.number().optional().default(20).describe("Max results (default: 20)"),
  },
  annotations: { readOnlyHint: true },
}, async (args) => {
  try {
    const result = await client.searchEntities(currentTenant(), {
      search: args.search,
      type: args.type as EntityType | undefined,
      min_confidence: args.min_confidence,
      sort_by: args.sort_by,
      limit: args.limit,
    });
    return toolResult(result);
  } catch (err) {
    return toolError(`graph_entities failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// ─── Tool: graph_contradictions ───

server.registerTool("graph_contradictions", {
  title: "Graph Contradictions",
  description:
    "Find facts that contradict each other in the memory graph — pairs connected by a CONTRADICTS edge. Use during reviews, before a graph_decay run, or when the user asks about conflicting information. Returns `{contradictions: [{node_a, node_b, description, detected_date, resolved}], count}` ordered by most-recently detected. By default only unresolved pairs are surfaced; set include_resolved=true to audit historical resolutions. Resolve a contradiction by graph_weaken on the wrong edge or by graph_relate with relation=SUPERSEDES on the new fact.",
  inputSchema: {
    include_resolved: z.boolean().optional().default(false).describe("Include resolved contradictions (default: false)"),
  },
  annotations: { readOnlyHint: true },
}, async (args) => {
  try {
    const result = await client.findContradictions(currentTenant(), args.include_resolved ?? false);
    return toolResult(result);
  } catch (err) {
    return toolError(`graph_contradictions failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// ─── Tool: graph_ingest ───

server.registerTool("graph_ingest", {
  title: "Graph Ingest",
  description:
    "Queue a document for asynchronous extraction into the memory graph (mode='queue'), or check the ingest backlog (mode='status'). Use this when you have a file the user wants summarized into the graph but doesn't need it reflected in the same conversation — the nightly dream process picks queued documents up. For inline assertions during a conversation, call graph_relate directly instead. Idempotent: queueing the same file twice overwrites the prior copy in the pending dir.",
  inputSchema: {
    action: z.enum(["queue", "status"]).describe("queue: add file to pending. status: check queue."),
    file_path: z.string().optional().describe("Path to file to queue (required for queue action)"),
    meta: z.object({
      source: z.string().optional(),
      author: z.string().optional(),
      date: z.string().optional(),
      topic_hints: z.array(z.string()).optional(),
      weight_override: z.number().optional(),
    }).optional().describe("Optional metadata for the queued document"),
  },
  annotations: { idempotentHint: true },
}, async (args) => {
  try {
    const pendingDir = join(GRAPH_MEMORY_HOME, "ingest", "pending");
    const completedDir = join(GRAPH_MEMORY_HOME, "ingest", "completed");

    if (args.action === "status") {
      let pending: Array<{ file: string; queued_at: string; size: string }> = [];
      let recentlyCompleted: Array<{ file: string; processed_at: string }> = [];

      try {
        const pendingFiles = readdirSync(pendingDir).filter((f) => !f.endsWith(".meta.json"));
        pending = pendingFiles.map((f) => {
          const stat = statSync(join(pendingDir, f));
          return {
            file: f,
            queued_at: stat.mtime.toISOString(),
            size: `${(stat.size / 1024).toFixed(1)} KB`,
          };
        });
      } catch { /* dir doesn't exist yet */ }

      try {
        const completedFiles = readdirSync(completedDir).filter((f) => !f.endsWith(".meta.json"));
        recentlyCompleted = completedFiles.slice(-5).map((f) => {
          const stat = statSync(join(completedDir, f));
          return { file: f, processed_at: stat.mtime.toISOString() };
        });
      } catch { /* dir doesn't exist yet */ }

      return toolResult({
        pending,
        recently_completed: recentlyCompleted,
        pending_count: pending.length,
        completed_count: recentlyCompleted.length,
      });
    }

    // Queue action
    if (!args.file_path) {
      return toolError("file_path is required for queue action");
    }

    mkdirSync(pendingDir, { recursive: true });
    const destName = basename(args.file_path);
    const destPath = join(pendingDir, destName);
    copyFileSync(args.file_path, destPath);

    if (args.meta) {
      const metaPath = join(pendingDir, `${destName}.meta.json`);
      writeFileSync(metaPath, JSON.stringify(args.meta, null, 2));
    }

    return toolResult({
      action: "queued",
      file: destName,
      destination: destPath,
      meta_written: !!args.meta,
    });
  } catch (err) {
    return toolError(`graph_ingest failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// ─── Tool: graph_cypher ───

server.registerTool("graph_cypher", {
  title: "Graph Cypher",
  description:
    "Execute a read-only Cypher query against the memory graph. You generate the Cypher — this tool just runs it. Enforced read-only via Neo4j executeRead(). Use for custom queries not covered by other tools. Admin-only (must be the bootstrap tenant) — non-admin tenants would otherwise be able to bypass tenant filtering by writing raw Cypher.",
  inputSchema: {
    cypher: z.string().describe("Cypher query to execute (read-only)"),
    params: z.record(z.string(), z.unknown()).optional().describe("Query parameters"),
  },
  annotations: { readOnlyHint: true },
}, async (args) => {
  const tenantId = currentTenant();
  if (!isAdminTenant(tenantId)) {
    return toolError(
      `graph_cypher is admin-only (your tenant: ${tenantId}). Use graph_query, graph_entities, or graph_search instead — those are tenant-scoped.`,
    );
  }
  try {
    const result = await client.executeCypher(args.cypher, args.params ?? {});
    return toolResult({
      cypher: args.cypher,
      ...result,
    });
  } catch (err) {
    return toolError(`graph_cypher failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// ─── Tool: graph_decay ───

server.registerTool("graph_decay", {
  title: "Graph Decay",
  description:
    "Apply time-based decay to every node confidence and edge weight using per-type half-lives (preferences ~693d, events ~99d, etc.). Called by the dream process during maintenance. Always preview with dry_run=true first — decay is irreversible without restoring from a graph_export backup. Returns counts of nodes/edges modified per type.",
  inputSchema: {
    dry_run: z.boolean().optional().default(false).describe("Preview only, don't apply changes (default: false)"),
  },
  annotations: { destructiveHint: true },
}, async (args) => {
  try {
    const result = await client.applyDecay(currentTenant(), args.dry_run ?? false);
    return toolResult(result);
  } catch (err) {
    return toolError(`graph_decay failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// ─── Tool: graph_prune ───

server.registerTool("graph_prune", {
  title: "Graph Prune",
  description:
    "Remove entities and edges that have decayed below threshold. DESTRUCTIVE — always preview first. Requires user confirmation before execute mode.",
  inputSchema: {
    mode: z.enum(["preview", "execute"]).optional().default("preview").describe("preview (default) or execute"),
    node_threshold: z.number().optional().default(0.1).describe("Prune nodes below this confidence (default: 0.1)"),
    edge_threshold: z.number().optional().default(0.05).describe("Prune edges below this weight (default: 0.05)"),
    include_orphans: z.boolean().optional().default(true).describe("Also prune orphaned nodes (default: true)"),
    max_age_days: z.number().optional().default(30).describe("Max age for orphan pruning (default: 30)"),
  },
  annotations: { destructiveHint: true },
}, async (args) => {
  try {
    const result = await client.prune(currentTenant(), args.mode ?? "preview", {
      node_threshold: args.node_threshold,
      edge_threshold: args.edge_threshold,
      include_orphans: args.include_orphans,
      max_age_days: args.max_age_days,
    });
    return toolResult(result);
  } catch (err) {
    return toolError(`graph_prune failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// ─── Tool: graph_unmerge ───

server.registerTool("graph_unmerge", {
  title: "Graph Unmerge",
  description:
    "Split a falsely merged entity back into two separate entities, redistributing specified edges. Use when entity resolution made a mistake (e.g. merged 'Anna' and 'Anne'). The original entity keeps every edge not listed in `edges_to_move`; the new entity gets the listed edges plus a fresh embedding stub (re-derive with graph_reembed). Logged to the audit trail with `reason`. Returns the IDs of both entities.",
  inputSchema: {
    entity_id: z.string().describe("The merged entity ID to split"),
    new_entity_name: z.string().describe("Name for the split-off entity"),
    new_entity_type: z.string().describe("Type label for the split-off entity"),
    edges_to_move: z.array(z.object({
      other_entity_id: z.string().describe("Entity on the other end of the edge"),
      relation_type: z.string().describe("Relationship type (e.g. WORKS_ON)"),
      direction: z.enum(["in", "out"]).describe("Direction relative to the entity being split"),
    })).describe("Edges to move to the new entity"),
    reason: z.string().describe("Why splitting (logged in audit)"),
  },
  annotations: { destructiveHint: true },
}, async (args) => {
  try {
    const result = await client.unmerge(
      currentTenant(),
      args.entity_id,
      args.new_entity_name,
      args.new_entity_type as EntityType,
      args.edges_to_move.map((e) => ({
        ...e,
        relation_type: e.relation_type as RelationshipType,
      })),
      args.reason,
    );

    // Log to merge audit
    try {
      const auditDir = join(GRAPH_MEMORY_HOME, "logs");
      mkdirSync(auditDir, { recursive: true });
      const auditPath = join(auditDir, "merge-audit.jsonl");
      const entry = JSON.stringify({
        action: "unmerge",
        timestamp: new Date().toISOString(),
        ...result,
        reason: args.reason,
      });
      writeFileSync(auditPath, entry + "\n", { flag: "a" });
    } catch { /* audit logging is best-effort */ }

    return toolResult({ ...result, audit_logged: true });
  } catch (err) {
    return toolError(`graph_unmerge failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// ─── Tool: graph_merge ───

server.registerTool("graph_merge", {
  title: "Graph Merge",
  description:
    "Consolidate two entities into one — moves source's edges onto target, adopts source properties for keys target doesn't have, then deletes source. Inverse of graph_unmerge. Use after graph_merge_suggestions surfaces a duplicate pair, or whenever you've confirmed two nodes refer to the same thing. Same-tenant only; refuses to merge an entity with itself. Edges directly between source and target are dropped (would become self-loops). When source and target both have the same edge to a third node, the edge is consolidated and the higher weight wins. Target's embedding is cleared so the next graph_reembed will re-derive it from the merged state. Logged to logs/merge-audit.jsonl with `reason`. DESTRUCTIVE — always preview with dry_run=true first; recovery requires a graph_export backup or graph_unmerge with the original edge layout.",
  inputSchema: {
    source_id: z.string().describe("Entity ID to merge from (will be deleted)"),
    target_id: z.string().describe("Entity ID to merge into (will absorb source)"),
    reason: z.string().describe("Why merging (logged in audit)"),
    dry_run: z.boolean().optional().default(false).describe("Preview only, don't apply changes (default: false)"),
  },
  annotations: { destructiveHint: true },
}, async (args) => {
  try {
    const result = await client.merge(currentTenant(), args.source_id, args.target_id, {
      dryRun: args.dry_run ?? false,
    });

    // Log to merge audit (skip on dry-run — nothing happened)
    if (!result.dry_run) {
      try {
        const auditDir = join(GRAPH_MEMORY_HOME, "logs");
        mkdirSync(auditDir, { recursive: true });
        const auditPath = join(auditDir, "merge-audit.jsonl");
        const entry = JSON.stringify({
          action: "merge",
          timestamp: new Date().toISOString(),
          ...result,
          reason: args.reason,
        });
        writeFileSync(auditPath, entry + "\n", { flag: "a" });
      } catch { /* audit logging is best-effort */ }
    }

    return toolResult({ ...result, audit_logged: !result.dry_run });
  } catch (err) {
    return toolError(`graph_merge failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// ─── Tool: graph_merge_suggestions ───

server.registerTool("graph_merge_suggestions", {
  title: "Graph Merge Suggestions",
  description:
    "Surface candidate pairs of entities likely to be duplicates. Read-only — never auto-merges. Combines embedding similarity, shared-neighbor overlap, and name-token Jaccard. Same-type only. Use to triage entity-explosion before running graph_merge (destructive consolidation) or graph_relate with ALIAS_OF (soft alias).",
  inputSchema: {
    entity_id: z.string().optional().describe("Scope to one entity's potential duplicates"),
    entity_type: z.string().optional().describe("Scope to one entity type (Person, Project, etc.)"),
    min_score: z.number().optional().describe("Combined-score threshold to surface (default 0.8)"),
    min_embedding_similarity: z.number().optional().describe("Embedding-similarity floor for candidates (default 0.85)"),
    limit: z.number().optional().describe("Max suggestions to return (default 20, max 100)"),
    weights: z.object({
      embedding: z.number().optional(),
      neighbor_jaccard: z.number().optional(),
      name: z.number().optional(),
    }).optional().describe("Override default weights (0.4 / 0.4 / 0.2)"),
    log_to_audit: z.boolean().optional().describe("Emit merge_flagged audit events for surfaced pairs (default true)"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async (args) => {
  try {
    const tenantId = currentTenant();
    const result = await client.mergeSuggestions(tenantId, {
      entity_id: args.entity_id,
      entity_type: args.entity_type as EntityType | undefined,
      min_score: args.min_score,
      min_embedding_similarity: args.min_embedding_similarity,
      limit: args.limit,
      weights: args.weights,
    });

    if (args.log_to_audit !== false) {
      for (const s of result.suggestions) {
        try {
          appendAuditEvent({
            event: "merge_flagged",
            timestamp: new Date().toISOString(),
            tenant_id: tenantId,
            entity_a: s.entity_a.id,
            entity_b: s.entity_b.id,
            reason: `score=${s.score} (emb=${s.signals.embedding_similarity}, neighbor_jaccard=${s.signals.neighbor_jaccard}, name=${s.signals.name_similarity})`,
          });
        } catch { /* audit is best-effort */ }
      }
    }

    return toolResult(result);
  } catch (err) {
    return toolError(`graph_merge_suggestions failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// ─── Tool: graph_stats ───

server.registerTool("graph_stats", {
  title: "Graph Stats",
  description:
    "Graph health dashboard — node/edge counts by type, average weight, orphan count, unresolved contradictions, stale entries, schema version, and pending ingest backlog. Returns aggregate counts only; for individual entities use graph_entities. Call at session start to size up the graph before deeper queries, after graph_decay or graph_prune to verify the result, or when debugging unexpected query output. No parameters.",
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => {
  debugLog('graph_stats called');
  try {
    debugLog('attempting getStats()...');
    const stats = await client.getStats(currentTenant());
    debugLog('getStats() succeeded');

    // Add schema version and ingest status
    let schemaVersion = "1";
    try {
      schemaVersion = readFileSync(
        join(GRAPH_MEMORY_HOME, "schema", "current_version.txt"),
        "utf-8",
      ).trim();
    } catch { /* default to 1 */ }

    let pendingIngest = 0;
    try {
      const pendingDir = join(GRAPH_MEMORY_HOME, "ingest", "pending");
      pendingIngest = readdirSync(pendingDir).filter((f) => !f.endsWith(".meta.json")).length;
    } catch { /* dir doesn't exist */ }

    return toolResult({
      schema_version: schemaVersion,
      ...stats,
      health: {
        ...stats.health,
        pending_ingest_docs: pendingIngest,
      },
    });
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    debugLog(`graph_stats FULL ERROR: ${e.constructor.name}: ${e.message}`);
    debugLog(`code=${(e as NodeJS.ErrnoException).code ?? 'none'}`);
    debugLog(`stack=${e.stack ?? 'no stack'}`);
    return toolError(`graph_stats failed: ${e.message}`);
  }
});

// ─── Tool: graph_validate ───

// Single-word generic terms that should never be entity names
const GENERIC_NAME_BLOCKLIST = new Set([
  "it", "this", "that", "the", "a", "an", "some", "thing", "things",
  "item", "items", "something", "anything", "everything", "nothing",
  "one", "other", "another", "each", "all", "both", "they", "them",
  "we", "i", "you", "he", "she", "data", "info", "information",
  "here", "there", "now", "then", "later", "unknown", "various",
  "server", "client", "system", "process", "service", "tool",
]);

// Prefixes that indicate reference language rather than entity names
const REFERENCE_PREFIXES = ["the ", "this ", "that ", "a ", "an ", "my ", "our ", "your ", "their "];

server.registerTool("graph_validate", {
  title: "Validate Graph Entities",
  description:
    "Scan recently extracted entities and edges for quality issues: generic names, reference language, " +
    "type mismatches, near-duplicate names, and extreme confidence values. " +
    "Call this after a dream process extraction batch to catch bad data before it settles into the graph. " +
    "Returns up to `max_issues` records of shape `{entity_id, name, type, issue, severity}` where severity is high/medium/low. " +
    "Read-only — pair with graph_delete or graph_unmerge to act on flagged items.",
  inputSchema: {
    source_session: z
      .string()
      .optional()
      .describe("Limit checks to entities extracted in this session. Omit to scan the whole graph."),
    max_issues: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .default(50)
      .describe("Maximum number of issues to return (default 50)."),
  },
  annotations: { readOnlyHint: true },
}, async ({ source_session, max_issues = 50 }) => {
  const issues: Array<{ entity_id: string; name: string; type: string; issue: string; severity: "high" | "medium" | "low" }> = [];

  try {
    const tenantId = currentTenant();
    // Session filter: optional additional narrowing within the tenant.
    const sessionAndForOrphan = source_session
      ? `AND (n.source_session = $session OR EXISTS { MATCH (n)-[r]-() WHERE r.source_session = $session })`
      : "";
    const sessionAndForRest = source_session
      ? `AND (n.source_session = $session OR EXISTS { MATCH (n)-[r]-() WHERE r.source_session = $session })`
      : "";
    const params: Record<string, unknown> = source_session
      ? { tenantId, session: source_session }
      : { tenantId };

    // 1. Generic / blocklisted names (tenant-scoped)
    const genericRows = await client.runReadQuery(`
      MATCH (n:Entity {tenant_id: $tenantId})
      WHERE 1=1 ${sessionAndForRest}
      WITH n, toLower(trim(n.name)) AS lname
      WHERE size(lname) < 3
         OR lname IN $blocklist
      RETURN n.id AS id, n.name AS name, labels(n) AS labels, n.confidence AS confidence
      LIMIT $limit
    `, { ...params, blocklist: [...GENERIC_NAME_BLOCKLIST], limit: Math.ceil(max_issues / 4) });

    for (const row of genericRows) {
      const name = String(row["name"] ?? "");
      const type = ((row["labels"] as string[]) ?? []).find((l) => l !== "Entity") ?? "?";
      const lname = name.toLowerCase().trim();
      const reason = lname.length < 3 ? "name too short (< 3 chars)" : `generic blocklisted name "${lname}"`;
      issues.push({ entity_id: String(row["id"]), name, type, issue: reason, severity: "high" });
    }

    // 2. Reference-language names (tenant-scoped)
    const allNameRows = await client.runReadQuery(`
      MATCH (n:Entity {tenant_id: $tenantId})
      WHERE 1=1 ${sessionAndForRest}
      RETURN n.id AS id, n.name AS name, labels(n) AS labels, n.confidence AS confidence
      LIMIT 2000
    `, params);

    for (const row of allNameRows) {
      if (issues.length >= max_issues) break;
      const name = String(row["name"] ?? "");
      const lname = name.toLowerCase().trim();
      const type = ((row["labels"] as string[]) ?? []).find((l) => l !== "Entity") ?? "?";
      for (const prefix of REFERENCE_PREFIXES) {
        if (lname.startsWith(prefix) && lname.length < 40) {
          issues.push({
            entity_id: String(row["id"]),
            name,
            type,
            issue: `name starts with reference language "${prefix.trim()}" — extract the noun instead`,
            severity: "high",
          });
          break;
        }
      }
    }

    // 3. Orphaned new entities (tenant-scoped)
    const orphanRows = await client.runReadQuery(`
      MATCH (n:Entity {tenant_id: $tenantId})
      WHERE NOT (n)-[]-()
        AND n.confidence <= 0.4
        AND n.times_mentioned <= 1
        ${sessionAndForOrphan}
      RETURN n.id AS id, n.name AS name, labels(n) AS labels, n.confidence AS confidence
      LIMIT $limit
    `, { ...params, limit: Math.ceil(max_issues / 4) });

    for (const row of orphanRows) {
      if (issues.length >= max_issues) break;
      const type = ((row["labels"] as string[]) ?? []).find((l) => l !== "Entity") ?? "?";
      issues.push({
        entity_id: String(row["id"]),
        name: String(row["name"]),
        type,
        issue: `isolated entity with no edges and confidence ${Number(row["confidence"] ?? 0).toFixed(2)} — may be a spurious extraction`,
        severity: "low",
      });
    }

    // 4. Near-duplicate names (tenant-scoped, case-insensitive)
    const dupRows = await client.runReadQuery(`
      MATCH (a:Entity {tenant_id: $tenantId}), (b:Entity {tenant_id: $tenantId})
      WHERE id(a) < id(b)
        AND toLower(trim(a.name)) = toLower(trim(b.name))
        AND a.id <> b.id
      RETURN a.id AS id_a, a.name AS name_a, labels(a) AS labels_a,
             b.id AS id_b, b.name AS name_b, labels(b) AS labels_b
      LIMIT $limit
    `, { tenantId, limit: Math.ceil(max_issues / 4) });

    for (const row of dupRows) {
      if (issues.length >= max_issues) break;
      const typeA = ((row["labels_a"] as string[]) ?? []).find((l) => l !== "Entity") ?? "?";
      const typeB = ((row["labels_b"] as string[]) ?? []).find((l) => l !== "Entity") ?? "?";
      issues.push({
        entity_id: String(row["id_a"]),
        name: String(row["name_a"]),
        type: typeA,
        issue: `near-duplicate: same name as entity ${row["id_b"]} (${row["name_b"]}, type ${typeB}) — consider merging with graph_relate ALIAS_OF or deleting one`,
        severity: "medium",
      });
    }

    const summary = {
      total_issues: issues.length,
      by_severity: {
        high: issues.filter((i) => i.severity === "high").length,
        medium: issues.filter((i) => i.severity === "medium").length,
        low: issues.filter((i) => i.severity === "low").length,
      },
      scope: source_session ? `session:${source_session}` : "full graph",
      issues: issues.slice(0, max_issues),
    };

    return toolResult(summary);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    return toolError(`graph_validate failed: ${e.message}`);
  }
});

// ─── Tool: graph_build_context ───

/** Read the last ~32KB of the dream audit log and find the most recent run_start + run_end pair. */
function readLastDreamFromAudit(): {
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  source: string | null;
  transcripts_processed: number | null;
  ingest_processed: number | null;
  entities_created: number | null;
  edges_created: number | null;
  errors: number | null;
} | null {
  const auditPath = join(GRAPH_MEMORY_HOME, "logs", "dream-audit.jsonl");
  let raw: string;
  let didTruncate = false;
  try {
    const stats = statSync(auditPath);
    const tailBytes = Math.min(stats.size, 32768);
    didTruncate = stats.size > tailBytes;
    const fd = openSync(auditPath, "r");
    try {
      const buf = Buffer.alloc(tailBytes);
      readSync(fd, buf, 0, tailBytes, stats.size - tailBytes);
      raw = buf.toString("utf-8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }

  // Parse the lines we got (drop the first one if we may have started mid-line)
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;
  if (didTruncate) lines.shift();

  let lastStart: Record<string, unknown> | null = null;
  let lastEnd: Record<string, unknown> | null = null;
  for (const line of lines) {
    try {
      const evt = JSON.parse(line) as Record<string, unknown>;
      if (evt["event"] === "run_start") {
        lastStart = evt;
        lastEnd = null;
      } else if (evt["event"] === "run_end") {
        lastEnd = evt;
      }
    } catch { /* skip bad lines */ }
  }

  if (!lastStart) return null;

  return {
    started_at: String(lastStart["timestamp"] ?? ""),
    ended_at: lastEnd ? String(lastEnd["timestamp"] ?? "") : null,
    duration_ms: lastEnd ? Number(lastEnd["duration_ms"] ?? 0) : null,
    source: String(lastStart["source"] ?? "") || null,
    transcripts_processed: lastEnd ? Number(lastEnd["transcripts_processed"] ?? 0) : null,
    ingest_processed: lastEnd ? Number(lastEnd["ingest_processed"] ?? 0) : null,
    entities_created: lastEnd ? Number(lastEnd["entities_created"] ?? 0) : null,
    edges_created: lastEnd ? Number(lastEnd["edges_created"] ?? 0) : null,
    errors: lastEnd ? Number(lastEnd["errors"] ?? 0) : null,
  };
}

/** Read the manifest and synthesize a minimal last_dream record from it. Used when dream-audit.jsonl is missing or pre-dates the audit log feature. */
function lastDreamFromManifest(): {
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  source: string | null;
  transcripts_processed: number | null;
  ingest_processed: number | null;
  entities_created: number | null;
  edges_created: number | null;
  errors: number | null;
} | null {
  try {
    const manifestPath = join(GRAPH_MEMORY_HOME, "processed", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      last_dream_run?: string | null;
      processed?: Record<string, { processed_at?: string; entities_extracted?: number; edges_created?: number }>;
    };
    if (!manifest.last_dream_run) return null;

    // Sum stats for transcripts whose processed_at is within 1 hour of last_dream_run
    const lastRun = new Date(manifest.last_dream_run).getTime();
    let entitiesCreated = 0;
    let edgesCreated = 0;
    let transcriptsProcessed = 0;
    for (const entry of Object.values(manifest.processed ?? {})) {
      if (!entry.processed_at) continue;
      const t = new Date(entry.processed_at).getTime();
      if (Math.abs(t - lastRun) > 1000 * 60 * 60) continue;
      transcriptsProcessed++;
      entitiesCreated += entry.entities_extracted ?? 0;
      edgesCreated += entry.edges_created ?? 0;
    }

    return {
      started_at: manifest.last_dream_run,
      ended_at: null,
      duration_ms: null,
      source: "manifest",
      transcripts_processed: transcriptsProcessed,
      ingest_processed: null,
      entities_created: entitiesCreated,
      edges_created: edgesCreated,
      errors: null,
    };
  } catch {
    return null;
  }
}

/** Count unprocessed transcripts and pending ingest documents. */
function countPendingWork(): { unprocessed_transcripts: number; pending_ingests: number; last_dream_run: string | null } {
  let lastDreamRun: string | null = null;
  let processedIds = new Set<string>();
  try {
    const manifestPath = join(GRAPH_MEMORY_HOME, "processed", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      last_dream_run?: string | null;
      processed?: Record<string, unknown>;
    };
    lastDreamRun = manifest.last_dream_run ?? null;
    processedIds = new Set(Object.keys(manifest.processed ?? {}));
  } catch { /* no manifest yet */ }

  let unprocessed = 0;
  try {
    const projectsDir = join(homedir(), ".claude", "projects");
    const projectDirs = readdirSync(projectsDir, { withFileTypes: true });
    for (const dir of projectDirs) {
      if (!dir.isDirectory()) continue;
      try {
        const files = readdirSync(join(projectsDir, dir.name));
        for (const f of files) {
          if (!f.endsWith(".jsonl") || f.startsWith("agent-")) continue;
          const sid = f.replace(".jsonl", "");
          if (!processedIds.has(sid)) unprocessed++;
        }
      } catch { /* skip */ }
    }
  } catch { /* projects dir missing */ }

  let pending = 0;
  try {
    pending = readdirSync(join(GRAPH_MEMORY_HOME, "ingest", "pending"))
      .filter((f) => !f.endsWith(".meta.json") && !f.endsWith(".error"))
      .length;
  } catch { /* dir missing */ }

  return { unprocessed_transcripts: unprocessed, pending_ingests: pending, last_dream_run: lastDreamRun };
}

server.registerTool("graph_build_context", {
  title: "Build Session Context",
  description:
    "Single tool call that bundles a session's worth of context: graph health, pending work, last dream " +
    "run summary, recent additions, top knowledge hubs, unresolved contradictions, and (optionally) a " +
    "topic neighbourhood. Use this at session start instead of running graph_stats / graph_query / " +
    "graph_contradictions separately. Cuts 4-5 round trips to one.",
  inputSchema: {
    topic: z
      .string()
      .optional()
      .describe("Optional topic to fetch a neighbourhood for (uses graph_query under the hood)."),
    project_cwd: z
      .string()
      .optional()
      .describe("Optional project directory for affinity scoring on the topic neighbourhood."),
    recent_days: z
      .number()
      .int()
      .min(1)
      .max(90)
      .optional()
      .default(7)
      .describe("Window in days for 'recently added' entities (default 7)."),
    hub_count: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .default(5)
      .describe("Number of top knowledge hubs to include (default 5)."),
    include_contradictions: z
      .boolean()
      .optional()
      .default(true)
      .describe("Include unresolved contradictions (default true)."),
    max_recent: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .default(15)
      .describe("Max recent entities to list (default 15)."),
  },
  annotations: { readOnlyHint: true },
}, async (args) => {
  try {
    const tenantId = currentTenant();
    const recentDays = args.recent_days ?? 7;
    const hubCount = args.hub_count ?? 5;
    const includeContradictions = args.include_contradictions ?? true;
    const maxRecent = args.max_recent ?? 15;

    // Run the graph queries in parallel — independent
    const [statsResult, recent, hubs, contradictions, topicResult] = await Promise.all([
      client.getStats(tenantId),
      client.getRecentAdditions(tenantId, recentDays, maxRecent),
      client.getTopHubs(tenantId, hubCount),
      includeContradictions
        ? client.findContradictions(tenantId, false)
        : Promise.resolve({ contradictions: [] as Array<Record<string, unknown>> }),
      args.topic
        ? client.query(tenantId, [args.topic], {
            max_hops: 2,
            min_weight: 0.3,
            limit: 15,
            project_context: args.project_cwd,
            current_only: true,
          })
        : Promise.resolve(null),
    ]);

    // File-based context (non-graph)
    const pendingWork = countPendingWork();
    const lastDream = readLastDreamFromAudit() ?? lastDreamFromManifest();

    const hoursSinceLastDream = pendingWork.last_dream_run
      ? Math.round(((Date.now() - new Date(pendingWork.last_dream_run).getTime()) / (1000 * 60 * 60)) * 10) / 10
      : null;

    return toolResult({
      generated_at: new Date().toISOString(),
      graph_health: {
        nodes: statsResult.nodes.total,
        edges: statsResult.edges.total,
        by_node_type: statsResult.nodes.by_type,
        avg_weight: statsResult.health.avg_weight,
        orphaned: statsResult.health.orphaned_nodes,
        stale: statsResult.health.stale_nodes,
        unresolved_contradictions: statsResult.health.unresolved_contradictions,
      },
      pending_work: {
        unprocessed_transcripts: pendingWork.unprocessed_transcripts,
        pending_ingests: pendingWork.pending_ingests,
        last_dream_run: pendingWork.last_dream_run,
        hours_since_last_dream: hoursSinceLastDream,
      },
      last_dream: lastDream,
      recent_additions: {
        days: recentDays,
        entity_count: recent.nodes.length,
        edge_count: recent.edge_count,
        entities: recent.nodes,
      },
      top_hubs: hubs,
      contradictions: includeContradictions
        ? (contradictions as { contradictions: Array<Record<string, unknown>> }).contradictions
        : null,
      topic_neighbourhood: topicResult
        ? {
            topic: args.topic ?? "",
            node_count: topicResult.nodes.length,
            edge_count: topicResult.edges.length,
            nodes: topicResult.nodes.slice(0, 15),
            edges: topicResult.edges.slice(0, 25),
          }
        : null,
    });
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    return toolError(`graph_build_context failed: ${e.message}`);
  }
});

// ─── Tool: graph_reembed ───

server.registerTool("graph_reembed", {
  title: "Re-embed Entities",
  description:
    "Regenerate semantic-search embeddings for entities. By default only fills missing embeddings " +
    "(idempotent, fast). With force=true, re-embeds every entity — use after changing the embed-text " +
    "recipe (e.g. when richer fields are added). At ~10ms per entity, full re-embed of a few hundred " +
    "nodes finishes in seconds.",
  inputSchema: {
    force: z
      .boolean()
      .optional()
      .default(false)
      .describe("Re-embed every entity, even ones that already have an embedding. Default false."),
  },
  annotations: { idempotentHint: true },
}, async ({ force }) => {
  try {
    const tenantId = currentTenant();
    // Admins re-embed across all tenants; others re-embed only their own.
    const opts: { force?: boolean; tenantId?: string } = { force: force === true };
    if (!isAdminTenant(tenantId)) opts.tenantId = tenantId;
    const result = await client.backfillEmbeddings(opts);
    return toolResult({ ...result, force: force === true, scope: isAdminTenant(tenantId) ? "all-tenants" : tenantId });
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    return toolError(`graph_reembed failed: ${e.message}`);
  }
});

// ─── Tool: graph_search (semantic + hybrid retrieval) ───

server.registerTool("graph_search", {
  title: "Semantic Graph Search",
  description:
    "Find entities semantically similar to a natural-language query, then optionally expand via " +
    "graph traversal. Uses local sentence embeddings (bge-small-en, 384-dim) — no external API. " +
    "Best when the user's wording doesn't match canonical entity names (e.g. \"containers\" → Docker, " +
    "\"AI tools\" → Claude Code/Anthropic SDK). Falls back to graph_query if no embeddings available.",
  inputSchema: {
    query: z
      .string()
      .min(1)
      .describe("Natural-language query (any phrasing — synonyms and paraphrases work)."),
    top_k: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .default(10)
      .describe("How many semantically similar entities to retrieve as seeds (default 10)."),
    min_similarity: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .default(0.5)
      .describe("Minimum cosine similarity threshold (default 0.5)."),
    entity_types: z
      .array(z.enum(ENTITY_TYPES))
      .optional()
      .describe("Restrict results to these entity types."),
    expand: z
      .boolean()
      .optional()
      .default(true)
      .describe("If true (default), also return the immediate graph neighbours of each seed."),
    expand_min_weight: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .default(0.3)
      .describe("Min edge weight when expanding (default 0.3)."),
  },
  annotations: { readOnlyHint: true },
}, async (args) => {
  try {
    // 1. Embed the query
    const { embedText } = await import("../shared/embeddings.js");
    let queryVec: number[];
    try {
      queryVec = await embedText(args.query);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      return toolError(`graph_search: embedder unavailable (${e.message}). Try graph_query instead.`);
    }

    // 2. Vector similarity search → seeds (tenant-scoped)
    const tenantId = currentTenant();
    const seeds = await client.vectorSearch(tenantId, queryVec, {
      top_k: args.top_k ?? 10,
      min_similarity: args.min_similarity ?? 0.5,
      entity_types: args.entity_types as EntityType[] | undefined,
    });

    if (seeds.length === 0) {
      return toolResult({
        query: args.query,
        seeds: [],
        expansion: null,
        note: "No entities matched at the given similarity threshold. Try lowering min_similarity or check that embeddings have been backfilled (graph_stats > schema or check startup logs).",
      });
    }

    // 3. Optionally expand: for each seed, find the top edges
    const expansionEdges: Array<{ from: string; to: string; from_name: string; to_name: string; relation: string; weight: number }> = [];
    const expansionNodes = new Map<string, { id: string; name: string; type: string; from_seed: string }>();

    if (args.expand !== false) {
      const minWeight = args.expand_min_weight ?? 0.3;
      const seedIds = seeds.slice(0, 5).map((s) => s.id); // Expand only top 5 seeds to keep payload tight

      const expansionRows = await client.runReadQuery(
        `
        MATCH (a:Entity {tenant_id: $tenantId})-[r]-(b:Entity {tenant_id: $tenantId})
        WHERE a.id IN $seedIds AND r.weight > $minWeight
        RETURN a.id AS from_id, a.name AS from_name,
               b.id AS to_id, b.name AS to_name,
               [l IN labels(b) WHERE l <> 'Entity'][0] AS to_type,
               type(r) AS relation, r.weight AS weight
        ORDER BY r.weight DESC
        LIMIT 30
        `,
        { tenantId, seedIds, minWeight },
      );

      for (const row of expansionRows) {
        const fromId = String(row["from_id"]);
        const toId = String(row["to_id"]);
        const toName = String(row["to_name"] ?? "");
        const toType = String(row["to_type"] ?? "?");

        expansionEdges.push({
          from: fromId,
          to: toId,
          from_name: String(row["from_name"] ?? ""),
          to_name: toName,
          relation: String(row["relation"] ?? ""),
          weight: Number(row["weight"] ?? 0),
        });

        // Don't include seeds themselves in the expansion node list
        if (!seeds.find((s) => s.id === toId)) {
          expansionNodes.set(toId, { id: toId, name: toName, type: toType, from_seed: fromId });
        }
      }
    }

    return toolResult({
      query: args.query,
      seeds,
      expansion: args.expand === false ? null : {
        nodes: Array.from(expansionNodes.values()),
        edges: expansionEdges,
        node_count: expansionNodes.size,
        edge_count: expansionEdges.length,
      },
    });
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    return toolError(`graph_search failed: ${e.message}`);
  }
});

// ─── Tool: graph_communities ───

server.registerTool("graph_communities", {
  title: "Detect Knowledge Communities",
  description:
    "Find clusters of densely-interconnected entities in the graph. Uses greedy seed-based BFS through " +
    "edges above the weight threshold — works without GDS or APOC. Each entity is assigned to at most " +
    "one community (the first that reaches it from a high-degree seed). Useful for understanding " +
    "knowledge neighbourhoods (e.g. \"everything related to infrastructure\"). " +
    "Returns at most `max_communities` clusters, each shaped `{community_id, seed: {id, name, type}, size, members: [{id, name, type}]}`, sorted by size desc; communities below `min_size` are filtered out. " +
    "Use graph_query or graph_search instead when you have a specific entity to start from.",
  inputSchema: {
    weight_threshold: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .default(0.4)
      .describe("Only traverse edges with weight strictly greater than this (default 0.4)."),
    max_communities: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .default(10)
      .describe("Maximum number of communities to return (default 10)."),
    max_hops: z
      .number()
      .int()
      .min(1)
      .max(4)
      .optional()
      .default(3)
      .describe("BFS depth from each seed (default 3, capped at 4)."),
    min_size: z
      .number()
      .int()
      .min(2)
      .optional()
      .default(2)
      .describe("Minimum members for a community to be returned (default 2)."),
  },
  annotations: { readOnlyHint: true },
}, async (args) => {
  try {
    const result = await client.findCommunities(currentTenant(), {
      weight_threshold: args.weight_threshold,
      max_communities: args.max_communities,
      max_hops: args.max_hops,
      min_size: args.min_size,
    });
    return toolResult(result);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    return toolError(`graph_communities failed: ${e.message}`);
  }
});

// ─── Tool: graph_export ───

server.registerTool("graph_export", {
  title: "Export Graph",
  description:
    "Export all graph nodes and edges to a timestamped JSONL backup file in the backups/ directory. " +
    "Run this before any risky operation, or on a weekly schedule. Old backups are pruned automatically.",
  inputSchema: {
    keep: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .default(14)
      .describe("Number of backup files to keep (default 14, ~2 weeks of daily backups)."),
    label: z
      .string()
      .optional()
      .describe("Optional label appended to the filename, e.g. 'pre-prune' → backup-2026-05-05-pre-prune.jsonl"),
  },
}, async ({ keep = 14, label }) => {
  const backupsDir = join(GRAPH_MEMORY_HOME, "backups");
  mkdirSync(backupsDir, { recursive: true });

  const now = new Date();
  const datePart = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const suffix = label ? `-${label.replace(/[^a-z0-9-]/gi, "-")}` : "";
  const filename = `backup-${datePart}${suffix}.jsonl`;
  const filePath = join(backupsDir, filename);

  try {
    const tenantId = currentTenant();
    const { nodes, edges } = await client.exportGraph(tenantId);

    const lines: string[] = [];
    lines.push(JSON.stringify({ record: "meta", exported_at: now.toISOString(), tenant_id: tenantId, node_count: nodes.length, edge_count: edges.length }));
    for (const node of nodes) lines.push(JSON.stringify({ record: "node", ...node }));
    for (const edge of edges) lines.push(JSON.stringify({ record: "edge", ...edge }));

    writeFileSync(filePath, lines.join("\n") + "\n");
    const sizeBytes = statSync(filePath).size;

    // Prune old backups — keep the N most recent
    const allBackups = readdirSync(backupsDir)
      .filter((f) => f.startsWith("backup-") && f.endsWith(".jsonl"))
      .map((f) => ({ name: f, mtime: statSync(join(backupsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    const toDelete = allBackups.slice(keep);
    for (const f of toDelete) {
      try { unlinkSync(join(backupsDir, f.name)); } catch { /* ignore */ }
    }

    return toolResult({
      backup_file: filePath,
      node_count: nodes.length,
      edge_count: edges.length,
      size_bytes: sizeBytes,
      pruned: toDelete.length,
      retained: Math.min(allBackups.length, keep),
    });
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    return toolError(`graph_export failed: ${e.message}`);
  }
});

// ─── Tool: graph_read_transcript ───

server.registerTool("graph_read_transcript", {
  title: "Read Transcript",
  description:
    "Read and parse a Claude Code JSONL transcript file through the canonical transcript parser. " +
    "Returns normalized messages with text content extracted. Use this instead of reading raw JSONL " +
    "directly — if the transcript format changes, only this tool needs updating.",
  inputSchema: {
    session_id: z
      .string()
      .optional()
      .describe("Session UUID (filename without .jsonl). Searches ~/.claude/projects/ for a match."),
    file_path: z
      .string()
      .optional()
      .describe("Absolute path to the .jsonl file. Takes precedence over session_id."),
    text_only: z
      .boolean()
      .optional()
      .default(true)
      .describe("If true (default), return only messages that have extractable text content."),
  },
  annotations: { readOnlyHint: true },
}, async ({ session_id, file_path, text_only = true }) => {
  if (!session_id && !file_path) {
    return toolError("Provide either session_id or file_path");
  }

  let resolvedPath = file_path;

  if (!resolvedPath && session_id) {
    const { readdirSync: rd, statSync: st } = await import("node:fs");
    const { homedir } = await import("node:os");
    const projectsDir = join(homedir(), ".claude", "projects");
    try {
      const projectDirs = rd(projectsDir, { withFileTypes: true });
      for (const dir of projectDirs) {
        if (!dir.isDirectory()) continue;
        const candidate = join(projectsDir, dir.name, `${session_id}.jsonl`);
        try { st(candidate); resolvedPath = candidate; break; } catch { /* not here */ }
      }
    } catch { /* projects dir missing */ }
    if (!resolvedPath) {
      return toolError(`No transcript found for session_id: ${session_id}`);
    }
  }

  const result = parseTranscriptFile(resolvedPath!);
  const messages = text_only ? getTextMessages(result) : result.messages;

  return toolResult({
    session_id: result.sessionId,
    cwd: result.cwd,
    format_version: result.formatVersion,
    line_count: result.lineCount,
    message_count: result.messages.length,
    text_message_count: getTextMessages(result).length,
    warnings: result.warnings,
    messages: messages.map((m) => ({
      role: m.role,
      timestamp: m.timestamp,
      uuid: m.uuid,
      parentUuid: m.parentUuid,
      text: m.textContent,
    })),
  });
});

// ─── Tool: graph_audit ───

server.registerTool("graph_audit", {
  title: "Dream Audit Log",
  description:
    "Append a structured event to the dream process audit log (logs/dream-audit.jsonl). " +
    "Call this during the dream process to record run_start, run_end, transcript_start, " +
    "transcript_end, entity_created, entity_resolved, edge_created, edge_modified, merge_flagged, " +
    "contradiction_found, ingest_start, ingest_end, decay_applied, format_warning, or error events. " +
    "entity_resolved is the audit trail for entity-resolution decisions during dream — every time the " +
    "dream picks between matching an existing entity, creating a new one, or flagging an ambiguous " +
    "candidate, log it here so a later graph_unmerge can reconstruct why a merge happened.",
  inputSchema: {
    event: z
      .enum([
        "run_start", "run_end",
        "transcript_start", "transcript_end", "transcript_skipped",
        "entity_created", "entity_resolved", "edge_created", "edge_modified",
        "merge_flagged", "contradiction_found",
        "ingest_start", "ingest_end",
        "decay_applied", "format_warning", "error",
      ])
      .describe("Event type"),
    data: z
      .record(z.string(), z.unknown())
      .describe("Event payload — fields vary by event type. Always include relevant names/IDs."),
  },
}, async ({ event, data }) => {
  const auditEvent = {
    event,
    timestamp: new Date().toISOString(),
    ...data,
  } as DreamAuditEvent;
  appendAuditEvent(auditEvent);
  return toolResult({ logged: true, event, timestamp: auditEvent.timestamp });
});

// ─── Start Server ───

const MCP_TRANSPORT = process.env.MCP_TRANSPORT ?? "stdio";

if (MCP_TRANSPORT === "http") {
  const port = parseInt(process.env.MCP_PORT ?? "3847", 10);

  // TLS: use HTTPS if cert files are provided
  const tlsCert = process.env.TLS_CERT;
  const tlsKey = process.env.TLS_KEY;
  const useTLS = !!(tlsCert && tlsKey);
  const proto = useTLS ? "https" : "http";

  // ─── OAuth helpers ────────────────────────────────────────────────────────

  /** Read body, supporting application/json or application/x-www-form-urlencoded.
   *  Returns a key→value record; values are strings or string arrays. */
  async function readBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
    const raw = await new Promise<string>((resolve, reject) => {
      let data = "";
      req.on("data", (c) => { data += c; });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
    if (!raw) return {};
    const ct = (req.headers["content-type"] ?? "").toString();
    if (ct.includes("application/json")) {
      try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
    }
    if (ct.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(raw);
      const out: Record<string, string> = {};
      for (const [k, v] of params) out[k] = v;
      return out;
    }
    // Fallback: try JSON, then form
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { /* fall through */ }
    try {
      const params = new URLSearchParams(raw);
      const out: Record<string, string> = {};
      for (const [k, v] of params) out[k] = v;
      return out;
    } catch { return {}; }
  }

  function jsonResp(res: import("node:http").ServerResponse, status: number, body: unknown, extra?: Record<string, string>) {
    res.writeHead(status, { "Content-Type": "application/json", ...(extra ?? {}) });
    res.end(JSON.stringify(body));
  }

  /** Handle all OAuth 2.1 endpoints. Errors are surfaced as RFC 6749-style
   *  JSON {error, error_description}. */
  async function handleOAuthRoute(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    url: URL,
  ): Promise<void> {
    try {
      // ── Discovery: authorization-server metadata ──
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return jsonResp(res, 200, authorizationServerMetadata());
      }
      // openid-configuration: same shape as oauth-authorization-server for
      // OAuth 2.1 servers; some clients fetch this URL specifically.
      if (url.pathname === "/.well-known/openid-configuration") {
        return jsonResp(res, 200, authorizationServerMetadata());
      }
      // ── Discovery: protected-resource metadata (RFC 9728) ──
      if (url.pathname === "/.well-known/oauth-protected-resource") {
        return jsonResp(res, 200, protectedResourceMetadata());
      }
      // ── JWKS for token verification ──
      if (url.pathname === "/oauth/jwks") {
        const jwks = await getJwksJson();
        return jsonResp(res, 200, jwks, { "Cache-Control": "public, max-age=300" });
      }

      // ── Dynamic client registration (RFC 7591) ──
      if (url.pathname === "/oauth/register") {
        if (req.method !== "POST") {
          return jsonResp(res, 405, { error: "method_not_allowed" }, { Allow: "POST" });
        }
        const body = await readBody(req);
        try {
          const client = registerClient({
            client_name: typeof body.client_name === "string" ? body.client_name : undefined,
            redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [],
            token_endpoint_auth_method: typeof body.token_endpoint_auth_method === "string"
              ? body.token_endpoint_auth_method as "none" | "client_secret_basic" | "client_secret_post"
              : "none",
            grant_types: Array.isArray(body.grant_types) ? body.grant_types.map(String) : undefined,
            response_types: Array.isArray(body.response_types) ? body.response_types.map(String) : undefined,
          });
          return jsonResp(res, 201, client);
        } catch (err) {
          return jsonResp(res, 400, {
            error: "invalid_client_metadata",
            error_description: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // ── Authorize: identifies the user via Cf-Access-Jwt-Assertion,
      //    issues an auth code, redirects to client's redirect_uri ──
      if (url.pathname === "/oauth/authorize") {
        if (req.method !== "GET") {
          return jsonResp(res, 405, { error: "method_not_allowed" }, { Allow: "GET" });
        }
        const params = url.searchParams;
        const responseType = params.get("response_type");
        const clientId = params.get("client_id");
        const redirectUri = params.get("redirect_uri");
        const state = params.get("state") ?? "";
        const codeChallenge = params.get("code_challenge") ?? undefined;
        const codeChallengeMethod = (params.get("code_challenge_method") as "S256" | "plain" | null) ?? undefined;
        const scope = params.get("scope") ?? "";

        if (responseType !== "code") {
          return jsonResp(res, 400, { error: "unsupported_response_type", error_description: "only response_type=code is supported" });
        }
        if (!clientId || !redirectUri) {
          return jsonResp(res, 400, { error: "invalid_request", error_description: "client_id and redirect_uri are required" });
        }
        const client = getClient(clientId);
        if (!client) {
          return jsonResp(res, 400, { error: "invalid_client", error_description: `unknown client_id ${clientId}` });
        }
        if (!client.redirect_uris.includes(redirectUri)) {
          return jsonResp(res, 400, { error: "invalid_request", error_description: "redirect_uri does not match registered values" });
        }

        // Identify the user via Cloudflare Access JWT (this path stays gated
        // by CF Access in the dashboard so we receive the header here).
        const cfJwt = (req.headers["cf-access-jwt-assertion"] ?? "") as string;
        if (!cfJwt) {
          return jsonResp(res, 401, {
            error: "login_required",
            error_description: "this endpoint must be reached through Cloudflare Access — the CF Access policy was likely bypassed for this path. Re-add policy on /oauth/authorize.",
          });
        }
        const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN;
        const audience = process.env.CF_ACCESS_AUD;
        if (!teamDomain || !audience) {
          return jsonResp(res, 500, { error: "server_error", error_description: "CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must be configured" });
        }
        let identity;
        try {
          identity = await verifyCfAccessJwt(cfJwt, { teamDomain, audience });
        } catch (err) {
          return jsonResp(res, 401, {
            error: "invalid_grant",
            error_description: `Cf-Access-Jwt-Assertion verification failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }

        const code = issueAuthCode({
          client_id: clientId,
          redirect_uri: redirectUri,
          email: identity.email,
          scope,
          code_challenge: codeChallenge,
          code_challenge_method: codeChallengeMethod ?? undefined,
        });

        const dest = new URL(redirectUri);
        dest.searchParams.set("code", code);
        if (state) dest.searchParams.set("state", state);
        res.writeHead(302, { Location: dest.toString() });
        res.end();
        return;
      }

      // ── Token endpoint: exchange auth code (or refresh token) for access token ──
      if (url.pathname === "/oauth/token") {
        if (req.method !== "POST") {
          return jsonResp(res, 405, { error: "method_not_allowed" }, { Allow: "POST" });
        }
        const body = await readBody(req);
        const grantType = String(body.grant_type ?? "");

        if (grantType === "authorization_code") {
          const code = String(body.code ?? "");
          const redirectUri = String(body.redirect_uri ?? "");
          const clientId = String(body.client_id ?? "");
          const verifier = typeof body.code_verifier === "string" ? body.code_verifier : undefined;

          const entry = consumeAuthCode(code);
          if (!entry) {
            return jsonResp(res, 400, { error: "invalid_grant", error_description: "auth code expired, already used, or unknown" });
          }
          if (entry.client_id !== clientId) {
            return jsonResp(res, 400, { error: "invalid_grant", error_description: "client_id mismatch" });
          }
          if (entry.redirect_uri !== redirectUri) {
            return jsonResp(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
          }
          if (entry.code_challenge) {
            if (!verifier) {
              return jsonResp(res, 400, { error: "invalid_request", error_description: "code_verifier required" });
            }
            if (!verifyPkce(verifier, entry.code_challenge, entry.code_challenge_method ?? "S256")) {
              return jsonResp(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
            }
          }
          const access = await issueAccessToken({ email: entry.email, client_id: clientId, scope: entry.scope });
          const refresh = await issueRefreshToken({ email: entry.email, client_id: clientId, scope: entry.scope });
          return jsonResp(res, 200, {
            access_token: access,
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: refresh,
            scope: entry.scope,
          });
        }

        if (grantType === "refresh_token") {
          const token = String(body.refresh_token ?? "");
          const clientId = String(body.client_id ?? "");
          let claims;
          try {
            claims = await verifyRefreshToken(token);
          } catch (err) {
            return jsonResp(res, 400, { error: "invalid_grant", error_description: err instanceof Error ? err.message : String(err) });
          }
          if (claims.client_id !== clientId) {
            return jsonResp(res, 400, { error: "invalid_grant", error_description: "client_id mismatch" });
          }
          const access = await issueAccessToken({ email: claims.email, client_id: clientId, scope: claims.scope });
          return jsonResp(res, 200, {
            access_token: access,
            token_type: "Bearer",
            expires_in: 3600,
            scope: claims.scope,
          });
        }

        return jsonResp(res, 400, { error: "unsupported_grant_type", error_description: `grant_type=${grantType} not supported` });
      }

      jsonResp(res, 404, { error: "not_found" });
    } catch (err) {
      jsonResp(res, 500, {
        error: "server_error",
        error_description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const requestHandler = async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    const url = new URL(req.url ?? "/", `${proto}://localhost:${port}`);

    // Health check
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", transport: proto }));
      return;
    }

    // OAuth 2.1 endpoints — handled before /mcp routing.
    // None of these require tenant resolution; /oauth/authorize identifies
    // the user via Cf-Access-Jwt-Assertion (still gated by CF Access on that
    // path), the rest are public.
    if (
      url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/oauth-protected-resource" ||
      url.pathname === "/.well-known/openid-configuration" ||
      url.pathname === "/oauth/authorize" ||
      url.pathname === "/oauth/token" ||
      url.pathname === "/oauth/register" ||
      url.pathname === "/oauth/jwks"
    ) {
      await handleOAuthRoute(req, res, url);
      return;
    }

    // MCP endpoint only
    if (url.pathname !== "/mcp") {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    // GET probe: Claude Desktop sends GET without Accept: text/event-stream to check if the
    // server is alive. Return 405 with Allow header so it knows to use POST instead.
    if (req.method === "GET") {
      const accept = req.headers["accept"] ?? "";
      if (!accept.includes("text/event-stream")) {
        res.writeHead(405, { "Allow": "POST", "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Use POST for MCP requests" }));
        return;
      }
    }

    // For all other methods (POST, DELETE, and GET with SSE accept), delegate to a fresh
    // stateless transport per request.
    let parsedBody: unknown;
    if (req.method === "POST") {
      const raw = await new Promise<string>((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => { data += chunk; });
        req.on("end", () => resolve(data));
        req.on("error", reject);
      });
      try {
        parsedBody = JSON.parse(raw);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad Request: invalid JSON" }));
        return;
      }
    }

    // Resolve the tenant for this request before handing off to the MCP transport.
    // The transport calls tool handlers without direct request access; we make
    // the tenant available to them via AsyncLocalStorage.
    let tenantCtx: TenantContext;
    try {
      const resolved = await resolveTenantFromRequest(req.headers as Record<string, string | string[] | undefined>);
      tenantCtx = resolved;
    } catch (err) {
      const status = err instanceof TenantAuthError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      // RFC 9728: when auth fails, advertise where to find OAuth metadata so
      // MCP clients (like claude.ai) can start the OAuth flow.
      if (status === 401) {
        const issuer = getIssuer();
        headers["WWW-Authenticate"] =
          `Bearer realm="graph-memory", resource_metadata="${issuer}/.well-known/oauth-protected-resource"`;
      }
      res.writeHead(status, headers);
      res.end(JSON.stringify({ error: message }));
      return;
    }

    // Per-request access log (best-effort)
    const accessLogStart = Date.now();
    appendMcpAccessLog({
      timestamp: new Date(accessLogStart).toISOString(),
      tenant_id: tenantCtx.tenantId,
      method: req.method ?? "?",
      path: url.pathname,
      identity_source: tenantCtx.identity ? "cf-access" : "static",
    });

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    try {
      await tenantContext.run(tenantCtx, async () => {
        await transport.handleRequest(req, res, parsedBody);
      });
    } finally {
      await transport.close();
    }
  };

  const server_ = useTLS
    ? createHttpsServer({ cert: readFileSync(tlsCert!), key: readFileSync(tlsKey!) }, requestHandler)
    : createHttpServer(requestHandler);

  server_.listen(port, "0.0.0.0", () => {
    console.error(`[graph-memory] MCP server running on ${proto}://0.0.0.0:${port}/mcp`);
  });

} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[graph-memory] MCP server running on stdio");
}
