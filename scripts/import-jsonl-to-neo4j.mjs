// Import a graph_export JSONL backup into a fresh Neo4j instance.
//
// Usage (inside the graph-memory-mcp container, where the local neo4j
// service is reachable as bolt://neo4j:7687):
//
//   docker exec -e BACKUP_FILE=/root/graph-memory/backups/<file>.jsonl \
//               -e NEO4J_LOCAL_URI=bolt://neo4j:7687 \
//               graph-memory-mcp \
//               node /app/scripts/import-jsonl-to-neo4j.mjs
//
// The script:
//   1. Connects to the target Neo4j (bolt://neo4j:7687 by default)
//   2. Wipes existing data (we want a clean import, no merge-with-existing
//      surprises)
//   3. Initializes schema (constraints + indexes from schema/v1.cypher)
//   4. Bulk-inserts all nodes preserving labels, properties, embeddings,
//      tenant_id, and converts ISO date strings back to Neo4j DateTime
//   5. Bulk-inserts all edges preserving relationship type, weight,
//      provenance, and bi-temporal fields
//   6. Verifies counts match the meta header

import { readFileSync } from "node:fs";
import neo4j from "neo4j-driver";

const BACKUP_FILE = process.env.BACKUP_FILE;
const URI = process.env.NEO4J_LOCAL_URI ?? "bolt://neo4j:7687";
const USER = process.env.NEO4J_LOCAL_USER ?? "neo4j";
const PASSWORD = process.env.NEO4J_PASSWORD;
const DATABASE = process.env.NEO4J_LOCAL_DATABASE ?? "neo4j";

if (!BACKUP_FILE) throw new Error("Set BACKUP_FILE env var");
if (!PASSWORD) throw new Error("Set NEO4J_PASSWORD env var");

console.log(`source: ${BACKUP_FILE}`);
console.log(`target: ${URI} db=${DATABASE} user=${USER}`);

// ─── Parse JSONL ─────────────────────────────────────────────────────────────
const lines = readFileSync(BACKUP_FILE, "utf-8")
  .split("\n")
  .filter((l) => l.trim().length > 0);

let meta = null;
const nodes = [];
const edges = [];
for (const line of lines) {
  const obj = JSON.parse(line);
  if (obj.record === "meta") meta = obj;
  else if (obj.record === "node") nodes.push(obj);
  else if (obj.record === "edge") edges.push(obj);
}

console.log(`parsed: meta=${meta ? "yes" : "no"}, ${nodes.length} nodes, ${edges.length} edges`);
if (meta) console.log(`meta: exported_at=${meta.exported_at}, expects ${meta.node_count} nodes, ${meta.edge_count} edges`);

// ─── Connect to target ───────────────────────────────────────────────────────
const driver = neo4j.driver(URI, neo4j.auth.basic(USER, PASSWORD), {
  encrypted: URI.startsWith("neo4j+s") || URI.startsWith("bolt+s") ? "ENCRYPTION_ON" : "ENCRYPTION_OFF",
  maxConnectionPoolSize: 5,
});

await driver.verifyConnectivity();
console.log(`connected to ${URI}`);

const session = driver.session({ database: DATABASE, defaultAccessMode: neo4j.session.WRITE });

try {
  // ─── Wipe existing ─────────────────────────────────────────────────────────
  // Fresh-import semantics — fail loud if data already exists, unless
  // FORCE_WIPE=true. Avoids accidentally clobbering a populated db.
  const existing = await session.run("MATCH (n) RETURN count(n) AS c");
  const existingCount = existing.records[0]?.get("c").toNumber() ?? 0;
  if (existingCount > 0) {
    if (process.env.FORCE_WIPE !== "true") {
      throw new Error(`target database already has ${existingCount} nodes — set FORCE_WIPE=true to overwrite`);
    }
    console.log(`wiping ${existingCount} existing nodes...`);
    await session.run("MATCH (n) DETACH DELETE n");
  }

  // ─── Initialize schema ─────────────────────────────────────────────────────
  console.log("initializing schema...");
  const schemaCypher = readFileSync("/app/schema/v1.cypher", "utf-8");
  const statements = schemaCypher
    .split(";")
    .map((s) => s.replace(/\/\/.*$/gm, "").trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await session.run(stmt);
  }
  console.log(`  ${statements.length} schema statements applied`);

  // ─── Insert nodes ──────────────────────────────────────────────────────────
  // Use APOC's apoc.create.node to apply both :Entity and the type-specific
  // label dynamically. Convert ISO date strings back to Neo4j DateTime.
  console.log(`inserting ${nodes.length} nodes...`);
  const nodeBatchSize = 100;
  let nodesInserted = 0;
  for (let i = 0; i < nodes.length; i += nodeBatchSize) {
    const batch = nodes.slice(i, i + nodeBatchSize);
    // Strip the "record" field (not a Neo4j property)
    const cleanBatch = batch.map((n) => ({
      type: n.type ?? "Concept",
      props: { ...n.props },
    }));
    const result = await session.run(
      `
      UNWIND $batch AS row
      CALL apoc.create.node(['Entity', row.type], row.props) YIELD node
      WITH node, row
      SET node.first_seen = CASE WHEN row.props.first_seen IS NOT NULL THEN datetime(row.props.first_seen) ELSE null END,
          node.last_seen = CASE WHEN row.props.last_seen IS NOT NULL THEN datetime(row.props.last_seen) ELSE null END
      RETURN count(node) AS created
      `,
      { batch: cleanBatch },
    );
    nodesInserted += result.records[0]?.get("created").toNumber() ?? 0;
  }
  console.log(`  ${nodesInserted} nodes inserted`);

  // ─── Insert edges ──────────────────────────────────────────────────────────
  console.log(`inserting ${edges.length} edges...`);
  const edgeBatchSize = 100;
  let edgesInserted = 0;
  for (let i = 0; i < edges.length; i += edgeBatchSize) {
    const batch = edges.slice(i, i + edgeBatchSize);
    const cleanBatch = batch.map((e) => ({
      from_id: e.from_id,
      to_id: e.to_id,
      relation: e.relation,
      props: { ...e.props },
    }));
    const result = await session.run(
      `
      UNWIND $batch AS row
      MATCH (a:Entity {id: row.from_id})
      MATCH (b:Entity {id: row.to_id})
      CALL apoc.create.relationship(a, row.relation, row.props, b) YIELD rel
      WITH rel, row
      SET rel.last_confirmed = CASE WHEN row.props.last_confirmed IS NOT NULL THEN datetime(row.props.last_confirmed) ELSE null END,
          rel.valid_at = CASE WHEN row.props.valid_at IS NOT NULL THEN datetime(row.props.valid_at) ELSE null END,
          rel.invalid_at = CASE WHEN row.props.invalid_at IS NOT NULL THEN datetime(row.props.invalid_at) ELSE null END,
          rel.ingested_at = CASE WHEN row.props.ingested_at IS NOT NULL THEN datetime(row.props.ingested_at) ELSE null END
      RETURN count(rel) AS created
      `,
      { batch: cleanBatch },
    );
    edgesInserted += result.records[0]?.get("created").toNumber() ?? 0;
  }
  console.log(`  ${edgesInserted} edges inserted`);

  // ─── Verify ────────────────────────────────────────────────────────────────
  const finalNodes = await session.run("MATCH (n:Entity) RETURN count(n) AS c");
  const finalEdges = await session.run("MATCH ()-[r]->() RETURN count(r) AS c");
  const fc_nodes = finalNodes.records[0]?.get("c").toNumber() ?? 0;
  const fc_edges = finalEdges.records[0]?.get("c").toNumber() ?? 0;
  console.log(`final state: ${fc_nodes} nodes, ${fc_edges} edges`);

  if (meta && (fc_nodes !== meta.node_count || fc_edges !== meta.edge_count)) {
    console.error(`MISMATCH vs meta: expected ${meta.node_count}/${meta.edge_count}, got ${fc_nodes}/${fc_edges}`);
    process.exit(1);
  }
  console.log("import complete — counts match meta header");
} finally {
  await session.close();
  await driver.close();
}
