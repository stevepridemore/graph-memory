# Backup & Restore

Two complementary backups, two recovery paths. Pick by what you have left after a failure.

| You still have… | Use this restore path |
|---|---|
| The host data directory (`$GRAPH_MEMORY_HOME/neo4j/data`) | **Volume restore** — fastest, exact state |
| Only a `graph_export` JSONL file | **Logical restore** — slower; indexes are rebuilt, not copied |
| Nothing | Hope you ran both. The volume backup is the disaster-recovery copy; the logical export is the cross-version safety net. |

The two layers protect against different failures: a corrupted Neo4j data directory, an accidental `docker volume rm`, or a Neo4j major-version upgrade gone wrong all want the volume snapshot. A schema redesign, a tenant split, or a port to a different graph backend all want the JSONL export.

## What's where

| Asset | Location (host) | What it holds | Survives… |
|---|---|---|---|
| Neo4j data directory | `$GRAPH_MEMORY_HOME/neo4j/data/` (bind-mounted to `/data` in the `neo4j` container) | Every node, edge, property, full-text index, vector index, schema constraint | Container recreate, host reboot. Lost on `rm -rf`, accidental `docker compose down -v`, host disk failure |
| Neo4j logs | `$GRAPH_MEMORY_HOME/neo4j/logs/` | Server logs, query logs, audit if enabled | Same |
| MCP audit / dream logs | `$GRAPH_MEMORY_HOME/logs/{dream-audit,merge-audit}.jsonl` | Provenance for every dream extraction, merge, and unmerge | Same |
| Backups directory | `$GRAPH_MEMORY_HOME/backups/` (created by `graph_export`) | Timestamped JSONL exports of nodes + edges | Same |
| `.env` and `docker-compose.yml` | Repo + your private `.env` | Tunnel ID, AUD, team domain, NEO4J_PASSWORD | Repo clone + secret manager. Not in any backup tool |
| TLS certs | `$GRAPH_MEMORY_HOME/certs/` | `server.crt`, `server.key` | Mounted into the MCP container. Re-generate if lost |

Everything under `$GRAPH_MEMORY_HOME` is on your host filesystem — whatever sync/backup tool covers your home directory covers graph-memory by default. There is **no Docker named volume** in this deployment; the data lives on the host.

## Layer 1 — Volume backup (recommended cadence: weekly + before any risky upgrade)

The Neo4j data directory is the fastest, most complete restore source. Two ways to capture a consistent snapshot:

### A. Cold copy (simplest, brief downtime)

```bash
docker compose stop neo4j
# wait for the container to fully stop (a few seconds)
tar -czf graph-memory-neo4j-$(date +%Y%m%d).tar.gz -C "$GRAPH_MEMORY_HOME" neo4j/data
docker compose start neo4j
```

Stopping the container guarantees a consistent on-disk state. ~2-5 seconds downtime for a typical personal graph; longer if you have a multi-GB store.

### B. neo4j-admin dump (zero downtime, requires Neo4j stopped *inside* the container)

```bash
docker compose exec neo4j neo4j-admin database dump neo4j \
  --to-path=/import --overwrite-destination=true
# dump now lives at $GRAPH_MEMORY_HOME/neo4j/import/neo4j.dump
mv "$GRAPH_MEMORY_HOME/neo4j/import/neo4j.dump" \
   "$GRAPH_MEMORY_HOME/backups/neo4j-$(date +%Y%m%d).dump"
```

Note: `neo4j-admin database dump` requires the database to be stopped *inside* the container while the rest of the server stays up. On Community Edition with a single database (`neo4j`), this means the database is offline for the dump duration. Honestly, for a personal graph the cold tar is simpler and equally safe.

### Restore (volume backup)

```bash
docker compose down                 # stop everything
rm -rf "$GRAPH_MEMORY_HOME/neo4j/data"
mkdir -p "$GRAPH_MEMORY_HOME/neo4j/data"
tar -xzf graph-memory-neo4j-YYYYMMDD.tar.gz -C "$GRAPH_MEMORY_HOME"
docker compose up -d
```

For a `.dump` file:
```bash
docker compose stop neo4j
docker compose run --rm --entrypoint /bin/bash neo4j -c \
  "neo4j-admin database load neo4j --from-path=/import --overwrite-destination=true"
docker compose start neo4j
```
(after `cp graph-memory-neo4j-YYYYMMDD.dump $GRAPH_MEMORY_HOME/neo4j/import/neo4j.dump`)

What you get back: **everything**. Nodes, edges, properties, embeddings, full-text indexes, vector indexes, constraints, the lot. This is the disaster-recovery path.

## Layer 2 — Logical export (recommended cadence: before risky operations, or weekly)

`graph_export` writes a JSONL of all nodes and edges to `$GRAPH_MEMORY_HOME/backups/backup-<timestamp>[-<label>].jsonl`. The timestamp is UTC, to the second, with colons replaced by hyphens, for example `backup-2026-05-05T22-00-00.jsonl`. The label keeps letters, digits and hyphens; other characters become hyphens. Use it before anything that mutates broadly: `graph_decay`, `graph_prune`, `graph_merge` of high-degree entities, schema migrations.

```jsonc
// Via the MCP tool
graph_export({ keep: 14, label: "pre-prune" })   // writes backup-<timestamp>-pre-prune.jsonl
```

The export is automatically pruned to the last `keep` files (1 to 30, default 14). Old exports are deleted to prevent unbounded growth.

### Restore (logical export)

There is no `graph_import` MCP tool. Restore with `scripts/import-jsonl-to-neo4j.mjs`. The image doesn't include that script, so copy it into the container first. Run the import inside the `graph-memory-mcp` container. It reaches Neo4j at `bolt://neo4j:7687`, and `NEO4J_PASSWORD` comes from `.env`:

```sh
docker cp scripts/import-jsonl-to-neo4j.mjs graph-memory-mcp:/app/scripts/import-jsonl-to-neo4j.mjs
docker exec -e BACKUP_FILE=/root/graph-memory/backups/backup-2026-05-05T22-00-00.jsonl \
            -e FORCE_WIPE=true \
            graph-memory-mcp node /app/scripts/import-jsonl-to-neo4j.mjs
```

`BACKUP_FILE` is a path inside the container; `/root/graph-memory` is your data folder. What the script does:

- Stops if the target database already has nodes, unless `FORCE_WIPE=true`. With that set, it runs `MATCH (n) DETACH DELETE n` first. The whole database is replaced, not one tenant.
- Applies `/app/schema/v1.cypher`, then creates the nodes and edges in batches of 100, with their properties.
- Compares the counts with the export's `meta` line and exits with status 1 on a mismatch.

Optional variables: `NEO4J_LOCAL_URI` (default `bolt://neo4j:7687`), `NEO4J_LOCAL_USER` and `NEO4J_LOCAL_DATABASE` (both default `neo4j`). Stop the `graph-dream` container first, if you run it, so nothing writes during the import.

What you get back vs. the volume restore:
- ✅ All entities and edges, with weights and timestamps
- ✅ Provenance (`source_session`, `source_transcript`, `source_type`)
- ✅ Bi-temporal fields (`valid_at`, `invalid_at`, `ingested_at`)
- ✅ **Embeddings** — node embeddings are part of the exported properties and the import writes them back, so `graph_reembed` isn't needed after a restore
- ❌ **Full-text and vector index state** — Neo4j rebuilds these from the data; first queries after a logical restore may be slow until indexes warm
- ✅ **Schema constraints and indexes** — the import applies `schema/v1.cypher` first
- ❌ **Audit logs** — `dream-audit.jsonl` and `merge-audit.jsonl` aren't in the export. Back those up from `$GRAPH_MEMORY_HOME/logs/` separately

This restore path is for "I changed graph backends" or "the volume is corrupted but I have last week's export." It's slower and rebuilds index state, but the file is portable and version-independent.

## Disaster scenarios

### Scenario A — Volume wipe (host disk failure, accidental `rm -rf`)
1. Restore from latest tar/dump (Layer 1). Done.
2. If no Layer 1 backup, fall back to the latest `graph_export` JSONL and restore it with the import script (see Restore above). Embeddings come back with the data. Audit logs are gone unless you backed them up separately.

### Scenario B — Neo4j upgrade gone wrong
1. `docker compose down`
2. Restore the data directory from the pre-upgrade tar.
3. Pin the docker-compose Neo4j image tag back to the pre-upgrade version.
4. `docker compose up -d`. Investigate the upgrade error before retrying.

### Scenario C — Bad dream run inflated weights / created bogus entities
1. Restore from `graph_export` JSONL taken before the dream ran.
2. **Why JSONL not volume:** weight inflation isn't visible immediately; the volume backup is probably already corrupted by the time you notice. The JSONL export is older and predates the bad run.
3. No re-embedding is needed after the restore. Run `graph_reembed --force` only if you changed the embedding recipe or model.
4. Audit the offending dream run: `grep '"event":"entity_resolved"' logs/dream-audit.jsonl | tail -100`. The `entity_resolved` event is described under `graph_audit` in [MCP_SERVER.md](MCP_SERVER.md).

### Scenario D — Tenant data cross-contamination
1. Use `graph_export` per tenant (the export is tenant-scoped) for the affected tenant.
2. `graph_cypher` (admin) to delete the cross-contaminated subgraph.
3. The import script replaces the whole database, so it can't restore one tenant alone. Re-create the clean tenant's entities with `graph_relate` batches, or restore the whole database from a clean export.

## Cadence

| Backup type | Frequency | Retention |
|---|---|---|
| Volume tar / dump | Weekly + before any Neo4j upgrade or schema migration | Last 4 weekly + last 4 pre-upgrade |
| `graph_export` JSONL | Before any broad write (decay, prune, large merge); otherwise weekly | Default 14 most recent (auto-pruned by the tool) |
| `.env` + certs | After any change (one-shot, then immutable until next change) | Stored alongside other secrets, not in `$GRAPH_MEMORY_HOME` |
| Audit logs | Continuous — already on host disk; covered by your home-dir backup tool | Indefinite |

Personal recommendation: cold tar of `$GRAPH_MEMORY_HOME` once a week as a cron, plus `graph_export` before any maintenance you'd hesitate to undo. Both are cheap.
