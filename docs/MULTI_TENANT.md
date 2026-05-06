# Multi-tenant data model

graph-memory partitions every entity and edge by `tenant_id` so multiple users can share a single Neo4j instance without ever seeing each other's data. The model is simple by design — one shared graph, per-tenant subgraphs filtered at every query layer.

## Core invariant

Every `Entity` node has a `tenant_id` property. Every Cypher query in [`src/shared/neo4j-client.ts`](../src/shared/neo4j-client.ts) filters by it. The composite uniqueness constraint `(tenant_id, id)` lets two different tenants legitimately have entities with the same canonical id (e.g., each user can have their own `alice` Person without conflict).

```cypher
// Schema
CREATE CONSTRAINT entity_tenant_id IF NOT EXISTS
  FOR (n:Entity) REQUIRE (n.tenant_id, n.id) IS UNIQUE;
CREATE INDEX entity_tenant_name FOR (n:Entity) ON (n.tenant_id, n.name);

// Every read query
MATCH (n:Entity {tenant_id: $tenantId, ...}) ...

// Every write query (MERGE includes tenant_id in the merge key)
MERGE (n:Entity:Person {tenant_id: $tenantId, id: $id}) ...
```

Edges also carry a `tenant_id` (set by `createRelationship` / `batchRelate`), but tenant isolation is primarily enforced through the endpoints' tenant ids — every `MATCH` requires both endpoints to be in the same tenant. The edge property is for export and audit completeness.

## How `tenantId` flows through a request

```
┌─────────────────────────────────┐
│ HTTP request arrives at /mcp    │
│  with Cf-Access-Jwt-Assertion   │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ resolveTenantFromRequest()      │
│  in src/shared/auth.ts          │
│  • verifies JWT signature       │
│  • extracts email from claims   │
│  • returns { tenantId, identity }│
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ tenantContext.run(ctx, () => {  │
│   transport.handleRequest(...)  │
│ })  ← AsyncLocalStorage         │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ Tool handler (e.g. graph_query) │
│  const tenantId = currentTenant()│
│  await client.query(tenantId, …)│
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ Neo4jClient.query()             │
│  Cypher: MATCH (n {tenant_id…}) │
└─────────────────────────────────┘
```

For stdio transport (Claude Code / Claude Desktop running locally), there's no incoming HTTP request — `currentTenant()` falls back to `LOCAL_TENANT_ID` (defaults to `BOOTSTRAP_TENANT_ID`, defaults to `"bootstrap"`).

## Identity sources

`TENANT_ID_SOURCE` env var picks the resolution strategy:

| Source | Use | Tenant id derives from |
|---|---|---|
| `static` | local stdio (Claude Code / Desktop), tests | `LOCAL_TENANT_ID` env var |
| `cf-access` | Cloudflare Access JWT on every path (legacy mode) | Cf-Access JWT `email` claim |
| `header` | self-hosted reverse-proxy setups | `X-Graph-Memory-Tenant` request header (only safe behind a trusted proxy) |
| `oauth` | **production remote mode** — claude.ai web, multi-device | `email` claim from our own RS256 bearer JWT (issued by `/oauth/token`) |

**`oauth` mode (production default for HTTPS transport):** The server validates the `Authorization: Bearer` token against its own RSA keypair (see `~/graph-memory/oauth/`). The JWKS for these keys is served at `/oauth/jwks` — separate from the Cloudflare Access JWKS at `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`. In this mode, Cloudflare Access only gates `/oauth/authorize` (the one path a browser must reach during the OAuth connect flow); all other paths (`/mcp`, `/oauth/token`, `/.well-known/*`, `/health`) bypass CF Access and accept bearer tokens directly.

`cf-access` mode is now used only internally (gating the `/oauth/authorize` path). `static` and `header` remain valid for local-only and custom proxy deployments.

JWT verification for `cf-access` uses [`jose`](https://github.com/panva/jose) to validate against Cloudflare Access's JWKS endpoint (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`). The audience claim is checked against `CF_ACCESS_AUD`.

## Adding a new user

1. **Allow them through Cloudflare Access** — add their email to the application policy (see [REMOTE.md](REMOTE.md)).
2. **They visit claude.ai → Connectors → add the graph-memory connector** and complete OAuth.
3. **First request creates their tenant on demand.** No admin action needed; the very first `graph_stats` they run returns `{ nodes: 0, edges: 0 }`. Their first `graph_relate` creates entities under their email tenant.
4. **Each user's data is isolated.** Cross-tenant queries return empty. Vector search (semantic) filters by tenant id post-similarity. Even raw Cypher access is locked down — the `graph_cypher` tool is admin-only (gated on `BOOTSTRAP_TENANT_ID`).

## Removing a user

1. **Remove from Cloudflare Access policy.** They can no longer reach the MCP server.
2. **Optionally delete their data:**
   ```cypher
   MATCH (n:Entity {tenant_id: "their.email@example.com"}) DETACH DELETE n
   ```
   This is irreversible. Consider exporting their data first via `graph_export` if there's any chance of restoration.

## Admin tenant

The tenant whose id matches `BOOTSTRAP_TENANT_ID` (typically the system owner's email) has admin privileges:

- **`graph_cypher`** — only this tenant can run raw Cypher (otherwise users could bypass tenant filtering by writing their own queries).
- **`graph_reembed` with no scope** — re-embeds entities across all tenants. Non-admin tenants can only reembed their own.
- **Schema and migration changes** run as the admin during `initializeSchema()`.

There's no role hierarchy beyond this — `isAdminTenant()` in [`src/shared/auth.ts`](../src/shared/auth.ts) is a single-line check. If finer-grained roles become necessary, that's the seam.

## Caveats and known limitations

- **Fulltext index is global at the index layer.** Neo4j 5.x doesn't expose tenant-aware fulltext indexes; we filter results post-query in the WHERE clause. Correctness is intact (no leak), but a fulltext search in tenant A can match-then-filter entities in tenant B at the index layer. Tiny perf overhead at small scale.
- **Vector index is also global.** Same pattern — over-request `top_k * 4` candidates from the index, then filter to the calling tenant. Negligible at hundreds of nodes; revisit at 100k+.
- **Embeddings are tenant-agnostic.** The text we embed is just the entity name + type + select properties — no cross-tenant signal. Re-embedding across all tenants is safe.
- **No per-tenant rate limiting in the MCP layer.** Cloudflare Access provides per-policy rate rules; configure those if abuse becomes a concern.

## How isolation was validated

When this feature shipped, a sub-agent ran a battery of cross-tenant tests directly against the running container:

1. Bootstrap tenant baseline: 303 nodes / 431 edges.
2. Created a second tenant with 2 nodes and 1 edge.
3. Verified tenant A sees its 303/431 unchanged (no cross-tenant pollution).
4. Verified tenant B sees only its 2/1 (no peek into A).
5. Verified `searchEntities` and direct Cypher both respect tenant boundaries.
6. Confirmed zero cross-tenant edges anywhere in the graph: `MATCH (a)-[r]->(b) WHERE a.tenant_id <> b.tenant_id` returns 0.
7. Cleanup: deleted tenant B's nodes; re-verified A intact.

Result: PASS on every check. See git log for the commit that added the feature.
