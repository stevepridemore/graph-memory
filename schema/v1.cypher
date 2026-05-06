// ─── Graph Memory Schema v1 ───
// Run on every server start. All operations are idempotent (IF NOT EXISTS / IF EXISTS).
// initializeSchema() in neo4j-client.ts also runs a backfill step to set tenant_id
// on legacy entities created before multi-tenant support landed.

// ─── Uniqueness Constraints ───
// Legacy single-property uniqueness on n.id is replaced by composite
// (tenant_id, id). DROP first so the composite constraint can take over without
// blocking inserts where two tenants legitimately use the same canonical id
// (e.g. each tenant has their own "alice" Person).
DROP CONSTRAINT entity_id IF EXISTS;

CREATE CONSTRAINT entity_tenant_id IF NOT EXISTS
  FOR (n:Entity) REQUIRE (n.tenant_id, n.id) IS UNIQUE;

CREATE CONSTRAINT alias_id IF NOT EXISTS FOR (n:Alias) REQUIRE n.id IS UNIQUE;

// ─── Type-Specific Indexes for Common Lookups ───
// Tenant-aware composite index for the hot path (entity name lookup within tenant).
CREATE INDEX entity_tenant_name IF NOT EXISTS FOR (n:Entity) ON (n.tenant_id, n.name);

CREATE INDEX person_name IF NOT EXISTS FOR (n:Person) ON (n.name);
CREATE INDEX project_name IF NOT EXISTS FOR (n:Project) ON (n.name);
CREATE INDEX concept_name IF NOT EXISTS FOR (n:Concept) ON (n.name);
CREATE INDEX event_name IF NOT EXISTS FOR (n:Event) ON (n.name);
CREATE INDEX object_name IF NOT EXISTS FOR (n:Object) ON (n.name);
CREATE INDEX preference_key IF NOT EXISTS FOR (n:Preference) ON (n.domain, n.key);
CREATE INDEX reasoning_name IF NOT EXISTS FOR (n:Reasoning) ON (n.name);
CREATE INDEX alias_text IF NOT EXISTS FOR (n:Alias) ON (n.alias_text);
CREATE INDEX entity_subtype IF NOT EXISTS FOR (n:Entity) ON (n.subtype);

// ─── Full-Text Search Index (for fuzzy entity resolution) ───
CREATE FULLTEXT INDEX entity_names IF NOT EXISTS
FOR (n:Person|Project|Concept|Decision|Fact|Preference|Event|Object|Reasoning)
ON EACH [n.name, n.id];

// ─── Vector Index for Semantic Search ───
// 384 dimensions — bge-small-en-v1.5. Cosine similarity is appropriate for
// L2-normalized embeddings (which our embedder produces). Requires Neo4j 5.11+.
CREATE VECTOR INDEX entity_embedding IF NOT EXISTS
FOR (n:Entity) ON (n.embedding)
OPTIONS {indexConfig: {
  `vector.dimensions`: 384,
  `vector.similarity_function`: 'cosine'
}};
