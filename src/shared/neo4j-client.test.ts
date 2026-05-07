import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Neo4jClient } from "./neo4j-client.js";

// Integration tests — require a running Neo4j instance.
//   Locally:   spin up a throwaway Neo4j on a non-production port and point
//              NEO4J_URI / NEO4J_PASSWORD at it (see docs/BACKUP.md or
//              docker run with -p 7689:7687 for a clean rig).
//   In CI:     a Neo4j 5.20 service container exposes bolt://localhost:7687
//              with NEO4J_AUTH=neo4j/test1234 (see .github/workflows/ci.yml).
//
// **Data safety**: every test run gets its own UUID-suffixed tenant id; we
// only ever delete data tagged with that tenant. Even if NEO4J_URI happens
// to point at a graph with real data, nothing outside the test tenant is
// touched. A startup guard refuses to run if the database holds non-test
// data — opt out with ALLOW_DESTRUCTIVE_TESTS=1 if you really mean it.

const TENANT_PREFIX = "test-";
const T = `${TENANT_PREFIX}${randomUUID().slice(0, 8)}`;

let client: Neo4jClient;

beforeAll(async () => {
  client = new Neo4jClient(
    process.env.NEO4J_URI ?? "bolt://localhost:7687",
    process.env.NEO4J_USER ?? "neo4j",
    process.env.NEO4J_PASSWORD ?? "graph-memory-local",
  );
  await client.verifyConnectivity();
  await client.initializeSchema();

  // Refuse to run if the connected graph has data we didn't create. Catches
  // the footgun where someone runs `npm test` against their real local
  // Neo4j with no env vars set — the defaults match production by design,
  // and per-tenant isolation alone won't reassure if the user thought they
  // were aimed at a clean rig.
  if (process.env.ALLOW_DESTRUCTIVE_TESTS !== "1") {
    const foreign = await client.countNodesOutsideTenantPrefix(TENANT_PREFIX);
    if (foreign > 0) {
      throw new Error(
        `Refusing to run tests: the connected Neo4j has ${foreign} node(s) ` +
        `outside the test-* tenant namespace. Point NEO4J_URI at a throwaway ` +
        `instance (e.g. docker run --rm -p 7689:7687 neo4j:5.20-community) ` +
        `or set ALLOW_DESTRUCTIVE_TESTS=1 if you really mean it.`,
      );
    }
  }
});

afterAll(async () => {
  // Best-effort cleanup of this run's tenant so re-runs against a long-lived
  // Neo4j don't accumulate orphaned nodes.
  try { await client.clearTenant(T); } catch { /* ignore */ }
  await client.close();
});

beforeEach(async () => {
  // Tenant-scoped reset — never touches data outside this run's tenant.
  await client.clearTenant(T);
});

describe("Entity CRUD", () => {
  it("should create an entity", async () => {
    const entity = await client.createEntity(T, "Person", "alice", "Alice", {
      role: "engineer",
    });
    expect(entity.id).toBe("alice");
    expect(entity.name).toBe("Alice");
    expect(entity.type).toBe("Person");
    expect(entity.confidence).toBe(0.5);
    expect(entity.times_mentioned).toBe(1);
    expect(entity.properties.role).toBe("engineer");
  });

  it("should merge on duplicate create (confidence-max)", async () => {
    await client.createEntity(T, "Person", "bob", "Bob", {}, 0.5);
    const merged = await client.createEntity(T, "Person", "bob", "Bob", {}, 0.8);
    expect(merged.confidence).toBe(0.8);
    expect(merged.times_mentioned).toBe(2);
  });

  it("should not downgrade confidence on merge", async () => {
    await client.createEntity(T, "Person", "carol", "Carol", {}, 0.8);
    const merged = await client.createEntity(T, "Person", "carol", "Carol", {}, 0.3);
    expect(merged.confidence).toBe(0.8);
  });

  it("should get an entity by id", async () => {
    await client.createEntity(T, "Project", "proj-x", "Project X", {
      status: "active",
    });
    const entity = await client.getEntity(T, "proj-x");
    expect(entity).not.toBeNull();
    expect(entity!.name).toBe("Project X");
    expect(entity!.type).toBe("Project");
  });

  it("should return null for non-existent entity", async () => {
    const entity = await client.getEntity(T, "does-not-exist");
    expect(entity).toBeNull();
  });

  it("should delete an entity", async () => {
    await client.createEntity(T, "Fact", "fact-1", "Test Fact");
    const deleted = await client.deleteEntity(T, "fact-1");
    expect(deleted).toBe(true);
    const entity = await client.getEntity(T, "fact-1");
    expect(entity).toBeNull();
  });
});

describe("Relationships", () => {
  beforeEach(async () => {
    await client.createEntity(T, "Person", "alice", "Alice");
    await client.createEntity(T, "Project", "proj-x", "Project X");
    await client.createEntity(T, "Concept", "typescript", "TypeScript");
  });

  it("should create a relationship", async () => {
    const edge = await client.createRelationship(
      T,
      "alice",
      "proj-x",
      "WORKS_ON",
      0.7,
      { role: "lead" },
    );
    expect(edge.from).toBe("alice");
    expect(edge.to).toBe("proj-x");
    expect(edge.type).toBe("WORKS_ON");
    expect(edge.weight).toBe(0.7);
    expect(edge.properties.role).toBe("lead");
  });

  it("should strengthen existing relationship with confidence-max", async () => {
    await client.createRelationship(T, "alice", "proj-x", "WORKS_ON", 0.5);
    const strengthened = await client.createRelationship(
      T,
      "alice",
      "proj-x",
      "WORKS_ON",
      0.8,
    );
    expect(strengthened.weight).toBe(0.8);
  });

  it("should boost by 0.05 when new weight is lower", async () => {
    await client.createRelationship(T, "alice", "proj-x", "WORKS_ON", 0.7);
    const boosted = await client.createRelationship(
      T,
      "alice",
      "proj-x",
      "WORKS_ON",
      0.3,
    );
    expect(boosted.weight).toBeCloseTo(0.75, 2);
  });

  it("should set provenance on relationship", async () => {
    const edge = await client.createRelationship(
      T,
      "alice",
      "proj-x",
      "WORKS_ON",
      0.7,
      {},
      {
        source_session: "session-123",
        source_transcript: "/path/to/transcript.jsonl",
        source_type: "conversation",
      },
    );
    expect(edge.source_session).toBe("session-123");
    expect(edge.source_type).toBe("conversation");
  });

  it("should get relationships for an entity", async () => {
    await client.createRelationship(T, "alice", "proj-x", "WORKS_ON", 0.7);
    await client.createRelationship(T, "proj-x", "typescript", "USES_TECH", 0.6);

    const aliceEdges = await client.getRelationships(T, "alice");
    expect(aliceEdges.length).toBe(1);
    expect(aliceEdges[0].type).toBe("WORKS_ON");

    const projEdges = await client.getRelationships(T, "proj-x", "both");
    expect(projEdges.length).toBe(2);
  });
});

describe("Weight Operations", () => {
  beforeEach(async () => {
    await client.createEntity(T, "Person", "alice", "Alice");
    await client.createEntity(T, "Preference", "tabs", "Tabs", {
      domain: "coding_style",
      key: "indentation",
      value: "tabs",
    });
    await client.createRelationship(T, "alice", "tabs", "PREFERS", 0.5);
  });

  it("should boost edge weight", async () => {
    const result = await client.boost(T, "alice", "tabs", "PREFERS", 0.15);
    expect(result.previous_weight).toBe(0.5);
    expect(result.new_weight).toBeCloseTo(0.65, 2);
  });

  it("should cap boost at 1.0", async () => {
    await client.boost(T, "alice", "tabs", "PREFERS", 0.4);
    const result = await client.boost(T, "alice", "tabs", "PREFERS", 0.4);
    expect(result.new_weight).toBeLessThanOrEqual(1.0);
  });

  it("should weaken edge weight", async () => {
    const result = await client.weaken(T, "alice", "tabs", "PREFERS", 0.2);
    expect(result.previous_weight).toBe(0.5);
    expect(result.new_weight).toBeCloseTo(0.3, 2);
  });

  it("should floor weaken at 0.0", async () => {
    const result = await client.weaken(T, "alice", "tabs", "PREFERS", 0.8);
    expect(result.new_weight).toBe(0.0);
  });
});

describe("Query / Traversal", () => {
  beforeEach(async () => {
    await client.createEntity(T, "Person", "alice", "Alice");
    await client.createEntity(T, "Project", "proj-x", "Project X", {
      directory: "/path/to/proj-x",
    });
    await client.createEntity(T, "Concept", "react", "React");
    await client.createEntity(T, "Concept", "neo4j", "Neo4j");
    await client.createRelationship(T, "alice", "proj-x", "WORKS_ON", 0.8);
    await client.createRelationship(T, "proj-x", "react", "USES_TECH", 0.7);
    await client.createRelationship(T, "proj-x", "neo4j", "USES_TECH", 0.6);
  });

  it("should traverse from an entity", async () => {
    const result = await client.query(T, ["Project X"], { max_hops: 2 });
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.edges.length).toBeGreaterThan(0);
  });

  it("should respect min_weight filter", async () => {
    const result = await client.query(T, ["Project X"], {
      max_hops: 2,
      min_weight: 0.65,
    });
    // Should include React (0.7) but not Neo4j (0.6)
    const nodeNames = result.nodes.map((n) => n.name);
    expect(nodeNames).toContain("React");
    expect(nodeNames).not.toContain("Neo4j");
  });

  it("should filter by entity type", async () => {
    const result = await client.query(T, ["Project X"], {
      max_hops: 2,
      entity_types: ["Person"],
    });
    for (const node of result.nodes) {
      expect(node.type).toBe("Person");
    }
  });
});

describe("Entity Search", () => {
  beforeEach(async () => {
    await client.createEntity(T, "Person", "alice", "Alice");
    await client.createEntity(T, "Person", "bob", "Bob");
    await client.createEntity(T, "Project", "proj-x", "Project X");
    await client.createEntity(T, "Concept", "react", "React");
  });

  it("should search by name", async () => {
    const result = await client.searchEntities(T, { search: "Alice" });
    expect(result.entities.length).toBeGreaterThan(0);
    expect(result.entities[0].name).toBe("Alice");
  });

  it("should filter by type", async () => {
    const result = await client.searchEntities(T, { type: "Person" });
    expect(result.entities.length).toBe(2);
    for (const e of result.entities) {
      expect(e.type).toBe("Person");
    }
  });

  it("should return total count", async () => {
    const result = await client.searchEntities(T, {});
    expect(result.total).toBe(4);
  });
});

describe("Batch Operations", () => {
  it("should create entities and relationships in batch", async () => {
    const result = await client.batchRelate(T, {
      entities: [
        { localId: "p1", name: "Dave", type: "Person" },
        { localId: "proj", name: "Graph Memory", type: "Project", properties: { status: "active" } },
        { localId: "ts", name: "TypeScript", type: "Concept" },
      ],
      relations: [
        { from: "p1", to: "proj", relation: "WORKS_ON", weight: 0.7, properties: { role: "lead" } },
        { from: "proj", to: "ts", relation: "USES_TECH", weight: 0.6 },
      ],
      source_session: "test-session",
      source_type: "conversation",
    });

    expect(result.entities_created).toBe(3);
    expect(result.edges_created).toBe(2);

    const dave = await client.getEntity(T, "dave");
    expect(dave).not.toBeNull();
    expect(dave!.name).toBe("Dave");

    const edges = await client.getRelationships(T, "dave", "out");
    expect(edges.length).toBe(1);
    expect(edges[0].source_session).toBe("test-session");
  });
});

describe("Contradictions", () => {
  it("should find unresolved contradictions", async () => {
    await client.createEntity(T, "Fact", "fact-vue", "Project X uses Vue");
    await client.createEntity(T, "Fact", "fact-react", "Project X uses React");
    await client.createRelationship(T, "fact-vue", "fact-react", "CONTRADICTS", 1.0, {
      description: "Conflicting tech stack",
      detected_date: new Date().toISOString(),
      resolved: false,
    });

    const result = await client.findContradictions(T);
    expect(result.count).toBe(1);
    expect(result.contradictions[0].description).toBe("Conflicting tech stack");
  });
});

describe("Stats", () => {
  it("should return graph statistics", async () => {
    await client.createEntity(T, "Person", "alice", "Alice");
    await client.createEntity(T, "Project", "proj-x", "Project X");
    await client.createRelationship(T, "alice", "proj-x", "WORKS_ON", 0.7);

    const stats = await client.getStats(T);
    expect(stats.nodes.total).toBeGreaterThanOrEqual(2);
    expect(stats.nodes.by_type.Person).toBe(1);
    expect(stats.nodes.by_type.Project).toBe(1);
    expect(stats.edges.total).toBe(1);
    expect(stats.edges.by_type.WORKS_ON).toBe(1);
  });
});

describe("Raw Cypher", () => {
  it("should execute read-only Cypher", async () => {
    await client.createEntity(T, "Person", "alice", "Alice");
    const result = await client.executeCypher(
      "MATCH (n:Person) RETURN n.name AS name",
    );
    expect(result.result_count).toBe(1);
    expect(result.results[0].name).toBe("Alice");
    expect(result.execution_time_ms).toBeGreaterThanOrEqual(0);
  });
});

describe("Unmerge", () => {
  it("should split a falsely merged entity", async () => {
    // "anna-anne" has edges that belong to two different people.
    await client.createEntity(T, "Person", "anna-anne", "Anna");
    await client.createEntity(T, "Project", "proj-a", "Project A");
    await client.createEntity(T, "Project", "proj-b", "Project B");
    await client.createRelationship(T, "anna-anne", "proj-a", "WORKS_ON", 0.8);
    await client.createRelationship(T, "anna-anne", "proj-b", "WORKS_ON", 0.6);

    const result = await client.unmerge(
      T,
      "anna-anne",
      "Anne",
      "Person",
      [{ other_entity_id: "proj-b", relation_type: "WORKS_ON", direction: "out" }],
      "False merge of Anna and Anne",
    );

    expect(result.original.id).toBe("anna-anne");
    expect(result.original.remaining_edges).toBe(1);
    expect(result.new_entity.name).toBe("Anne");
    expect(result.new_entity.moved_edges).toBe(1);

    const anne = await client.getEntity(T, "anne");
    expect(anne).not.toBeNull();
    expect(anne!.type).toBe("Person");
  });
});

describe("Merge", () => {
  // Classic dedupe scenario: Anna and Anne refer to the same person.
  beforeEach(async () => {
    await client.createEntity(T, "Person", "anna", "Anna",
      { role: "engineer", nickname: "annie" }, 0.6);
    await client.createEntity(T, "Person", "anne", "Anne",
      { role: "senior engineer" }, 0.7);
    await client.createEntity(T, "Project", "gm", "graph-memory", {}, 0.5);
    await client.createEntity(T, "Project", "cc", "claude-code", {}, 0.5);
    await client.createEntity(T, "Person", "bob", "Bob", {}, 0.5);

    await client.createRelationship(T, "anna", "gm", "WORKS_ON", 0.4);
    await client.createRelationship(T, "anne", "gm", "WORKS_ON", 0.7);     // overlap → consolidate
    await client.createRelationship(T, "anna", "cc", "WORKS_ON", 0.6);     // unique → move
    await client.createRelationship(T, "bob",  "anna", "WORKS_WITH", 0.5); // incoming → re-target
    await client.createRelationship(T, "anna", "anne", "ALIAS_OF", 0.9);   // self-loop → drop
  });

  it("should preview without mutating on dry_run", async () => {
    const dry = await client.merge(T, "anna", "anne", { dryRun: true });
    expect(dry.dry_run).toBe(true);
    expect(dry.source.deleted).toBe(false);
    expect(dry.self_loops_dropped).toBe(1);
    expect(dry.edges_added).toBeGreaterThanOrEqual(3);

    // Anna still exists after a dry run.
    const stillThere = await client.getEntity(T, "anna");
    expect(stillThere?.id).toBe("anna");
  });

  it("should consolidate edges, retarget incoming, drop self-loops, adopt source-only properties", async () => {
    const result = await client.merge(T, "anna", "anne");

    expect(result.source.deleted).toBe(true);
    expect(result.self_loops_dropped).toBe(1);
    expect(result.edges_added).toBeGreaterThanOrEqual(2);
    expect(result.edges_consolidated).toBeGreaterThanOrEqual(1);
    expect(result.properties_adopted).toContain("nickname");
    // Target wins on conflicting keys.
    expect(result.properties_adopted).not.toContain("role");

    // Anna is gone.
    const annaGone = await client.getEntity(T, "anna");
    expect(annaGone).toBeNull();

    // Anne kept her own role + adopted Anna's nickname.
    const anne = await client.getEntity(T, "anne");
    expect(anne).not.toBeNull();
    expect(anne!.properties.nickname).toBe("annie");
    expect(anne!.properties.role).toBe("senior engineer");

    // Edges: anne→gm consolidated to weight 0.7 (max of 0.4, 0.7).
    const out = await client.getRelationships(T, "anne", "out");
    const annGm = out.find((e) => e.type === "WORKS_ON" && e.to === "gm");
    expect(annGm?.weight).toBe(0.7);
    // anne→cc moved from anna with original 0.6.
    const annCc = out.find((e) => e.type === "WORKS_ON" && e.to === "cc");
    expect(annCc?.weight).toBe(0.6);

    // Incoming bob→anne (re-targeted from bob→anna).
    const inn = await client.getRelationships(T, "anne", "in");
    const bobAnn = inn.find((e) => e.type === "WORKS_WITH" && e.from === "bob");
    expect(bobAnn?.weight).toBe(0.5);

    // ALIAS_OF self-loop is gone.
    const all = [...out, ...inn];
    expect(all.find((e) => e.type === "ALIAS_OF")).toBeUndefined();
  });

  it("should refuse to merge an entity with itself", async () => {
    await expect(client.merge(T, "anne", "anne")).rejects.toThrow(/itself/i);
  });

  it("should refuse to merge a non-existent source", async () => {
    await expect(client.merge(T, "nobody", "anne")).rejects.toThrow(/not found/i);
  });

  it("should refuse to merge into a non-existent target", async () => {
    await expect(client.merge(T, "anna", "nobody")).rejects.toThrow(/not found/i);
  });
});

// Per-type decay rates from src/shared/config.ts. Mirrored here so the test
// catches either a config drift (rate changes without test update) or a
// formula bug (decay output diverges from rate^days).
const DECAY_RATES = {
  Person: 0.998,
  Project: 0.995,
  Preference: 0.999,
  Concept: 0.999,
  Decision: 0.997,
  Fact: 0.996,
  Event: 0.993,
  Object: 0.996,
};
const EDGE_DECAY_RATE = 0.997;

describe("Decay", () => {
  it("applies the per-type rate to node confidence proportional to days elapsed", async () => {
    await client.createEntity(T, "Person", "alice", "Alice", {}, 0.8);
    await client.setNodeLastSeen(T, "alice", 30); // 30 days stale

    const result = await client.applyDecay(T);
    expect(result.nodes_decayed).toBeGreaterThanOrEqual(1);

    const alice = await client.getEntity(T, "alice");
    // Confidence should be ~ 0.8 * 0.998^30 ≈ 0.7533
    const expected = 0.8 * Math.pow(DECAY_RATES.Person, 30);
    expect(alice!.confidence).toBeCloseTo(expected, 2);
  });

  it("decays different entity types at different rates", async () => {
    // Project (0.995) decays faster than Preference (0.999) over the same window.
    await client.createEntity(T, "Project", "proj-x", "Project X", {}, 0.8);
    await client.createEntity(T, "Preference", "pref-x", "Tabs", {}, 0.8);
    await client.setNodeLastSeen(T, "proj-x", 30);
    await client.setNodeLastSeen(T, "pref-x", 30);

    await client.applyDecay(T);

    const proj = await client.getEntity(T, "proj-x");
    const pref = await client.getEntity(T, "pref-x");
    expect(proj!.confidence).toBeLessThan(pref!.confidence);
  });

  it("floors confidence at 0.01 even after extreme decay", async () => {
    // Event has the steepest rate (0.993). Backdating 1000 days → mathematically
    // 0.5 * 0.993^1000 ≈ 0.0005, but the floor clamps it at 0.01.
    await client.createEntity(T, "Event", "ancient", "Ancient Event", {}, 0.5);
    await client.setNodeLastSeen(T, "ancient", 1000);

    await client.applyDecay(T);

    const e = await client.getEntity(T, "ancient");
    expect(e!.confidence).toBe(0.01);
  });

  it("does not decay nodes seen within the last day", async () => {
    // Fresh node — no last_seen backdating. Decay should leave it alone.
    await client.createEntity(T, "Person", "fresh", "Fresh Person", {}, 0.7);

    await client.applyDecay(T);

    const fresh = await client.getEntity(T, "fresh");
    expect(fresh!.confidence).toBe(0.7);
  });

  it("decays edges using the global edge rate, independent of node types", async () => {
    await client.createEntity(T, "Person", "alice", "Alice", {}, 0.9);
    await client.createEntity(T, "Project", "proj", "Project", {}, 0.9);
    await client.createRelationship(T, "alice", "proj", "WORKS_ON", 0.8);
    await client.setEdgeLastConfirmed(T, "alice", "proj", "WORKS_ON", 50);

    const result = await client.applyDecay(T);
    expect(result.edges_decayed).toBeGreaterThanOrEqual(1);

    const edges = await client.getRelationships(T, "alice", "out");
    const edge = edges.find((e) => e.type === "WORKS_ON");
    // Expected: 0.8 * 0.997^50 ≈ 0.6884
    const expected = 0.8 * Math.pow(EDGE_DECAY_RATE, 50);
    expect(edge!.weight).toBeCloseTo(expected, 2);
  });

  it("dry_run reports a count without mutating", async () => {
    await client.createEntity(T, "Person", "alice", "Alice", {}, 0.8);
    await client.setNodeLastSeen(T, "alice", 30);

    const dry = await client.applyDecay(T, true);
    expect(dry.nodes_decayed).toBeGreaterThanOrEqual(1);

    const alice = await client.getEntity(T, "alice");
    // Untouched — dry_run is preview-only.
    expect(alice!.confidence).toBe(0.8);
  });

  it("flags nodes for pruning when confidence drops below the threshold and edges are weak", async () => {
    // Below-threshold node with a weak edge → flagged.
    // Event has the steepest rate (0.993). Starting at 0.5 with 500-day backdate
    // gives 0.5 * 0.993^500 ≈ 0.015, well below the 0.1 prune threshold.
    await client.createEntity(T, "Event", "stale-event", "Stale Event", {}, 0.5);
    await client.createEntity(T, "Person", "anchor", "Anchor", {}, 0.9);
    await client.createRelationship(T, "stale-event", "anchor", "PARTICIPATED_IN", 0.04); // below 0.05 edge threshold
    await client.setNodeLastSeen(T, "stale-event", 500);

    const result = await client.applyDecay(T);
    expect(result.nodes_flagged_for_pruning).toBeGreaterThanOrEqual(1);
  });
});

describe("Bi-temporal queries", () => {
  beforeEach(async () => {
    await client.createEntity(T, "Person", "alice", "Alice");
    await client.createEntity(T, "Project", "old-proj", "Old Project");
    await client.createEntity(T, "Project", "new-proj", "New Project");
  });

  it("excludes edges marked invalid_at when current_only=true (default)", async () => {
    await client.createRelationship(T, "alice", "old-proj", "WORKS_ON", 0.7);
    await client.createRelationship(T, "alice", "new-proj", "WORKS_ON", 0.8);
    // Mark the old fact as superseded.
    await client.setEdgeInvalidAt(T, "alice", "old-proj", "WORKS_ON", "2026-01-01T00:00:00Z");

    const result = await client.query(T, ["Alice"], { max_hops: 1 });
    const projectNames = result.nodes.map((n) => n.name);
    expect(projectNames).toContain("New Project");
    expect(projectNames).not.toContain("Old Project");
  });

  it("includes superseded edges when current_only=false", async () => {
    await client.createRelationship(T, "alice", "old-proj", "WORKS_ON", 0.7);
    await client.createRelationship(T, "alice", "new-proj", "WORKS_ON", 0.8);
    await client.setEdgeInvalidAt(T, "alice", "old-proj", "WORKS_ON", "2026-01-01T00:00:00Z");

    const result = await client.query(T, ["Alice"], {
      max_hops: 1,
      current_only: false,
    });
    const projectNames = result.nodes.map((n) => n.name);
    expect(projectNames).toContain("New Project");
    expect(projectNames).toContain("Old Project");
  });

  it("setEdgeInvalidAt does not delete the edge — it remains discoverable on the node", async () => {
    await client.createRelationship(T, "alice", "old-proj", "WORKS_ON", 0.7);
    await client.setEdgeInvalidAt(T, "alice", "old-proj", "WORKS_ON", "2026-01-01T00:00:00Z");

    // Raw edge listing isn't filtered by invalid_at — the edge still exists,
    // it's only hidden from query() under the current_only filter.
    const edges = await client.getRelationships(T, "alice", "out");
    expect(edges.find((e) => e.to === "old-proj" && e.type === "WORKS_ON")).toBeDefined();
  });

  it("preserves valid_at on relationships when supplied", async () => {
    const validAt = "2025-06-15T12:00:00Z";
    const edge = await client.createRelationship(
      T,
      "alice",
      "old-proj",
      "WORKS_ON",
      0.7,
      {},
      undefined,
      validAt,
    );
    expect(edge.valid_at).toContain("2025-06-15");
  });
});

describe("Contradictions edge cases", () => {
  beforeEach(async () => {
    await client.createEntity(T, "Fact", "fact-vue", "Project X uses Vue");
    await client.createEntity(T, "Fact", "fact-react", "Project X uses React");
  });

  it("excludes resolved contradictions by default", async () => {
    await client.createRelationship(T, "fact-vue", "fact-react", "CONTRADICTS", 1.0, {
      description: "Tech stack conflict",
      detected_date: new Date().toISOString(),
      resolved: true,
    });

    const result = await client.findContradictions(T);
    expect(result.count).toBe(0);
  });

  it("surfaces resolved contradictions when include_resolved=true", async () => {
    await client.createRelationship(T, "fact-vue", "fact-react", "CONTRADICTS", 1.0, {
      description: "Tech stack conflict",
      detected_date: new Date().toISOString(),
      resolved: true,
    });

    const result = await client.findContradictions(T, true);
    expect(result.count).toBe(1);
    expect(result.contradictions[0].resolved).toBe(true);
  });

  it("orders contradictions by detected_date descending", async () => {
    await client.createEntity(T, "Fact", "fact-a", "Fact A");
    await client.createEntity(T, "Fact", "fact-b", "Fact B");
    await client.createEntity(T, "Fact", "fact-c", "Fact C");
    await client.createEntity(T, "Fact", "fact-d", "Fact D");

    await client.createRelationship(T, "fact-a", "fact-b", "CONTRADICTS", 1.0, {
      description: "Older",
      detected_date: "2025-01-01T00:00:00Z",
      resolved: false,
    });
    await client.createRelationship(T, "fact-c", "fact-d", "CONTRADICTS", 1.0, {
      description: "Newer",
      detected_date: "2026-04-01T00:00:00Z",
      resolved: false,
    });

    const result = await client.findContradictions(T);
    expect(result.count).toBe(2);
    expect(result.contradictions[0].description).toBe("Newer");
    expect(result.contradictions[1].description).toBe("Older");
  });

  it("isolates across tenants — contradictions in tenant A do not surface for tenant B", async () => {
    const T2 = `${TENANT_PREFIX}xtenant-${randomUUID().slice(0, 8)}`;
    try {
      // Tenant A has a contradiction.
      await client.createRelationship(T, "fact-vue", "fact-react", "CONTRADICTS", 1.0, {
        description: "A's conflict",
        detected_date: new Date().toISOString(),
        resolved: false,
      });

      // Tenant B has its own pair, no contradiction.
      await client.createEntity(T2, "Fact", "b-fact-1", "B Fact 1");
      await client.createEntity(T2, "Fact", "b-fact-2", "B Fact 2");

      const aResult = await client.findContradictions(T);
      expect(aResult.count).toBe(1);

      const bResult = await client.findContradictions(T2);
      expect(bResult.count).toBe(0);
    } finally {
      await client.clearTenant(T2);
    }
  });
});
