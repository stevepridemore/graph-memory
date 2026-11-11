// One-time backfill: give every CONTRADICTS edge the review fields the
// contradiction check relies on. Safe to re-run: coalesce keeps any value
// already present, so resolved edges stay resolved.
//
// 1. Preview (read-only):
MATCH (a:Entity)-[r:CONTRADICTS]->(b:Entity)
WHERE r.resolved IS NULL OR r.detected_date IS NULL
RETURN a.tenant_id AS tenant, a.id AS from_id, b.id AS to_id,
       r.resolved AS resolved, r.detected_date AS detected_date, r.ingested_at AS ingested_at;

// 2. Apply:
MATCH (:Entity)-[r:CONTRADICTS]->(:Entity)
WHERE r.resolved IS NULL OR r.detected_date IS NULL
SET r.resolved = coalesce(r.resolved, false),
    r.detected_date = coalesce(r.detected_date, r.ingested_at, datetime())
RETURN count(r) AS backfilled;
