import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Neo4jClient } from "./neo4j-client.js";

// Integration tests — require a running Neo4j instance.
//   Locally:   NEO4J_PASSWORD=graph-memory-local npm test
//   In CI:     a Neo4j 5.20 service container exposes bolt://localhost:7687
//              with NEO4J_AUTH=neo4j/test1234 (see .github/workflows/ci.yml).
//
// All tests run as a single fixed tenant id; clearAll() between tests wipes
// the whole database, so cross-tenant leakage isn't exercised here. Multi-
// tenant boundary tests would belong in a separate file.

const T = "test";

let client: Neo4jClient;

beforeAll(async () => {
  client = new Neo4jClient(
    process.env.NEO4J_URI ?? "bolt://localhost:7687",
    process.env.NEO4J_USER ?? "neo4j",
    process.env.NEO4J_PASSWORD ?? "graph-memory-local",
  );
  await client.verifyConnectivity();
  await client.initializeSchema();
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await client.clearAll();
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
