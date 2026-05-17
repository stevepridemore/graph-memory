import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";
import { join } from "node:path";
/* eslint-disable @typescript-eslint/no-redundant-type-constituents */
import neo4j, { Driver, Integer } from "neo4j-driver";
import { getConfig, GRAPH_MEMORY_HOME } from "./config.js";
import type {
  EntityType,
  RelationshipType,
  EntityNode,
  RelationshipEdge,
  QueryResult,
  BatchInput,
} from "./types.js";
import { embedText, buildEmbedText } from "./embeddings.js";

function debugLogClient(msg: string): void {
  process.stderr.write(`[graph-memory] ${msg}\n`);
}

// Re-export for convenience
export type { EntityNode, RelationshipEdge, QueryResult };

// ─── Type helpers ───

type Row = Record<string, unknown>;

/** Convert a neo4j-driver value to a plain JS value. */
function toPlain(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  // neo4j Integer
  if (neo4j.isInt(value as Integer)) {
    return (value as Integer).toNumber();
  }
  if (Array.isArray(value)) return value.map(toPlain);
  if (typeof value !== "object") return value;

  const v = value as Record<string, unknown>;

  // Neo4j Node: has labels[] and properties{}
  if (Array.isArray(v["labels"]) && "properties" in v) {
    return {
      labels: v["labels"] as string[],
      properties: toPlainObj(v["properties"] as Record<string, unknown>),
    };
  }
  // Neo4j Relationship: has type string, start, end, properties
  if (typeof v["type"] === "string" && "start" in v && "properties" in v) {
    return {
      type: v["type"] as string,
      properties: toPlainObj(v["properties"] as Record<string, unknown>),
    };
  }
  // Neo4j temporal types (DateTime, Date, etc.) — all have a `year` field
  if ("year" in v) {
    return String(value);
  }
  // Plain object
  return toPlainObj(v);
}

function toPlainObj(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, toPlain(v)]));
}

/**
 * Recursively convert plain JS integer numbers to neo4j.int().
 * Float values (weights, rates, confidence) are left as-is.
 * Neo4j requires integer literals for LIMIT, SKIP, and integer params.
 */
function intifyParams(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "number") {
    return Number.isInteger(value) ? neo4j.int(value) : value;
  }
  if (Array.isArray(value)) return value.map(intifyParams);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, intifyParams(v)]),
    );
  }
  return value;
}

// ─── Helpers ───

function toISOString(dt: unknown): string {
  if (dt && typeof dt === "object" && "toString" in dt) {
    return (dt as { toString(): string }).toString();
  }
  return String(dt ?? "");
}

function recordToEntity(record: Record<string, unknown>, labels: string[]): EntityNode {
  const type = labels.find((l) => l !== "Entity") as EntityType | undefined;
  const props = { ...record };
  const id = String(props.id ?? "");
  const name = String(props.name ?? "");
  const confidence = Number(props.confidence ?? 0.5);
  const times_mentioned = Number(props.times_mentioned ?? 1);
  const first_seen = toISOString(props.first_seen);
  const last_seen = toISOString(props.last_seen);
  const source_file = props.source_file ? String(props.source_file) : undefined;
  const subtype = props.subtype ? String(props.subtype) : undefined;

  for (const k of [
    "id", "name", "confidence", "times_mentioned",
    "first_seen", "last_seen", "source_file", "subtype",
    "embedding", // internal vector index — never expose to callers
  ]) {
    delete props[k];
  }

  return {
    id, name, type: type ?? "Concept", subtype, confidence,
    times_mentioned, first_seen, last_seen, source_file,
    properties: props,
  };
}

function recordToEdge(
  rel: Record<string, unknown>,
  relType: string,
  fromId: string,
  toId: string,
): RelationshipEdge {
  const props = { ...rel };
  const weight = Number(props.weight ?? 0.5);
  const last_confirmed = toISOString(props.last_confirmed);
  const evidence = props.evidence ? String(props.evidence) : undefined;
  const valid_at = props.valid_at ? toISOString(props.valid_at) : null;
  const invalid_at = props.invalid_at ? toISOString(props.invalid_at) : null;
  const ingested_at = props.ingested_at ? toISOString(props.ingested_at) : null;
  const source_session = props.source_session ? String(props.source_session) : undefined;
  const source_transcript = props.source_transcript ? String(props.source_transcript) : undefined;
  const source_type = props.source_type ? String(props.source_type) : undefined;

  for (const k of [
    "weight", "last_confirmed", "evidence", "valid_at", "invalid_at", "ingested_at",
    "source_session", "source_transcript", "source_type",
  ]) {
    delete props[k];
  }

  return {
    from: fromId, to: toId, type: relType as RelationshipType,
    weight, last_confirmed, evidence, valid_at, invalid_at, ingested_at,
    source_session, source_transcript, source_type,
    properties: props,
  };
}

// ─── Neo4jClient ───

export class Neo4jClient {
  private driver: Driver;
  private database: string;

  constructor(uri?: string, user?: string, password?: string, database?: string) {
    const config = getConfig();
    const finalUri = uri ?? config.neo4j.uri;
    const finalUser = user ?? config.neo4j.user;
    const finalPassword = password ?? config.neo4j.password;
    this.database = database ?? config.neo4j.database;
    if (!finalPassword) {
      throw new Error("NEO4J_PASSWORD is required. Set NEO4J_PASSWORD environment variable.");
    }
    this.driver = neo4j.driver(
      finalUri,
      neo4j.auth.basic(finalUser, finalPassword),
      {
        // Recycle connections before AuraDB's idle timeout drops them
        maxConnectionLifetime: 30 * 60 * 1000,
        maxConnectionPoolSize: 2,
        connectionAcquisitionTimeout: 30_000,
        logging: neo4j.logging.console("warn"),
      },
    );
  }

  /** Public read-only query — for use by validation and export tools. */
  async runReadQuery(cypher: string, params: Record<string, unknown> = {}): Promise<Row[]> {
    return this.run(cypher, params);
  }

  private async run(cypher: string, params: Record<string, unknown> = {}): Promise<Row[]> {
    const session = this.driver.session({ defaultAccessMode: neo4j.session.WRITE, database: this.database });
    try {
      const result = await session.run(cypher, intifyParams(params) as Record<string, unknown>);
      return result.records.map((rec) => {
        const obj: Row = {};
        for (const key of rec.keys) {
          obj[key as string] = toPlain(rec.get(key as string));
        }
        return obj;
      });
    } finally {
      await session.close();
    }
  }

  private async runReadOnly(
    cypher: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<Row[]> {
    const session = this.driver.session({ defaultAccessMode: neo4j.session.READ, database: this.database });
    try {
      const result = await session.executeRead(
        (tx) => tx.run(cypher, intifyParams(params) as Record<string, unknown>),
        { timeout: options.timeoutMs ?? 30_000 },
      );
      return result.records.map((rec) => {
        const obj: Row = {};
        for (const key of rec.keys) {
          obj[key as string] = toPlain(rec.get(key as string));
        }
        return obj;
      });
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  async verifyConnectivity(): Promise<void> {
    await this.driver.verifyConnectivity();
  }

  async clearAll(): Promise<void> {
    await this.run("MATCH (n) DETACH DELETE n");
  }

  /** Delete every node + edge belonging to a single tenant. Tenant-scoped
   *  counterpart to clearAll(); safe to call against a shared Neo4j instance
   *  because it only touches data tagged with the given tenant_id. Used by
   *  the integration test suite so a misconfigured local run can't wipe a
   *  real graph that happens to live on the same server. */
  async clearTenant(tenantId: string): Promise<void> {
    await this.run(
      "MATCH (n:Entity {tenant_id: $tenantId}) DETACH DELETE n",
      { tenantId },
    );
  }

  /** Count nodes that DON'T match a tenant-id pattern. Used as a startup
   *  guard in tests — refuse to run if the database has data we don't own. */
  async countNodesOutsideTenantPrefix(prefix: string): Promise<number> {
    const rows = await this.run(
      `MATCH (n:Entity)
       WHERE n.tenant_id IS NULL OR NOT n.tenant_id STARTS WITH $prefix
       RETURN count(n) AS n`,
      { prefix },
    );
    return Number(rows[0]?.["n"] ?? 0);
  }

  // ─── Time-travel primitives ──────────────────────────────────────────────
  // Set lifecycle timestamps directly. Primary use is exercising decay and
  // bi-temporal logic in tests, but production maintenance scripts may also
  // need them (e.g., manually marking an edge superseded after a wrong fact
  // was recorded).

  /** Backdate a node's `last_seen` by N days. Fires the decay codepath on
   *  the next `applyDecay()` run. */
  async setNodeLastSeen(tenantId: string, id: string, daysAgo: number): Promise<void> {
    const target = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    await this.run(
      `MATCH (n:Entity {tenant_id: $tenantId, id: $id})
       SET n.last_seen = datetime($target)`,
      { tenantId, id, target },
    );
  }

  /** Backdate an edge's `last_confirmed` by N days. Same purpose as
   *  setNodeLastSeen but for edges; decay weighs both ends. */
  async setEdgeLastConfirmed(
    tenantId: string,
    fromId: string,
    toId: string,
    relation: RelationshipType,
    daysAgo: number,
  ): Promise<void> {
    const target = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    await this.run(
      `MATCH (a:Entity {tenant_id: $tenantId, id: $fromId})-[r:\`${relation}\`]->(b:Entity {tenant_id: $tenantId, id: $toId})
       SET r.last_confirmed = datetime($target)`,
      { tenantId, fromId, toId, target },
    );
  }

  /** Mark an edge invalid (superseded) as of a given timestamp. After this,
   *  query() with the default `current_only: true` filter will exclude it. */
  async setEdgeInvalidAt(
    tenantId: string,
    fromId: string,
    toId: string,
    relation: RelationshipType,
    isoString: string,
  ): Promise<void> {
    await this.run(
      `MATCH (a:Entity {tenant_id: $tenantId, id: $fromId})-[r:\`${relation}\`]->(b:Entity {tenant_id: $tenantId, id: $toId})
       SET r.invalid_at = datetime($isoString)`,
      { tenantId, fromId, toId, isoString },
    );
  }

  // ─── Schema Initialization ───

  async initializeSchema(): Promise<void> {
    const schemaPath = join(GRAPH_MEMORY_HOME, "schema", "v1.cypher");

    let cypher: string;
    try {
      cypher = readFileSync(schemaPath, "utf-8");
    } catch {
      // Fall back to bundled schema in the project repo
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const bundledPath = join(__dirname, "..", "..", "schema", "v1.cypher");
      cypher = readFileSync(bundledPath, "utf-8");
    }

    const statements = cypher
      .split(";")
      .map((s) => s.replace(/\/\/.*$/gm, "").trim())
      .filter((s) => s.length > 0);

    for (const stmt of statements) {
      await this.run(stmt);
    }

    // Multi-tenant backfill: existing entities (created before tenant support
    // landed) have no tenant_id. Stamp them with BOOTSTRAP_TENANT_ID so the
    // composite (tenant_id, id) uniqueness constraint becomes effective and so
    // existing data remains visible to its original owner.
    const bootstrapTenant = process.env.BOOTSTRAP_TENANT_ID ?? "bootstrap";
    const backfillResult = await this.run(
      `MATCH (n:Entity) WHERE n.tenant_id IS NULL SET n.tenant_id = $tenant RETURN count(n) AS updated`,
      { tenant: bootstrapTenant },
    );
    const tenantBackfilled = Number(backfillResult[0]?.["updated"] ?? 0);
    if (tenantBackfilled > 0) {
      debugLogClient(`tenant_id backfilled on ${tenantBackfilled} entities (tenant=${bootstrapTenant})`);
    }

    // Edge tenant_id backfill: edges inherit their tenant from the start node.
    // Existing edges aren't required to carry tenant_id (queries filter by node
    // tenant_id which is enough for isolation), but having it on edges makes
    // export and audit cleaner.
    const edgeBackfillResult = await this.run(`
      MATCH (a:Entity)-[r]->(b:Entity)
      WHERE r.tenant_id IS NULL AND a.tenant_id IS NOT NULL
      SET r.tenant_id = a.tenant_id
      RETURN count(r) AS updated
    `);
    const edgeTenantBackfilled = Number(edgeBackfillResult[0]?.["updated"] ?? 0);
    if (edgeTenantBackfilled > 0) {
      debugLogClient(`tenant_id backfilled on ${edgeTenantBackfilled} edges (inherited from start node)`);
    }

    // Bi-temporal backfill: existing edges have no ingested_at — set it to last_confirmed
    // as the best available approximation. Only runs against edges where the property is null.
    await this.run(`
      MATCH ()-[r]->()
      WHERE r.ingested_at IS NULL AND r.last_confirmed IS NOT NULL
      SET r.ingested_at = r.last_confirmed
    `);
  }

  // ─── Entity CRUD ───

  async createEntity(
    tenantId: string,
    type: EntityType,
    id: string,
    name: string,
    properties: Record<string, unknown> = {},
    confidence = 0.5,
  ): Promise<EntityNode> {
    const now = new Date().toISOString();
    // Embed name + type + select properties for semantic search. Best-effort —
    // if embedder fails, we still create the entity and let the backfill catch it.
    let embedding: number[] | null = null;
    try {
      embedding = await embedText(buildEmbedText(name, type, properties));
    } catch (err) {
      debugLogClient(`embedText failed for "${name}": ${err instanceof Error ? err.message : String(err)}`);
    }
    // MERGE includes tenant_id in the merge key — different tenants may have
    // entities with the same canonical id and they remain distinct nodes.
    const rows = await this.run(
      `
      MERGE (n:Entity:\`${type}\` {tenant_id: $tenantId, id: $id})
      ON CREATE SET
        n.name = $name,
        n.confidence = $confidence,
        n.times_mentioned = 1,
        n.first_seen = datetime($now),
        n.last_seen = datetime($now),
        n.embedding = $embedding
      ON MATCH SET
        n.name = $name,
        n.confidence = CASE WHEN $confidence > n.confidence THEN $confidence ELSE n.confidence END,
        n.times_mentioned = n.times_mentioned + 1,
        n.last_seen = datetime($now)
      SET n += $properties
      RETURN n, labels(n) AS labels
      `,
      { tenantId, id, name, confidence, now, properties, embedding },
    );
    const row = rows[0];
    const nodeObj = row["n"] as { labels: string[]; properties: Record<string, unknown> };
    return recordToEntity(nodeObj.properties, nodeObj.labels);
  }

  /** Look up an entity's ID by its exact name within a tenant. Returns null if not found. */
  async findEntityIdByName(tenantId: string, name: string): Promise<string | null> {
    const rows = await this.run(
      `MATCH (n:Entity {tenant_id: $tenantId}) WHERE n.name = $name RETURN n.id AS id LIMIT 1`,
      { tenantId, name },
    );
    if (rows.length === 0) return null;
    return String(rows[0]["id"]);
  }

  async getEntity(tenantId: string, id: string): Promise<EntityNode | null> {
    const rows = await this.run(
      `MATCH (n:Entity {tenant_id: $tenantId, id: $id}) RETURN n, labels(n) AS labels`,
      { tenantId, id },
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    const nodeObj = row["n"] as { labels: string[]; properties: Record<string, unknown> };
    return recordToEntity(nodeObj.properties, nodeObj.labels);
  }

  async deleteEntity(tenantId: string, id: string): Promise<boolean> {
    const rows = await this.run(
      `MATCH (n:Entity {tenant_id: $tenantId, id: $id}) DETACH DELETE n RETURN count(n) AS deleted`,
      { tenantId, id },
    );
    return Number(rows[0]?.["deleted"] ?? 0) > 0;
  }

  // ─── Relationship CRUD ───

  async createRelationship(
    tenantId: string,
    fromId: string,
    toId: string,
    type: RelationshipType,
    weight = 0.5,
    properties: Record<string, unknown> = {},
    provenance?: { source_session?: string; source_transcript?: string; source_type?: string; source_tenant?: string },
    validAt?: string,
  ): Promise<RelationshipEdge> {
    const now = new Date().toISOString();
    const supersede = validAt !== undefined && validAt !== null;
    const supersedeAt = validAt ?? now;
    const allProps = {
      ...properties,
      tenant_id: tenantId, // edges carry the tenant of the relationship for audit/export
      ...(provenance?.source_session && { source_session: provenance.source_session }),
      ...(provenance?.source_transcript && { source_transcript: provenance.source_transcript }),
      ...(provenance?.source_type && { source_type: provenance.source_type }),
      ...(provenance?.source_tenant && { source_tenant: provenance.source_tenant }),
    };

    // Both endpoints must belong to the same tenant — cross-tenant edges are
    // disallowed at this layer (the data model assumes per-tenant graphs).
    const rows = await this.run(
      `
      MATCH (a:Entity {tenant_id: $tenantId, id: $fromId})
      MATCH (b:Entity {tenant_id: $tenantId, id: $toId})

      WITH a, b
      OPTIONAL MATCH (a)-[old:\`${type}\`]->(other:Entity)
      WHERE $supersede = true
        AND other.id <> $toId
        AND old.invalid_at IS NULL
      SET old.invalid_at = datetime($supersedeAt)

      WITH a, b
      MERGE (a)-[r:\`${type}\`]->(b)
      ON CREATE SET
        r.weight = $weight,
        r.last_confirmed = datetime($now),
        r.ingested_at = datetime($now),
        r.valid_at = CASE WHEN $validAt IS NOT NULL THEN datetime($validAt) ELSE null END,
        r += $allProps
      ON MATCH SET
        r.weight = CASE
          WHEN $weight > r.weight THEN $weight
          ELSE r.weight + 0.05
        END,
        r.last_confirmed = datetime($now),
        r.valid_at = CASE WHEN $validAt IS NOT NULL THEN datetime($validAt) ELSE r.valid_at END,
        r += $allProps
      RETURN r, a.id AS fromId, b.id AS toId, type(r) AS relType
      `,
      { tenantId, fromId, toId, weight, now, allProps, supersede, supersedeAt, validAt: validAt ?? null },
    );
    const row = rows[0];
    if (!row) {
      throw new Error(`Failed to create relationship: entities ${fromId} or ${toId} not found in tenant ${tenantId}`);
    }
    const relObj = row["r"] as { type: string; properties: Record<string, unknown> };
    return recordToEdge(relObj.properties, String(row["relType"]), String(row["fromId"]), String(row["toId"]));
  }

  async getRelationships(tenantId: string, entityId: string, direction: "in" | "out" | "both" = "both"): Promise<RelationshipEdge[]> {
    const dirClause =
      direction === "out"
        ? "(n)-[r]->(m)"
        : direction === "in"
          ? "(m)-[r]->(n)"
          : "(n)-[r]-(m)";

    const rows = await this.run(
      `
      MATCH ${dirClause}
      WHERE n.tenant_id = $tenantId AND m.tenant_id = $tenantId
        AND n.id = $entityId AND n:Entity AND m:Entity
      RETURN r, type(r) AS relType,
             CASE WHEN startNode(r) = n THEN n.id ELSE m.id END AS fromId,
             CASE WHEN startNode(r) = n THEN m.id ELSE n.id END AS toId
      `,
      { tenantId, entityId },
    );
    return rows.map((row) => {
      const relObj = row["r"] as { type: string; properties: Record<string, unknown> };
      return recordToEdge(relObj.properties, String(row["relType"]), String(row["fromId"]), String(row["toId"]));
    });
  }

  // ─── Weight Operations ───

  async boost(
    tenantId: string,
    fromId: string,
    toId: string,
    type: RelationshipType,
    amount?: number,
  ): Promise<{ previous_weight: number; new_weight: number }> {
    const config = getConfig();
    const boostAmount = amount ?? config.weights.boost_on_confirm;
    const rows = await this.run(
      `
      MATCH (a:Entity {tenant_id: $tenantId, id: $fromId})-[r:\`${type}\`]->(b:Entity {tenant_id: $tenantId, id: $toId})
      WITH r, r.weight AS old_weight
      SET r.weight = CASE WHEN r.weight + $amount > 1.0 THEN 1.0 ELSE r.weight + $amount END,
          r.last_confirmed = datetime()
      RETURN old_weight, r.weight AS new_weight
      `,
      { tenantId, fromId, toId, amount: boostAmount },
    );
    const row = rows[0];
    if (!row) throw new Error(`Edge not found: ${fromId} -[${type}]-> ${toId} in tenant ${tenantId}`);
    return {
      previous_weight: Number(row["old_weight"]),
      new_weight: Number(row["new_weight"]),
    };
  }

  async weaken(
    tenantId: string,
    fromId: string,
    toId: string,
    type: RelationshipType,
    amount?: number,
  ): Promise<{ previous_weight: number; new_weight: number }> {
    const config = getConfig();
    const weakenAmount = amount ?? config.weights.weaken_on_correct;
    const rows = await this.run(
      `
      MATCH (a:Entity {tenant_id: $tenantId, id: $fromId})-[r:\`${type}\`]->(b:Entity {tenant_id: $tenantId, id: $toId})
      WITH r, r.weight AS old_weight
      SET r.weight = CASE WHEN r.weight - $amount < 0.0 THEN 0.0 ELSE r.weight - $amount END,
          r.last_confirmed = datetime()
      RETURN old_weight, r.weight AS new_weight
      `,
      { tenantId, fromId, toId, amount: weakenAmount },
    );
    const row = rows[0];
    if (!row) throw new Error(`Edge not found: ${fromId} -[${type}]-> ${toId} in tenant ${tenantId}`);
    return {
      previous_weight: Number(row["old_weight"]),
      new_weight: Number(row["new_weight"]),
    };
  }

  // ─── Query / Traversal ───

  async query(
    tenantId: string,
    entities: string[],
    options: {
      entity_types?: EntityType[];
      max_hops?: number;
      min_weight?: number;
      limit?: number;
      project_context?: string;
      current_only?: boolean;
    } = {},
  ): Promise<QueryResult> {
    const config = getConfig();
    const maxHops = options.max_hops ?? config.query.default_max_hops;
    const minWeight = options.min_weight ?? config.query.default_min_weight;
    const limit = options.limit ?? config.query.default_limit;
    const currentOnly = options.current_only ?? true;

    // First resolve entity names to IDs via full-text search, scoped to tenant.
    // The fulltext index is global, so we filter results to the tenant's nodes.
    const entityIds: string[] = [];
    for (const name of entities) {
      const searchRows = await this.run(
        `
        CALL db.index.fulltext.queryNodes('entity_names', $name)
        YIELD node, score
        WHERE node.tenant_id = $tenantId
        RETURN node.id AS id, score
        ORDER BY score DESC LIMIT 1
        `,
        { tenantId, name },
      );
      if (searchRows.length > 0) {
        entityIds.push(String(searchRows[0]["id"]));
      }
    }

    if (entityIds.length === 0) {
      return { nodes: [], edges: [], source_files: [] };
    }

    // Traverse from resolved entities — restrict the entire path to nodes in
    // this tenant so we cannot cross into another tenant's subgraph even via
    // a shared edge id collision.
    const validityFilter = currentOnly ? "AND rel.invalid_at IS NULL" : "";
    const typeFilter =
      options.entity_types && options.entity_types.length > 0
        ? `AND ANY(label IN labels(m) WHERE label IN $entityTypes)`
        : "";

    const rows = await this.run(
      `
      UNWIND $entityIds AS startId
      MATCH (start:Entity {tenant_id: $tenantId, id: startId})
      // *0..N includes the seed itself (zero-length path). Without this the
      // entity you actually asked about never appears in its own query result.
      MATCH path = (start)-[*0..${maxHops}]-(m:Entity)
      WHERE m.tenant_id = $tenantId
        AND ALL(node IN nodes(path) WHERE node.tenant_id = $tenantId)
        AND ALL(rel IN relationships(path) WHERE rel.weight >= $minWeight ${validityFilter})
        ${typeFilter}
      WITH DISTINCT m, relationships(path) AS rels, start
      RETURN m, labels(m) AS labels,
             [rel IN rels | {
               props: properties(rel),
               type: type(rel),
               fromId: startNode(rel).id,
               toId: endNode(rel).id
             }] AS edgeData
      LIMIT $limit
      `,
      {
        tenantId,
        entityIds,
        minWeight,
        limit,
        ...(options.entity_types ? { entityTypes: options.entity_types } : {}),
      },
    );

    const nodeMap = new Map<string, EntityNode>();
    const edgeMap = new Map<string, RelationshipEdge>();
    const sourceFiles = new Set<string>();

    for (const row of rows) {
      const nodeObj = row["m"] as { labels: string[]; properties: Record<string, unknown> };
      const node = recordToEntity(nodeObj.properties, nodeObj.labels);
      nodeMap.set(node.id, node);
      if (node.source_file) sourceFiles.add(node.source_file);

      const edgeData = row["edgeData"] as Array<{
        props: Record<string, unknown>;
        type: string;
        fromId: string;
        toId: string;
      }>;
      for (const ed of edgeData) {
        const key = `${ed.fromId}-${ed.type}-${ed.toId}`;
        if (!edgeMap.has(key)) {
          const edge = recordToEdge(ed.props, ed.type, ed.fromId, ed.toId);
          if (options.project_context) {
            edge.effective_weight = edge.weight;
          }
          edgeMap.set(key, edge);
        }
      }
    }

    // Apply project-context affinity (scoped to tenant)
    if (options.project_context) {
      const affinityRows = await this.run(
        `
        MATCH (proj:Project {tenant_id: $tenantId})
        WHERE proj.directory CONTAINS $projectContext OR proj.name = $projectContext
        MATCH (proj)-[*1..2]-(related:Entity)
        WHERE related.tenant_id = $tenantId
        RETURN DISTINCT related.id AS id
        `,
        { tenantId, projectContext: options.project_context },
      );
      const projectRelatedIds = new Set(affinityRows.map((r) => String(r["id"])));

      for (const edge of edgeMap.values()) {
        const fromRelated = projectRelatedIds.has(edge.from);
        const toRelated = projectRelatedIds.has(edge.to);
        if (fromRelated || toRelated) {
          edge.effective_weight = edge.weight * config.affinity.hop_1_multiplier;
        } else {
          edge.effective_weight = edge.weight;
        }
      }
    }

    return {
      nodes: Array.from(nodeMap.values()),
      edges: Array.from(edgeMap.values()).sort(
        (a, b) => (b.effective_weight ?? b.weight) - (a.effective_weight ?? a.weight),
      ),
      source_files: Array.from(sourceFiles),
    };
  }

  // ─── Entity Search ───

  async searchEntities(
    tenantId: string,
    options: {
      search?: string;
      type?: EntityType;
      min_confidence?: number;
      sort_by?: "confidence" | "last_seen" | "name";
      limit?: number;
    } = {},
  ): Promise<{ entities: EntityNode[]; total: number }> {
    const limit = options.limit ?? 20;
    let cypher: string;
    let params: Record<string, unknown>;

    if (options.search) {
      const typeFilter = options.type ? `AND ANY(l IN labels(node) WHERE l = $type)` : "";
      const confFilter = options.min_confidence != null ? `AND node.confidence >= $minConf` : "";
      cypher = `
        CALL db.index.fulltext.queryNodes('entity_names', $search)
        YIELD node, score
        WHERE node:Entity AND node.tenant_id = $tenantId ${typeFilter} ${confFilter}
        WITH node, score
        OPTIONAL MATCH (node)-[r]-(other:Entity {tenant_id: $tenantId})
        WITH node, labels(node) AS labels, count(r) AS edge_count, score
        RETURN node, labels, edge_count
        ORDER BY score DESC
        LIMIT $limit
      `;
      params = {
        tenantId,
        search: options.search,
        limit,
        ...(options.type ? { type: options.type } : {}),
        ...(options.min_confidence != null ? { minConf: options.min_confidence } : {}),
      };
    } else {
      const typeMatch = options.type ? `(n:\`${options.type}\` {tenant_id: $tenantId})` : "(n:Entity {tenant_id: $tenantId})";
      const confFilter = options.min_confidence != null ? `WHERE n.confidence >= $minConf` : "";
      const orderBy =
        options.sort_by === "last_seen"
          ? "n.last_seen DESC"
          : options.sort_by === "name"
            ? "n.name ASC"
            : "n.confidence DESC";

      cypher = `
        MATCH ${typeMatch}
        ${confFilter}
        OPTIONAL MATCH (n)-[r]-(other:Entity {tenant_id: $tenantId})
        WITH n, labels(n) AS labels, count(r) AS edge_count
        RETURN n AS node, labels, edge_count
        ORDER BY ${orderBy}
        LIMIT $limit
      `;
      params = {
        tenantId,
        limit,
        ...(options.min_confidence != null ? { minConf: options.min_confidence } : {}),
      };
    }

    const rows = await this.run(cypher, params);

    const entities = rows.map((row) => {
      const nodeObj = row["node"] as { labels: string[]; properties: Record<string, unknown> };
      const entity = recordToEntity(nodeObj.properties, nodeObj.labels);
      (entity as EntityNode & { edge_count?: number }).edge_count = Number(row["edge_count"] ?? 0);
      return entity;
    });

    // Tenant-scoped total count
    const countCypher = options.type
      ? `MATCH (n:\`${options.type}\` {tenant_id: $tenantId}) RETURN count(n) AS total`
      : `MATCH (n:Entity {tenant_id: $tenantId}) RETURN count(n) AS total`;
    const countRows = await this.run(countCypher, { tenantId });
    const totalNum = Number(countRows[0]?.["total"] ?? 0);

    return { entities, total: totalNum };
  }

  // ─── Contradictions ───

  async findContradictions(tenantId: string, includeResolved = false): Promise<{
    contradictions: Array<{
      node_a: { id: string; type: string; name: string };
      node_b: { id: string; type: string; name: string };
      description: string;
      detected_date: string;
      resolved: boolean;
    }>;
    count: number;
  }> {
    const resolvedFilter = includeResolved ? "" : "AND r.resolved = false";
    const rows = await this.run(
      `
      MATCH (a:Entity {tenant_id: $tenantId})-[r:CONTRADICTS]->(b:Entity {tenant_id: $tenantId})
      WHERE 1=1 ${resolvedFilter}
      RETURN a.id AS aId, labels(a) AS aLabels, a.name AS aName,
             b.id AS bId, labels(b) AS bLabels, b.name AS bName,
             r.description AS description, r.detected_date AS detected_date,
             r.resolved AS resolved
      ORDER BY r.detected_date DESC
      `,
      { tenantId },
    );

    const contradictions = rows.map((row) => ({
      node_a: {
        id: String(row["aId"]),
        type: (row["aLabels"] as string[]).find((l) => l !== "Entity") ?? "Entity",
        name: String(row["aName"]),
      },
      node_b: {
        id: String(row["bId"]),
        type: (row["bLabels"] as string[]).find((l) => l !== "Entity") ?? "Entity",
        name: String(row["bName"]),
      },
      description: String(row["description"] ?? ""),
      detected_date: toISOString(row["detected_date"]),
      resolved: Boolean(row["resolved"]),
    }));

    return { contradictions, count: contradictions.length };
  }

  // ─── Decay ───

  async applyDecay(tenantId: string, dryRun = false): Promise<{
    nodes_decayed: number;
    edges_decayed: number;
    nodes_flagged_for_pruning: number;
  }> {
    const config = getConfig();
    let totalNodesDecayed = 0;
    let totalEdgesDecayed = 0;

    if (dryRun) {
      for (const [type] of Object.entries(config.decay.rates)) {
        const rows = await this.run(
          `
          MATCH (n:\`${type}\` {tenant_id: $tenantId})
          WHERE n.last_seen < datetime() - duration('P1D')
            AND (n.subtype IS NULL OR n.subtype <> 'rule')
          RETURN count(n) AS count
          `,
          { tenantId },
        );
        totalNodesDecayed += Number(rows[0]?.["count"] ?? 0);
      }
    } else {
      for (const [type, rate] of Object.entries(config.decay.rates)) {
        const rows = await this.run(
          `
          MATCH (n:\`${type}\` {tenant_id: $tenantId})
          WHERE n.last_seen < datetime() - duration('P1D')
            AND (n.subtype IS NULL OR n.subtype <> 'rule')
          // duration.inDays() forces an all-days representation; using .days
          // on the normalized duration.between() would drop the months
          // component (30 days back → "1 month + 0 days" → 0-day decay).
          // Nodes with subtype='rule' (permanent preferences) are exempt
          // from decay entirely — they only change on explicit user statement.
          WITH n, n.confidence * ($rate ^ duration.inDays(n.last_seen, datetime()).days) AS new_conf
          SET n.confidence = CASE WHEN new_conf < 0.01 THEN 0.01 ELSE new_conf END
          RETURN count(n) AS decayed
          `,
          { tenantId, rate },
        );
        totalNodesDecayed += Number(rows[0]?.["decayed"] ?? 0);
      }

      // Decay edges (both endpoints must be in tenant). Edges touching a
      // subtype='rule' node on either side are exempt — otherwise a rule's
      // anchor PREFERS edge would slowly decay and orphan the rule.
      const edgeRows = await this.run(
        `
        MATCH (a:Entity {tenant_id: $tenantId})-[r]->(b:Entity {tenant_id: $tenantId})
        WHERE r.last_confirmed < datetime() - duration('P1D')
          AND r.weight IS NOT NULL
          AND (a.subtype IS NULL OR a.subtype <> 'rule')
          AND (b.subtype IS NULL OR b.subtype <> 'rule')
        WITH r, r.weight * ($rate ^ duration.inDays(r.last_confirmed, datetime()).days) AS new_weight
        SET r.weight = CASE WHEN new_weight < 0.01 THEN 0.01 ELSE new_weight END
        RETURN count(r) AS decayed
        `,
        { tenantId, rate: config.decay.edge_rate },
      );
      totalEdgesDecayed = Number(edgeRows[0]?.["decayed"] ?? 0);
    }

    // Count nodes flagged for pruning (tenant-scoped). Rule-subtype nodes
    // are pinned at confidence 1.0 so they'd never cross the threshold,
    // but we filter them explicitly for clarity and defense-in-depth.
    const pruneRows = await this.run(
      `
      MATCH (n:Entity {tenant_id: $tenantId})
      WHERE n.confidence < $threshold
        AND (n.subtype IS NULL OR n.subtype <> 'rule')
      OPTIONAL MATCH (n)-[r]-(other:Entity {tenant_id: $tenantId})
      WITH n, max(r.weight) AS max_edge_weight
      WHERE max_edge_weight IS NULL OR max_edge_weight < $edgeThreshold
      RETURN count(n) AS flagged
      `,
      {
        tenantId,
        threshold: config.decay.prune_node_threshold,
        edgeThreshold: config.decay.prune_edge_threshold,
      },
    );
    const nodesFlagged = Number(pruneRows[0]?.["flagged"] ?? 0);

    return {
      nodes_decayed: totalNodesDecayed,
      edges_decayed: totalEdgesDecayed,
      nodes_flagged_for_pruning: nodesFlagged,
    };
  }

  // ─── Batch Operations (for dream process) ───

  /** Resolve a batch reference (rel.from / rel.to) to an actual entity id within
   *  a tenant. Resolution order:
   *    1. localId in this batch's idMap
   *    2. Existing entity in this tenant by exact name (case-insensitive)
   *    3. Slugified id lookup within this tenant
   *    4. null (unresolvable)
   */
  private async resolveBatchRef(tenantId: string, idMap: Map<string, string>, ref: string): Promise<string | null> {
    const fromBatch = idMap.get(ref);
    if (fromBatch) return fromBatch;

    // Try exact name (case-insensitive) within tenant
    const byName = await this.run(
      `MATCH (n:Entity {tenant_id: $tenantId}) WHERE toLower(n.name) = toLower($name) RETURN n.id AS id LIMIT 1`,
      { tenantId, name: ref },
    );
    if (byName.length > 0) return String(byName[0]["id"]);

    // Try slugified id within tenant
    const slug = ref.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (slug) {
      const bySlug = await this.run(
        `MATCH (n:Entity {tenant_id: $tenantId, id: $id}) RETURN n.id AS id LIMIT 1`,
        { tenantId, id: slug },
      );
      if (bySlug.length > 0) return String(bySlug[0]["id"]);
    }

    return null;
  }

  async batchRelate(tenantId: string, batch: BatchInput): Promise<{
    entities_created: number;
    entities_merged: number;
    edges_created: number;
    edges_strengthened: number;
    edges_failed: number;
    failed_refs: Array<{ from: string; to: string; relation: string; reason: string }>;
  }> {
    const now = new Date().toISOString();
    let entitiesCreated = 0;
    let entitiesMerged = 0;

    // Resolve localId → real id mapping
    const idMap = new Map<string, string>();

    // Pre-compute embeddings for all batch entity names in parallel.
    // 10ms per embed × N is too slow sequentially for big batches; parallelize.
    const embeddings = await Promise.all(
      batch.entities.map(async (entity) => {
        try {
          return await embedText(buildEmbedText(entity.name, entity.type, entity.properties));
        } catch { return null; }
      }),
    );

    // Create/merge all entities (tenant_id is part of the merge key)
    for (let i = 0; i < batch.entities.length; i++) {
      const entity = batch.entities[i];
      const id = entity.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      idMap.set(entity.localId, id);

      const rows = await this.run(
        `
        MERGE (n:Entity:\`${entity.type}\` {tenant_id: $tenantId, id: $id})
        ON CREATE SET
          n.name = $name,
          n.confidence = 0.5,
          n.times_mentioned = 1,
          n.first_seen = datetime($now),
          n.last_seen = datetime($now),
          n.embedding = $embedding
        ON MATCH SET
          n.times_mentioned = n.times_mentioned + 1,
          n.last_seen = datetime($now)
        SET n += $properties
        RETURN CASE WHEN n.times_mentioned = 1 THEN 'created' ELSE 'merged' END AS action
        `,
        {
          tenantId,
          id,
          name: entity.name,
          now,
          properties: entity.properties ?? {},
          embedding: embeddings[i],
        },
      );
      const action = rows[0]?.["action"];
      if (action === "created") entitiesCreated++;
      else entitiesMerged++;
    }

    // Create/merge all relationships
    let edgesCreated = 0;
    let edgesStrengthened = 0;
    let edgesFailed = 0;
    const failedRefs: Array<{ from: string; to: string; relation: string; reason: string }> = [];

    for (const rel of batch.relations) {
      const fromId = await this.resolveBatchRef(tenantId, idMap, rel.from);
      const toId = await this.resolveBatchRef(tenantId, idMap, rel.to);

      if (!fromId || !toId) {
        edgesFailed++;
        failedRefs.push({
          from: rel.from,
          to: rel.to,
          relation: rel.relation,
          reason: !fromId
            ? `from "${rel.from}" did not resolve to any entity in tenant ${tenantId} (not in batch, no name match, no id match)`
            : `to "${rel.to}" did not resolve to any entity in tenant ${tenantId} (not in batch, no name match, no id match)`,
        });
        continue;
      }

      const batchValidAt = rel.valid_at ?? null;
      const allProps: Record<string, unknown> = {
        ...(rel.properties ?? {}),
        tenant_id: tenantId,
        ...(rel.evidence && { evidence: rel.evidence }),
        ...(batch.source_session && { source_session: batch.source_session }),
        ...(batch.source_transcript && { source_transcript: batch.source_transcript }),
        ...(batch.source_type && { source_type: batch.source_type }),
      };

      const rows = await this.run(
        `
        MATCH (a:Entity {tenant_id: $tenantId, id: $fromId})
        MATCH (b:Entity {tenant_id: $tenantId, id: $toId})
        MERGE (a)-[r:\`${rel.relation}\`]->(b)
        ON CREATE SET
          r.weight = $weight,
          r.last_confirmed = datetime($now),
          r.ingested_at = datetime($now),
          r.valid_at = CASE WHEN $batchValidAt IS NOT NULL THEN datetime($batchValidAt) ELSE null END,
          r += $allProps
        ON MATCH SET
          r.weight = CASE
            WHEN $weight > r.weight THEN $weight
            ELSE r.weight + 0.05
          END,
          r.last_confirmed = datetime($now),
          r.valid_at = CASE WHEN $batchValidAt IS NOT NULL THEN datetime($batchValidAt) ELSE r.valid_at END,
          r += $allProps
        RETURN CASE WHEN r.weight = $weight THEN 'created' ELSE 'strengthened' END AS action
        `,
        { tenantId, fromId, toId, weight: rel.weight, now, allProps, batchValidAt },
      );
      const action = rows[0]?.["action"];
      if (!action) {
        edgesFailed++;
        // Both endpoints resolved but the MERGE returned no rows — unexpected.
        failedRefs.push({
          from: rel.from,
          to: rel.to,
          relation: rel.relation,
          reason: `MERGE returned no rows for resolved ids ${fromId} -> ${toId} (unexpected)`,
        });
      } else if (action === "created") {
        edgesCreated++;
      } else {
        edgesStrengthened++;
      }
    }

    return {
      entities_created: entitiesCreated,
      entities_merged: entitiesMerged,
      edges_created: edgesCreated,
      edges_strengthened: edgesStrengthened,
      edges_failed: edgesFailed,
      failed_refs: failedRefs,
    };
  }

  // ─── Raw Cypher (read-only) ───

  async executeCypher(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<{ results: Record<string, unknown>[]; result_count: number; execution_time_ms: number }> {
    const start = Date.now();
    const rows = await this.runReadOnly(cypher, params);
    const elapsed = Date.now() - start;
    return { results: rows, result_count: rows.length, execution_time_ms: elapsed };
  }

  // ─── Stats ───

  async getStats(tenantId: string): Promise<{
    nodes: { total: number; by_type: Record<string, number> };
    edges: { total: number; by_type: Record<string, number> };
    health: {
      avg_weight: number;
      orphaned_nodes: number;
      unresolved_contradictions: number;
      stale_nodes: number;
    };
  }> {
    // Node counts by type (tenant-scoped)
    const nodeRows = await this.run(`
      MATCH (n:Entity {tenant_id: $tenantId})
      WITH labels(n) AS labels, count(n) AS count
      UNWIND labels AS label
      WITH label, sum(count) AS total WHERE label <> 'Entity'
      RETURN label, total ORDER BY total DESC
    `, { tenantId });
    const byType: Record<string, number> = {};
    let totalNodes = 0;
    for (const row of nodeRows) {
      const count = Number(row["total"] ?? 0);
      byType[String(row["label"])] = count;
      totalNodes += count;
    }

    // Edge counts by type (tenant-scoped — both endpoints in tenant)
    const edgeRows = await this.run(`
      MATCH (a:Entity {tenant_id: $tenantId})-[r]->(b:Entity {tenant_id: $tenantId})
      RETURN type(r) AS type, count(r) AS count ORDER BY count DESC
    `, { tenantId });
    const edgeByType: Record<string, number> = {};
    let totalEdges = 0;
    for (const row of edgeRows) {
      const count = Number(row["count"] ?? 0);
      edgeByType[String(row["type"])] = count;
      totalEdges += count;
    }

    // Health metrics (tenant-scoped)
    const healthRows = await this.run(`
      OPTIONAL MATCH (a:Entity {tenant_id: $tenantId})-[r]->(b:Entity {tenant_id: $tenantId})
      WITH avg(r.weight) AS avgWeight
      OPTIONAL MATCH (orphan:Entity {tenant_id: $tenantId})
      WHERE NOT (orphan)-[]-()
      WITH avgWeight, count(orphan) AS orphanCount
      OPTIONAL MATCH (a2:Entity {tenant_id: $tenantId})-[c:CONTRADICTS]->(b2:Entity {tenant_id: $tenantId})
      WHERE c.resolved = false
      WITH avgWeight, orphanCount, count(c) AS contradictions
      OPTIONAL MATCH (stale:Entity {tenant_id: $tenantId})
      WHERE stale.confidence < 0.2 AND stale.last_seen < datetime() - duration('P90D')
      RETURN avgWeight, orphanCount, contradictions, count(stale) AS staleCount
    `, { tenantId });
    const hRow = healthRows[0];
    const avgWeight = hRow ? Number(hRow["avgWeight"] ?? 0) : 0;
    const orphaned = Number(hRow?.["orphanCount"] ?? 0);
    const contradictions = Number(hRow?.["contradictions"] ?? 0);
    const staleNodes = Number(hRow?.["staleCount"] ?? 0);

    return {
      nodes: { total: totalNodes, by_type: byType },
      edges: { total: totalEdges, by_type: edgeByType },
      health: {
        avg_weight: Math.round(avgWeight * 100) / 100,
        orphaned_nodes: orphaned,
        unresolved_contradictions: contradictions,
        stale_nodes: staleNodes,
      },
    };
  }

  // ─── Prune ───

  async prune(
    tenantId: string,
    mode: "preview" | "execute" = "preview",
    options: {
      node_threshold?: number;
      edge_threshold?: number;
      include_orphans?: boolean;
      max_age_days?: number;
    } = {},
  ): Promise<{
    mode: string;
    nodes_pruned: number;
    edges_pruned: number;
    details: Array<{ action: string; id?: string; type?: string; from?: string; to?: string }>;
  }> {
    const config = getConfig();
    const nodeThreshold = options.node_threshold ?? config.decay.prune_node_threshold;
    const edgeThreshold = options.edge_threshold ?? config.decay.prune_edge_threshold;
    const includeOrphans = options.include_orphans ?? true;
    const maxAgeDays = options.max_age_days ?? config.decay.prune_orphan_days;

    // Find pruneable nodes (tenant-scoped). Rule-subtype nodes are
    // permanent and exempt from pruning regardless of confidence.
    const nodeRows = await this.run(
      `
      MATCH (n:Entity {tenant_id: $tenantId})
      WHERE n.confidence < $nodeThreshold
        AND (n.subtype IS NULL OR n.subtype <> 'rule')
      OPTIONAL MATCH (n)-[r]-(other:Entity {tenant_id: $tenantId})
      WITH n, labels(n) AS labels, max(r.weight) AS maxEdge
      WHERE maxEdge IS NULL OR maxEdge < $edgeThreshold
      RETURN n.id AS id, n.name AS name,
             [l IN labels WHERE l <> 'Entity'][0] AS type,
             n.confidence AS confidence
      `,
      { tenantId, nodeThreshold, edgeThreshold },
    );

    // Find orphans if requested. Rule-subtype nodes are exempt even if
    // they become disconnected — a stranded rule should be reconnected,
    // not deleted.
    let orphanRows: Row[] = [];
    if (includeOrphans) {
      orphanRows = await this.run(
        `
        MATCH (n:Entity {tenant_id: $tenantId})
        WHERE NOT (n)-[]-()
          AND n.last_seen < datetime() - duration({days: $maxAgeDays})
          AND n.confidence >= $nodeThreshold
          AND (n.subtype IS NULL OR n.subtype <> 'rule')
        RETURN n.id AS id, n.name AS name,
               [l IN labels(n) WHERE l <> 'Entity'][0] AS type,
               n.confidence AS confidence
        `,
        { tenantId, maxAgeDays, nodeThreshold },
      );
    }

    // Find pruneable edges (both endpoints in tenant). Edges touching a
    // rule-subtype node on either side are exempt.
    const edgeRows = await this.run(
      `
      MATCH (a:Entity {tenant_id: $tenantId})-[r]->(b:Entity {tenant_id: $tenantId})
      WHERE r.weight < $edgeThreshold
        AND (a.subtype IS NULL OR a.subtype <> 'rule')
        AND (b.subtype IS NULL OR b.subtype <> 'rule')
      RETURN a.id AS fromId, b.id AS toId, type(r) AS relType, r.weight AS weight
      `,
      { tenantId, edgeThreshold },
    );

    const allNodeRows = [...nodeRows, ...orphanRows];

    if (mode === "preview") {
      const details: Array<{ action: string; id?: string; type?: string; from?: string; to?: string }> = [];
      for (const row of allNodeRows) {
        details.push({ action: "would_delete_node", id: String(row["id"]), type: String(row["type"]) });
      }
      for (const row of edgeRows) {
        details.push({ action: "would_delete_edge", from: String(row["fromId"]), to: String(row["toId"]), type: String(row["relType"]) });
      }
      return { mode: "preview", nodes_pruned: allNodeRows.length, edges_pruned: edgeRows.length, details };
    }

    // Execute mode — actually delete (tenant-scoped)
    const details: Array<{ action: string; id?: string; type?: string; from?: string; to?: string }> = [];

    // Delete edges first
    const edgeDeleteRows = await this.run(
      `
      MATCH (a:Entity {tenant_id: $tenantId})-[r]->(b:Entity {tenant_id: $tenantId})
      WHERE r.weight < $edgeThreshold
      DELETE r
      RETURN count(r) AS deleted
      `,
      { tenantId, edgeThreshold },
    );

    // Delete nodes (tenant-scoped)
    const nodeIds = allNodeRows.map((r) => String(r["id"]));
    let nodesDeleted = 0;
    if (nodeIds.length > 0) {
      const nodeDeleteRows = await this.run(
        `
        MATCH (n:Entity {tenant_id: $tenantId})
        WHERE n.id IN $nodeIds
        DETACH DELETE n
        RETURN count(n) AS deleted
        `,
        { tenantId, nodeIds },
      );
      nodesDeleted = Number(nodeDeleteRows[0]?.["deleted"] ?? 0);
    }

    const edgesDeleted = Number(edgeDeleteRows[0]?.["deleted"] ?? 0);

    return { mode: "executed", nodes_pruned: nodesDeleted, edges_pruned: edgesDeleted, details };
  }

  // ─── Unmerge ───

  async unmerge(
    tenantId: string,
    entityId: string,
    newEntityName: string,
    newEntityType: EntityType,
    edgesToMove: Array<{ other_entity_id: string; relation_type: RelationshipType; direction: "in" | "out" }>,
    reason: string,
  ): Promise<{
    original: { id: string; remaining_edges: number };
    new_entity: { id: string; name: string; moved_edges: number };
  }> {
    const newId = newEntityName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const now = new Date().toISOString();

    // Create the new entity in the same tenant
    await this.run(
      `
      CREATE (n:Entity:\`${newEntityType}\` {
        tenant_id: $tenantId,
        id: $newId,
        name: $newEntityName,
        confidence: 0.5,
        times_mentioned: 1,
        first_seen: datetime($now),
        last_seen: datetime($now)
      })
      `,
      { tenantId, newId, newEntityName, now },
    );

    // Move specified edges (all participants must be in the same tenant)
    let movedCount = 0;
    for (const edge of edgesToMove) {
      if (edge.direction === "out") {
        const rows = await this.run(
          `
          MATCH (original:Entity {tenant_id: $tenantId, id: $entityId})-[r:\`${edge.relation_type}\`]->(other:Entity {tenant_id: $tenantId, id: $otherId})
          MATCH (newNode:Entity {tenant_id: $tenantId, id: $newId})
          WITH r, newNode, other, properties(r) AS props
          CREATE (newNode)-[newR:\`${edge.relation_type}\`]->(other)
          SET newR = props
          DELETE r
          RETURN count(newR) AS moved
          `,
          { tenantId, entityId, otherId: edge.other_entity_id, newId },
        );
        movedCount += Number(rows[0]?.["moved"] ?? 0);
      } else {
        const rows = await this.run(
          `
          MATCH (other:Entity {tenant_id: $tenantId, id: $otherId})-[r:\`${edge.relation_type}\`]->(original:Entity {tenant_id: $tenantId, id: $entityId})
          MATCH (newNode:Entity {tenant_id: $tenantId, id: $newId})
          WITH r, newNode, other, properties(r) AS props
          CREATE (other)-[newR:\`${edge.relation_type}\`]->(newNode)
          SET newR = props
          DELETE r
          RETURN count(newR) AS moved
          `,
          { tenantId, entityId, otherId: edge.other_entity_id, newId },
        );
        movedCount += Number(rows[0]?.["moved"] ?? 0);
      }
    }

    // Count remaining edges on original (tenant-scoped)
    const remainingRows = await this.run(
      `MATCH (n:Entity {tenant_id: $tenantId, id: $entityId})-[r]-() RETURN count(r) AS remaining`,
      { tenantId, entityId },
    );
    const remainingEdges = Number(remainingRows[0]?.["remaining"] ?? 0);

    return {
      original: { id: entityId, remaining_edges: remainingEdges },
      new_entity: { id: newId, name: newEntityName, moved_edges: movedCount },
    };
  }

  // ─── Merge (inverse of unmerge) ───
  //
  // Consolidates source into target: moves source's edges to target (deduplicating
  // same-type edges to the same neighbor by max-weight), adopts source's properties
  // for keys target doesn't have, deletes source. Edges directly between source and
  // target (which would become self-loops) are dropped. Embedding on target is
  // cleared so backfillEmbeddings() will re-derive it from the merged state.
  //
  // Pairs with unmerge() — they are inverses by intent. unmerge does not depend on
  // any state left behind by merge (no on-graph "merge_history" breadcrumbs); the
  // logs/merge-audit.jsonl trail is the only record of what happened.

  async merge(
    tenantId: string,
    sourceId: string,
    targetId: string,
    options: { dryRun?: boolean } = {},
  ): Promise<{
    source: { id: string; name: string; deleted: boolean };
    target: { id: string; name: string };
    edges_added: number;
    edges_consolidated: number;
    self_loops_dropped: number;
    properties_adopted: string[];
    dry_run: boolean;
  }> {
    if (sourceId === targetId) {
      throw new Error("Cannot merge an entity with itself");
    }

    // Verify both entities exist within the tenant
    const srcRows = await this.run(
      `MATCH (n:Entity {tenant_id: $tenantId, id: $sourceId}) RETURN n.name AS name, properties(n) AS props`,
      { tenantId, sourceId },
    );
    if (srcRows.length === 0) {
      throw new Error(`Source entity ${sourceId} not found in tenant ${tenantId}`);
    }
    const tgtRows = await this.run(
      `MATCH (n:Entity {tenant_id: $tenantId, id: $targetId}) RETURN n.name AS name, properties(n) AS props`,
      { tenantId, targetId },
    );
    if (tgtRows.length === 0) {
      throw new Error(`Target entity ${targetId} not found in tenant ${tenantId}`);
    }

    const sourceName = String(srcRows[0]?.["name"] ?? sourceId);
    const targetName = String(tgtRows[0]?.["name"] ?? targetId);

    // Dry-run: count what would change without mutating
    if (options.dryRun) {
      const outgoing = await this.run(
        `MATCH (s:Entity {tenant_id: $tenantId, id: $sourceId})-[r]->(o:Entity {tenant_id: $tenantId})
         WHERE o.id <> $targetId
         RETURN count(r) AS n`,
        { tenantId, sourceId, targetId },
      );
      const incoming = await this.run(
        `MATCH (o:Entity {tenant_id: $tenantId})-[r]->(s:Entity {tenant_id: $tenantId, id: $sourceId})
         WHERE o.id <> $targetId
         RETURN count(r) AS n`,
        { tenantId, sourceId, targetId },
      );
      const selfLoops = await this.run(
        `MATCH (s:Entity {tenant_id: $tenantId, id: $sourceId})-[r]-(t:Entity {tenant_id: $tenantId, id: $targetId})
         RETURN count(r) AS n`,
        { tenantId, sourceId, targetId },
      );
      const totalEdges = Number(outgoing[0]?.["n"] ?? 0) + Number(incoming[0]?.["n"] ?? 0);
      return {
        source: { id: sourceId, name: sourceName, deleted: false },
        target: { id: targetId, name: targetName },
        edges_added: totalEdges,           // upper bound — actual split between added vs consolidated requires execution
        edges_consolidated: 0,
        self_loops_dropped: Number(selfLoops[0]?.["n"] ?? 0),
        properties_adopted: [],
        dry_run: true,
      };
    }

    // Drop direct edges between source and target — they would become self-loops on target
    const selfLoopCountRows = await this.run(
      `MATCH (s:Entity {tenant_id: $tenantId, id: $sourceId})-[r]-(t:Entity {tenant_id: $tenantId, id: $targetId})
       RETURN count(r) AS n`,
      { tenantId, sourceId, targetId },
    );
    const selfLoopsDropped = Number(selfLoopCountRows[0]?.["n"] ?? 0);
    if (selfLoopsDropped > 0) {
      await this.run(
        `MATCH (s:Entity {tenant_id: $tenantId, id: $sourceId})-[r]-(t:Entity {tenant_id: $tenantId, id: $targetId})
         DELETE r`,
        { tenantId, sourceId, targetId },
      );
    }

    let edgesAdded = 0;
    let edgesConsolidated = 0;

    // Move outgoing edges (source -> other) to (target -> other)
    const outgoing = await this.run(
      `MATCH (s:Entity {tenant_id: $tenantId, id: $sourceId})-[r]->(o:Entity {tenant_id: $tenantId})
       RETURN type(r) AS rel, o.id AS otherId, properties(r) AS props`,
      { tenantId, sourceId },
    );
    for (const row of outgoing) {
      const rel = String(row["rel"]);
      const otherId = String(row["otherId"]);
      const props = (row["props"] as Record<string, unknown>) ?? {};
      const existing = await this.run(
        `MATCH (t:Entity {tenant_id: $tenantId, id: $targetId})-[r:\`${rel}\`]->(o:Entity {tenant_id: $tenantId, id: $otherId})
         RETURN r.weight AS weight LIMIT 1`,
        { tenantId, targetId, otherId },
      );
      if (existing.length > 0) {
        const newWeight = Math.max(Number(existing[0]?.["weight"] ?? 0), Number(props["weight"] ?? 0));
        await this.run(
          `MATCH (t:Entity {tenant_id: $tenantId, id: $targetId})-[r:\`${rel}\`]->(o:Entity {tenant_id: $tenantId, id: $otherId})
           SET r.weight = $newWeight, r.last_confirmed = datetime()`,
          { tenantId, targetId, otherId, newWeight },
        );
        edgesConsolidated++;
      } else {
        await this.run(
          `MATCH (t:Entity {tenant_id: $tenantId, id: $targetId}), (o:Entity {tenant_id: $tenantId, id: $otherId})
           CREATE (t)-[newR:\`${rel}\`]->(o)
           SET newR = $props`,
          { tenantId, targetId, otherId, props },
        );
        edgesAdded++;
      }
    }

    // Move incoming edges (other -> source) to (other -> target)
    const incoming = await this.run(
      `MATCH (o:Entity {tenant_id: $tenantId})-[r]->(s:Entity {tenant_id: $tenantId, id: $sourceId})
       RETURN type(r) AS rel, o.id AS otherId, properties(r) AS props`,
      { tenantId, sourceId },
    );
    for (const row of incoming) {
      const rel = String(row["rel"]);
      const otherId = String(row["otherId"]);
      const props = (row["props"] as Record<string, unknown>) ?? {};
      const existing = await this.run(
        `MATCH (o:Entity {tenant_id: $tenantId, id: $otherId})-[r:\`${rel}\`]->(t:Entity {tenant_id: $tenantId, id: $targetId})
         RETURN r.weight AS weight LIMIT 1`,
        { tenantId, targetId, otherId },
      );
      if (existing.length > 0) {
        const newWeight = Math.max(Number(existing[0]?.["weight"] ?? 0), Number(props["weight"] ?? 0));
        await this.run(
          `MATCH (o:Entity {tenant_id: $tenantId, id: $otherId})-[r:\`${rel}\`]->(t:Entity {tenant_id: $tenantId, id: $targetId})
           SET r.weight = $newWeight, r.last_confirmed = datetime()`,
          { tenantId, targetId, otherId, newWeight },
        );
        edgesConsolidated++;
      } else {
        await this.run(
          `MATCH (o:Entity {tenant_id: $tenantId, id: $otherId}), (t:Entity {tenant_id: $tenantId, id: $targetId})
           CREATE (o)-[newR:\`${rel}\`]->(t)
           SET newR = $props`,
          { tenantId, targetId, otherId, props },
        );
        edgesAdded++;
      }
    }

    // Adopt source's properties for keys target doesn't have. Reserved keys
    // (identity, embedding, lifecycle counters) are never copied.
    const RESERVED = new Set([
      "id", "tenant_id", "name", "embedding",
      "first_seen", "last_seen", "times_mentioned", "confidence",
    ]);
    const srcProps = (srcRows[0]?.["props"] as Record<string, unknown>) ?? {};
    const tgtProps = (tgtRows[0]?.["props"] as Record<string, unknown>) ?? {};
    const adopted: string[] = [];
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(srcProps)) {
      if (RESERVED.has(k)) continue;
      const existing = tgtProps[k];
      if (existing === undefined || existing === null) {
        patch[k] = v;
        adopted.push(k);
      }
    }

    // Update target: adopt patched properties, take max times_mentioned, refresh
    // last_seen, clear embedding so backfill regenerates from the merged state.
    const newTimesMentioned = Math.max(
      Number(srcProps["times_mentioned"] ?? 0),
      Number(tgtProps["times_mentioned"] ?? 0),
    );
    await this.run(
      `MATCH (t:Entity {tenant_id: $tenantId, id: $targetId})
       SET t += $patch,
           t.times_mentioned = $newTimesMentioned,
           t.last_seen = datetime(),
           t.embedding = null`,
      { tenantId, targetId, patch, newTimesMentioned },
    );

    // Delete source (DETACH catches any edges that slipped through)
    await this.run(
      `MATCH (s:Entity {tenant_id: $tenantId, id: $sourceId}) DETACH DELETE s`,
      { tenantId, sourceId },
    );

    return {
      source: { id: sourceId, name: sourceName, deleted: true },
      target: { id: targetId, name: targetName },
      edges_added: edgesAdded,
      edges_consolidated: edgesConsolidated,
      self_loops_dropped: selfLoopsDropped,
      properties_adopted: adopted,
      dry_run: false,
    };
  }

  // ─── Export ───

  async exportGraph(tenantId: string): Promise<{
    nodes: Record<string, unknown>[];
    edges: Record<string, unknown>[];
  }> {
    const nodeRows = await this.run(`
      MATCH (n:Entity {tenant_id: $tenantId})
      RETURN n.id AS id,
             [l IN labels(n) WHERE l <> 'Entity'][0] AS type,
             n.name AS name,
             n.subtype AS subtype,
             n.confidence AS confidence,
             n.times_mentioned AS times_mentioned,
             n.first_seen AS first_seen,
             n.last_seen AS last_seen,
             n.source_file AS source_file,
             n.tenant_id AS tenant_id,
             properties(n) AS props
      ORDER BY n.first_seen
    `, { tenantId });

    const edgeRows = await this.run(`
      MATCH (a:Entity {tenant_id: $tenantId})-[r]->(b:Entity {tenant_id: $tenantId})
      RETURN a.id AS from_id,
             b.id AS to_id,
             type(r) AS relation,
             r.weight AS weight,
             r.last_confirmed AS last_confirmed,
             r.valid_at AS valid_at,
             r.invalid_at AS invalid_at,
             r.ingested_at AS ingested_at,
             r.tenant_id AS tenant_id,
             r.source_session AS source_session,
             r.source_transcript AS source_transcript,
             r.source_type AS source_type,
             r.evidence AS evidence,
             properties(r) AS props
      ORDER BY a.id, type(r)
    `, { tenantId });

    return {
      nodes: nodeRows,
      edges: edgeRows,
    };
  }

  // ─── Recent additions (for build_context) ───

  async getRecentAdditions(tenantId: string, days: number, limit = 20): Promise<{
    nodes: Array<{ id: string; name: string; type: string; first_seen: string; confidence: number }>;
    edge_count: number;
  }> {
    const nodeRows = await this.run(
      `
      MATCH (n:Entity {tenant_id: $tenantId})
      WHERE n.first_seen > datetime() - duration({days: $days})
      RETURN n.id AS id,
             n.name AS name,
             [l IN labels(n) WHERE l <> 'Entity'][0] AS type,
             toString(n.first_seen) AS first_seen,
             n.confidence AS confidence
      ORDER BY n.first_seen DESC
      LIMIT $limit
      `,
      { tenantId, days, limit },
    );

    const edgeCountRows = await this.run(
      `
      MATCH (a:Entity {tenant_id: $tenantId})-[r]->(b:Entity {tenant_id: $tenantId})
      WHERE r.ingested_at IS NOT NULL
        AND r.ingested_at > datetime() - duration({days: $days})
      RETURN count(r) AS edge_count
      `,
      { tenantId, days },
    );

    return {
      nodes: nodeRows.map((r) => ({
        id: String(r["id"]),
        name: String(r["name"] ?? ""),
        type: String(r["type"] ?? "?"),
        first_seen: String(r["first_seen"] ?? ""),
        confidence: Number(r["confidence"] ?? 0),
      })),
      edge_count: Number(edgeCountRows[0]?.["edge_count"] ?? 0),
    };
  }

  // ─── Top hubs (most-connected entities) ───

  async getTopHubs(tenantId: string, count = 5, weight_threshold = 0.3): Promise<Array<{
    id: string; name: string; type: string; degree: number; confidence: number;
  }>> {
    const rows = await this.run(
      `
      MATCH (n:Entity {tenant_id: $tenantId})-[r]-(other:Entity {tenant_id: $tenantId})
      WHERE r.weight > $threshold
      WITH n, count(r) AS degree
      WHERE degree >= 3
      RETURN n.id AS id,
             n.name AS name,
             [l IN labels(n) WHERE l <> 'Entity'][0] AS type,
             n.confidence AS confidence,
             degree
      ORDER BY degree DESC
      LIMIT $count
      `,
      { tenantId, threshold: weight_threshold, count },
    );
    return rows.map((r) => ({
      id: String(r["id"]),
      name: String(r["name"] ?? ""),
      type: String(r["type"] ?? "?"),
      degree: Number(r["degree"] ?? 0),
      confidence: Number(r["confidence"] ?? 0),
    }));
  }

  // ─── Semantic / Vector Search ───

  /** Find entities most similar to a query embedding via Neo4j's native vector
   *  index, scoped to a tenant. Returns top_k matches with similarity scores.
   *  Note: we ask the index for top_k * 4 candidates and then filter by tenant
   *  to avoid the case where the global top_k is dominated by other tenants'
   *  entities. For small graphs this is cheap. */
  async vectorSearch(
    tenantId: string,
    queryEmbedding: number[],
    options: { top_k?: number; min_similarity?: number; entity_types?: EntityType[] } = {},
  ): Promise<Array<{ id: string; name: string; type: string; score: number; confidence: number }>> {
    const topK = options.top_k ?? 10;
    const minSim = options.min_similarity ?? 0.5;
    const candidatePool = Math.max(topK * 4, 40); // over-request, then filter by tenant

    const typeFilter = options.entity_types && options.entity_types.length > 0
      ? `AND ANY(l IN labels(node) WHERE l IN $types)`
      : "";

    const rows = await this.run(
      `
      CALL db.index.vector.queryNodes('entity_embedding', $candidatePool, $queryEmbedding)
      YIELD node, score
      WHERE node.tenant_id = $tenantId AND score >= $minSim ${typeFilter}
      RETURN node.id AS id,
             node.name AS name,
             [l IN labels(node) WHERE l <> 'Entity'][0] AS type,
             node.confidence AS confidence,
             score
      ORDER BY score DESC
      LIMIT $topK
      `,
      {
        tenantId,
        candidatePool,
        topK,
        queryEmbedding,
        minSim,
        ...(options.entity_types && options.entity_types.length > 0 && { types: options.entity_types }),
      },
    );

    return rows.map((r) => ({
      id: String(r["id"]),
      name: String(r["name"] ?? ""),
      type: String(r["type"] ?? "?"),
      confidence: Number(r["confidence"] ?? 0),
      score: Number(r["score"] ?? 0),
    }));
  }

  /** Find candidate pairs of entities likely to be duplicates. Combines
   *  embedding similarity (vector index), hub-aware shared-neighbor Jaccard
   *  (down-weighting overlaps that go through high-degree hubs like the
   *  user's own Person node), and name-token Jaccard. Same-type only —
   *  never suggests cross-type merges. Read-only; does not perform any merge. */
  async mergeSuggestions(
    tenantId: string,
    options: {
      entity_id?: string;
      entity_type?: EntityType;
      min_score?: number;
      min_embedding_similarity?: number;
      limit?: number;
      weights?: { embedding?: number; neighbor_jaccard?: number; name?: number };
    } = {},
  ): Promise<{
    suggestions: Array<{
      entity_a: { id: string; name: string; type: string; edge_count: number };
      entity_b: { id: string; name: string; type: string; edge_count: number };
      score: number;
      signals: {
        embedding_similarity: number;
        name_similarity: number;
        neighbor_jaccard: number;
        shared_neighbors: Array<{ id: string; relation: string; degree: number; weight: number }>;
      };
      recommended_action: "review";
    }>;
    total_pairs_evaluated: number;
    threshold_used: number;
    scope: { entity_id?: string; entity_type?: string; global: boolean };
  }> {
    const minScore = options.min_score ?? 0.8;
    const minEmbSim = options.min_embedding_similarity ?? 0.85;
    const limit = Math.min(options.limit ?? 20, 100);
    const w = {
      embedding: options.weights?.embedding ?? 0.4,
      neighbor_jaccard: options.weights?.neighbor_jaccard ?? 0.4,
      name: options.weights?.name ?? 0.2,
    };
    // Cap the number of seed entities to avoid runaway scans on large graphs.
    const MAX_SEEDS = 200;

    // Step 0: precompute per-entity edge degrees for hub-aware Jaccard.
    // A neighbor with degree D contributes weight 1/(1+log(D)) to the
    // intersection/union sums — so a 1-edge specific neighbor contributes
    // 1.0, while a 50-edge hub (e.g. the user's own Person node) contributes
    // ~0.20. Shared neighbors that are everyone's neighbor add little signal.
    const degreeRows = await this.run(
      `
      MATCH (n:Entity {tenant_id: $tenantId})
      RETURN n.id AS id, count{(n)-[]-(:Entity {tenant_id: $tenantId})} AS degree
      `,
      { tenantId },
    );
    const degrees = new Map<string, number>();
    for (const r of degreeRows) {
      degrees.set(String(r["id"]), Number(r["degree"] ?? 0));
    }
    const neighborWeight = (degree: number): number => {
      const d = Math.max(degree, 1);
      return 1 / (1 + Math.log(d));
    };

    // Step 1: collect seed entities. Constrained by entity_id / entity_type.
    const seedRows = await this.run(
      `
      MATCH (n:Entity {tenant_id: $tenantId})
      WHERE n.embedding IS NOT NULL
        AND ($entityId IS NULL OR n.id = $entityId)
        AND ($entityType IS NULL OR $entityType IN labels(n))
      RETURN n.id AS id,
             n.name AS name,
             n.embedding AS embedding,
             [l IN labels(n) WHERE l <> 'Entity'][0] AS type
      LIMIT $maxSeeds
      `,
      {
        tenantId,
        entityId: options.entity_id ?? null,
        entityType: options.entity_type ?? null,
        maxSeeds: MAX_SEEDS,
      },
    );

    // Step 2: for each seed, find vector-similar same-type neighbors and
    // build a deduped pair map. Pairs are canonicalised so a.id < b.id.
    type Pair = { idA: string; idB: string; embSim: number };
    const pairs = new Map<string, Pair>();

    for (const row of seedRows) {
      const seedId = String(row["id"]);
      const seedType = String(row["type"] ?? "");
      const seedEmbedding = row["embedding"] as number[] | null | undefined;
      if (!Array.isArray(seedEmbedding) || seedEmbedding.length === 0) continue;
      if (!seedType) continue;

      const similar = await this.vectorSearch(tenantId, seedEmbedding, {
        top_k: 10,
        min_similarity: minEmbSim,
        entity_types: [seedType as EntityType],
      });

      for (const candidate of similar) {
        if (candidate.id === seedId) continue; // self-match
        const [idA, idB] = seedId < candidate.id
          ? [seedId, candidate.id]
          : [candidate.id, seedId];
        const key = `${idA}::${idB}`;
        const existing = pairs.get(key);
        // Keep the higher embedding score if we see the same pair twice.
        if (!existing || candidate.score > existing.embSim) {
          pairs.set(key, { idA, idB, embSim: candidate.score });
        }
      }
    }

    const totalPairsEvaluated = pairs.size;

    // Step 3: per-pair feature query — names, types, edge counts, neighbors.
    const suggestions: Array<{
      entity_a: { id: string; name: string; type: string; edge_count: number };
      entity_b: { id: string; name: string; type: string; edge_count: number };
      score: number;
      signals: {
        embedding_similarity: number;
        name_similarity: number;
        neighbor_jaccard: number;
        shared_neighbors: Array<{ id: string; relation: string; degree: number; weight: number }>;
      };
      recommended_action: "review";
    }> = [];

    for (const pair of pairs.values()) {
      const featureRows = await this.run(
        `
        MATCH (a:Entity {tenant_id: $tenantId, id: $idA})
        MATCH (b:Entity {tenant_id: $tenantId, id: $idB})
        OPTIONAL MATCH (a)-[ra]-(na:Entity {tenant_id: $tenantId})
        WHERE na.id <> b.id
        WITH a, b, collect(DISTINCT na.id + '|' + type(ra)) AS neighborsA
        OPTIONAL MATCH (b)-[rb]-(nb:Entity {tenant_id: $tenantId})
        WHERE nb.id <> a.id
        WITH a, b, neighborsA,
             collect(DISTINCT nb.id + '|' + type(rb)) AS neighborsB
        RETURN a.name AS nameA,
               [l IN labels(a) WHERE l <> 'Entity'][0] AS typeA,
               b.name AS nameB,
               [l IN labels(b) WHERE l <> 'Entity'][0] AS typeB,
               neighborsA,
               neighborsB
        `,
        { tenantId, idA: pair.idA, idB: pair.idB },
      );

      if (featureRows.length === 0) continue;
      const f = featureRows[0]!;
      const neighborsA = (f["neighborsA"] as string[] | null | undefined ?? [])
        .filter((s) => typeof s === "string" && s.length > 0);
      const neighborsB = (f["neighborsB"] as string[] | null | undefined ?? [])
        .filter((s) => typeof s === "string" && s.length > 0);

      const setA = new Set(neighborsA);
      const setB = new Set(neighborsB);
      const intersection = neighborsA.filter((x) => setB.has(x));
      const unionSet = new Set([...neighborsA, ...neighborsB]);
      // Hub-aware weighted Jaccard. Each neighbor entry is "id|relation"; we
      // look up the global degree of the neighbor entity (id portion) and
      // weight its contribution inversely. A pair that shares only a hub
      // (everyone's neighbor) gets little credit; a pair that shares a
      // specific low-degree neighbor gets near-full credit.
      const idOf = (entry: string): string => {
        const sep = entry.lastIndexOf("|");
        return sep >= 0 ? entry.slice(0, sep) : entry;
      };
      let weightedInter = 0;
      for (const entry of intersection) {
        const deg = degrees.get(idOf(entry)) ?? 1;
        weightedInter += neighborWeight(deg);
      }
      let weightedUnion = 0;
      for (const entry of unionSet) {
        const deg = degrees.get(idOf(entry)) ?? 1;
        weightedUnion += neighborWeight(deg);
      }
      const neighborJaccard = weightedUnion === 0 ? 0 : weightedInter / weightedUnion;

      const nameA = String(f["nameA"] ?? "");
      const nameB = String(f["nameB"] ?? "");
      const tokensA = new Set(
        nameA.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0),
      );
      const tokensB = new Set(
        nameB.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0),
      );
      const tokenInter = [...tokensA].filter((t) => tokensB.has(t)).length;
      const tokenUnion = new Set([...tokensA, ...tokensB]).size;
      const nameSim = tokenUnion === 0 ? 0 : tokenInter / tokenUnion;

      const score =
        w.embedding * pair.embSim +
        w.neighbor_jaccard * neighborJaccard +
        w.name * nameSim;

      if (score < minScore) continue;

      const sharedNeighbors = intersection.map((entry) => {
        const sep = entry.lastIndexOf("|");
        const id = sep >= 0 ? entry.slice(0, sep) : entry;
        const relation = sep >= 0 ? entry.slice(sep + 1) : "";
        const deg = degrees.get(id) ?? 1;
        return {
          id,
          relation,
          degree: deg,
          weight: Number(neighborWeight(deg).toFixed(4)),
        };
      });

      suggestions.push({
        entity_a: {
          id: pair.idA,
          name: nameA,
          type: String(f["typeA"] ?? "?"),
          edge_count: setA.size,
        },
        entity_b: {
          id: pair.idB,
          name: nameB,
          type: String(f["typeB"] ?? "?"),
          edge_count: setB.size,
        },
        score: Number(score.toFixed(4)),
        signals: {
          embedding_similarity: Number(pair.embSim.toFixed(4)),
          name_similarity: Number(nameSim.toFixed(4)),
          neighbor_jaccard: Number(neighborJaccard.toFixed(4)),
          shared_neighbors: sharedNeighbors,
        },
        recommended_action: "review",
      });
    }

    suggestions.sort((a, b) => b.score - a.score);
    const truncated = suggestions.slice(0, limit);

    return {
      suggestions: truncated,
      total_pairs_evaluated: totalPairsEvaluated,
      threshold_used: minScore,
      scope: {
        entity_id: options.entity_id,
        entity_type: options.entity_type,
        global: !options.entity_id && !options.entity_type,
      },
    };
  }

  /** Backfill embeddings for entities that don't have one. With force=true,
   *  re-embed every entity (e.g. after changing the embed-text recipe).
   *  Embeds richer text (name + type + select properties) via buildEmbedText
   *  so semantically similar concepts cluster more tightly.
   *
   *  When `tenantId` is supplied, only that tenant's entities are touched —
   *  this is what the graph_reembed MCP tool uses. The startup backfill calls
   *  this with no tenantId (all-tenants pass), since it's an admin operation
   *  that reads only public-shape properties (name, type, subtype, etc.) and
   *  doesn't expose any tenant's data outside its own boundary.
   */
  async backfillEmbeddings(
    options: { tenantId?: string; batchSize?: number; force?: boolean } = {},
  ): Promise<{ embedded: number; skipped: number; errors: number }> {
    const batchSize = options.batchSize ?? 50;
    const force = options.force ?? false;
    const tenantId = options.tenantId;

    let embedded = 0;
    let errors = 0;

    // Track ids we've already processed in this run to ensure forward progress
    // across batches even when nothing is null (force mode just iterates all).
    // Note: ids are namespaced internally by tenant_id when tenant scoped, but
    // the Set holds raw ids — that's fine because the WHERE clause already
    // restricts to the same tenant.
    const processed = new Set<string>();

    const tenantClause = tenantId ? "AND n.tenant_id = $tenantId" : "";

    while (true) {
      const rows = await this.run(
        `
        MATCH (n:Entity)
        WHERE ${force ? "true" : "n.embedding IS NULL"}
          AND NOT n.id IN $processed
          ${tenantClause}
        RETURN n.id AS id,
               n.tenant_id AS tenant_id,
               n.name AS name,
               [l IN labels(n) WHERE l <> 'Entity'][0] AS type,
               properties(n) AS props
        LIMIT $batchSize
        `,
        { batchSize, processed: [...processed], ...(tenantId && { tenantId }) },
      );
      if (rows.length === 0) break;

      // Embed in parallel using the rich-context recipe
      const embeddings = await Promise.all(
        rows.map(async (r) => {
          const name = String(r["name"] ?? "");
          if (!name) return null;
          const type = r["type"] ? String(r["type"]) : undefined;
          const props = (r["props"] as Record<string, unknown>) ?? {};
          try {
            return await embedText(buildEmbedText(name, type, props));
          } catch { return null; }
        }),
      );

      // Write back (matched on tenant_id + id to avoid cross-tenant collisions)
      for (let i = 0; i < rows.length; i++) {
        const id = String(rows[i]["id"]);
        const rowTenantId = String(rows[i]["tenant_id"] ?? "");
        processed.add(id);
        const emb = embeddings[i];
        if (!emb) { errors++; continue; }
        try {
          await this.run(
            `MATCH (n:Entity {tenant_id: $tenantId, id: $id}) SET n.embedding = $embedding`,
            { tenantId: rowTenantId, id, embedding: emb },
          );
          embedded++;
        } catch (err) {
          debugLogClient(`backfill write failed for ${id} (tenant=${rowTenantId}): ${err instanceof Error ? err.message : String(err)}`);
          errors++;
        }
      }

      if (rows.length < batchSize) break;
    }

    // Count any remaining nulls (only meaningful when force=false)
    const remaining = await this.run(
      `MATCH (n:Entity) WHERE n.embedding IS NULL ${tenantClause} RETURN count(n) AS c`,
      tenantId ? { tenantId } : {},
    );
    const skipped = Number(remaining[0]?.["c"] ?? 0);

    return { embedded, skipped, errors };
  }

  // ─── Communities ───
  // Greedy seed-based BFS clustering. No GDS/APOC required — works on Aura Free.
  // Algorithm:
  //   1. Rank entities by strong-edge degree
  //   2. Take the highest-degree unassigned entity as a seed
  //   3. BFS through edges with weight > threshold up to max_hops
  //   4. Assign all reached entities to this community
  //   5. Repeat until max_communities reached or no more high-degree seeds

  async findCommunities(tenantId: string, options: {
    weight_threshold?: number;
    max_communities?: number;
    max_hops?: number;
    min_size?: number;
  } = {}): Promise<{
    communities: Array<{
      id: number;
      seed_name: string;
      seed_id: string;
      member_count: number;
      dominant_type: string;
      members: Array<{ id: string; name: string; type: string }>;
    }>;
    coverage: {
      total_entities: number;
      assigned: number;
      unassigned: number;
    };
  }> {
    const threshold = options.weight_threshold ?? 0.4;
    const maxCommunities = options.max_communities ?? 10;
    const maxHops = Math.max(1, Math.min(options.max_hops ?? 3, 4));
    const minSize = options.min_size ?? 2;

    // Step 1: rank nodes by strong-edge degree (tenant-scoped)
    const hubRows = await this.run(
      `
      MATCH (n:Entity {tenant_id: $tenantId})-[r]-(other:Entity {tenant_id: $tenantId})
      WHERE r.weight > $threshold
      WITH n, count(r) AS degree
      WHERE degree >= 2
      RETURN n.id AS id,
             n.name AS name,
             [l IN labels(n) WHERE l <> 'Entity'][0] AS type,
             degree
      ORDER BY degree DESC
      LIMIT 100
      `,
      { tenantId, threshold },
    );

    // Total entity count for coverage stats (tenant-scoped)
    const totalRows = await this.run(
      `MATCH (n:Entity {tenant_id: $tenantId}) RETURN count(n) AS total`,
      { tenantId },
    );
    const totalEntities = Number(totalRows[0]?.["total"] ?? 0);

    const assigned = new Set<string>();
    const communities: Array<{
      id: number;
      seed_name: string;
      seed_id: string;
      member_count: number;
      dominant_type: string;
      members: Array<{ id: string; name: string; type: string }>;
    }> = [];

    for (const hub of hubRows) {
      if (communities.length >= maxCommunities) break;
      const hubId = String(hub["id"]);
      if (assigned.has(hubId)) continue;

      // BFS: variable-length path from seed, all relationships above threshold,
      // confined to this tenant's subgraph. Path is bound to a variable so we
      // can pass it to nodes() — passing the pattern directly is List<Path>.
      const memberRows = await this.run(
        `
        MATCH (seed:Entity {tenant_id: $tenantId, id: $seedId})
        MATCH path = (seed)-[r*1..${maxHops}]-(m:Entity)
        WHERE ALL(node IN nodes(path) WHERE node.tenant_id = $tenantId)
          AND ALL(rel IN r WHERE rel.weight > $threshold)
        RETURN DISTINCT m.id AS id,
               m.name AS name,
               [l IN labels(m) WHERE l <> 'Entity'][0] AS type
        `,
        { tenantId, seedId: hubId, threshold },
      );

      const seedRow = {
        id: hubId,
        name: String(hub["name"] ?? hubId),
        type: String(hub["type"] ?? "?"),
      };

      const members = [seedRow];
      const seenInCluster = new Set<string>([hubId]);
      for (const row of memberRows) {
        const id = String(row["id"]);
        if (assigned.has(id) || seenInCluster.has(id)) continue;
        seenInCluster.add(id);
        members.push({
          id,
          name: String(row["name"] ?? id),
          type: String(row["type"] ?? "?"),
        });
      }

      if (members.length < minSize) continue;

      // Compute dominant type
      const typeCounts: Record<string, number> = {};
      for (const m of members) typeCounts[m.type] = (typeCounts[m.type] ?? 0) + 1;
      const dominantType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "?";

      // Mark these as assigned (greedy: each entity belongs to the first community that grabs it)
      for (const m of members) assigned.add(m.id);

      communities.push({
        id: communities.length + 1,
        seed_name: seedRow.name,
        seed_id: seedRow.id,
        member_count: members.length,
        dominant_type: dominantType,
        members: members.slice(0, 30),
      });
    }

    return {
      communities,
      coverage: {
        total_entities: totalEntities,
        assigned: assigned.size,
        unassigned: totalEntities - assigned.size,
      },
    };
  }
}
