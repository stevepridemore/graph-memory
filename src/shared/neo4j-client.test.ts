import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Neo4jClient } from "./neo4j-client.js";

// These are integration tests — they require a running Neo4j instance.
// Run with: NEO4J_PASSWORD=graph-memory-local npm test

let client: Neo4jClient;

beforeAll(async () => {
  client = new Neo4jClient(
    "bolt://localhost:7687",
    "neo4j",
    process.env.NEO4J_PASSWORD || "graph-memory-local",
  );
  await client.verifyConnectivity();
  await client.initializeSchema();
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  // Clean the database between tests (direct write, not through read-only executeCypher)
  await client.clearAll();
});

describe("Entity CRUD", () => {
  it("should create an entity", async () => {
    const entity = await client.createEntity("Person", "alice", "Alice", {
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
    await client.createEntity("Person", "bob", "Bob", {}, 0.5);
    const merged = await client.createEntity("Person", "bob", "Bob", {}, 0.8);
    expect(merged.confidence).toBe(0.8);
    expect(merged.times_mentioned).toBe(2);
  });

  it("should not downgrade confidence on merge", async () => {
    await client.createEntity("Person", "carol", "Carol", {}, 0.8);
    const merged = await client.createEntity("Person", "carol", "Carol", {}, 0.3);
    expect(merged.confidence).toBe(0.8);
  });

  it("should get an entity by id", async () => {
    await client.createEntity("Project", "proj-x", "Project X", {
      status: "active",
    });
    const entity = await client.getEntity("proj-x");
    expect(entity).not.toBeNull();
    expect(entity!.name).toBe("Project X");
    expect(entity!.type).toBe("Project");
  });

  it("should return null for non-existent entity", async () => {
    const entity = await client.getEntity("does-not-exist");
    expect(entity).toBeNull();
  });

  it("should delete an entity", async () => {
    await client.createEntity("Fact", "fact-1", "Test Fact");
    const deleted = await client.deleteEntity("fact-1");
    expect(deleted).toBe(true);
    const entity = await client.getEntity("fact-1");
    expect(entity).toBeNull();
  });
});

describe("Relationships", () => {
  beforeEach(async () => {
    await client.createEntity("Person", "alice", "Alice");
    await client.createEntity("Project", "proj-x", "Project X");
    await client.createEntity("Concept", "typescript", "TypeScript");
  });

  it("should create a relationship", async () => {
    const edge = await client.createRelationship(
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
    await client.createRelationship("alice", "proj-x", "WORKS_ON", 0.5);
    const strengthened = await client.createRelationship(
      "alice",
      "proj-x",
      "WORKS_ON",
      0.8,
    );
    expect(strengthened.weight).toBe(0.8);
  });

  it("should boost by 0.05 when new weight is lower", async () => {
    await client.createRelationship("alice", "proj-x", "WORKS_ON", 0.7);
    const boosted = await client.createRelationship(
      "alice",
      "proj-x",
      "WORKS_ON",
      0.3,
    );
    expect(boosted.weight).toBeCloseTo(0.75, 2);
  });

  it("should set provenance on relationship", async () => {
    const edge = await client.createRelationship(
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
    await client.createRelationship("alice", "proj-x", "WORKS_ON", 0.7);
    await client.createRelationship("proj-x", "typescript", "USES_TECH", 0.6);

    const aliceEdges = await client.getRelationships("alice");
    expect(aliceEdges.length).toBe(1);
    expect(aliceEdges[0].type).toBe("WORKS_ON");

    const projEdges = await client.getRelationships("proj-x", "both");
    expect(projEdges.length).toBe(2);
  });
});

describe("Weight Operations", () => {
  beforeEach(async () => {
    await client.createEntity("Person", "alice", "Alice");
    await client.createEntity("Preference", "tabs", "Tabs", {
      domain: "coding_style",
      key: "indentation",
      value: "tabs",
    });
    await client.createRelationship("alice", "tabs", "PREFERS", 0.5);
  });

  it("should boost edge weight", async () => {
    const result = await client.boost("alice", "tabs", "PREFERS", 0.15);
    expect(result.previous_weight).toBe(0.5);
    expect(result.new_weight).toBeCloseTo(0.65, 2);
  });

  it("should cap boost at 1.0", async () => {
    await client.boost("alice", "tabs", "PREFERS", 0.4);
    const result = await client.boost("alice", "tabs", "PREFERS", 0.4);
    expect(result.new_weight).toBeLessThanOrEqual(1.0);
  });

  it("should weaken edge weight", async () => {
    const result = await client.weaken("alice", "tabs", "PREFERS", 0.2);
    expect(result.previous_weight).toBe(0.5);
    expect(result.new_weight).toBeCloseTo(0.3, 2);
  });

  it("should floor weaken at 0.0", async () => {
    const result = await client.weaken("alice", "tabs", "PREFERS", 0.8);
    expect(result.new_weight).toBe(0.0);
  });
});

describe("Query / Traversal", () => {
  beforeEach(async () => {
    await client.createEntity("Person", "alice", "Alice");
    await client.createEntity("Project", "proj-x", "Project X", {
      directory: "/path/to/proj-x",
    });
    await client.createEntity("Concept", "react", "React");
    await client.createEntity("Concept", "neo4j", "Neo4j");
    await client.createRelationship("alice", "proj-x", "WORKS_ON", 0.8);
    await client.createRelationship("proj-x", "react", "USES_TECH", 0.7);
    await client.createRelationship("proj-x", "neo4j", "USES_TECH", 0.6);
  });

  it("should traverse from an entity", async () => {
    const result = await client.query(["Project X"], { max_hops: 2 });
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.edges.length).toBeGreaterThan(0);
  });

  it("should respect min_weight filter", async () => {
    const result = await client.query(["Project X"], {
      max_hops: 2,
      min_weight: 0.65,
    });
    // Should include React (0.7) but not Neo4j (0.6)
    const nodeNames = result.nodes.map((n) => n.name);
    expect(nodeNames).toContain("React");
    expect(nodeNames).not.toContain("Neo4j");
  });

  it("should filter by entity type", async () => {
    const result = await client.query(["Project X"], {
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
    await client.createEntity("Person", "alice", "Alice");
    await client.createEntity("Person", "bob", "Bob");
    await client.createEntity("Project", "proj-x", "Project X");
    await client.createEntity("Concept", "react", "React");
  });

  it("should search by name", async () => {
    const result = await client.searchEntities({ search: "Alice" });
    expect(result.entities.length).toBeGreaterThan(0);
    expect(result.entities[0].name).toBe("Alice");
  });

  it("should filter by type", async () => {
    const result = await client.searchEntities({ type: "Person" });
    expect(result.entities.length).toBe(2);
    for (const e of result.entities) {
      expect(e.type).toBe("Person");
    }
  });

  it("should return total count", async () => {
    const result = await client.searchEntities({});
    expect(result.total).toBe(4);
  });
});

describe("Batch Operations", () => {
  it("should create entities and relationships in batch", async () => {
    const result = await client.batchRelate({
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

    // Verify entities exist
    const dave = await client.getEntity("dave");
    expect(dave).not.toBeNull();
    expect(dave!.name).toBe("Dave");

    // Verify relationship exists with provenance
    const edges = await client.getRelationships("dave", "out");
    expect(edges.length).toBe(1);
    expect(edges[0].source_session).toBe("test-session");
  });
});

describe("Contradictions", () => {
  it("should find unresolved contradictions", async () => {
    await client.createEntity("Fact", "fact-vue", "Project X uses Vue");
    await client.createEntity("Fact", "fact-react", "Project X uses React");
    await client.createRelationship("fact-vue", "fact-react", "CONTRADICTS", 1.0, {
      description: "Conflicting tech stack",
      detected_date: new Date().toISOString(),
      resolved: false,
    });

    const result = await client.findContradictions();
    expect(result.count).toBe(1);
    expect(result.contradictions[0].description).toBe("Conflicting tech stack");
  });
});

describe("Stats", () => {
  it("should return graph statistics", async () => {
    await client.createEntity("Person", "alice", "Alice");
    await client.createEntity("Project", "proj-x", "Project X");
    await client.createRelationship("alice", "proj-x", "WORKS_ON", 0.7);

    const stats = await client.getStats();
    expect(stats.nodes.total).toBeGreaterThanOrEqual(2);
    expect(stats.nodes.by_type.Person).toBe(1);
    expect(stats.nodes.by_type.Project).toBe(1);
    expect(stats.edges.total).toBe(1);
    expect(stats.edges.by_type.WORKS_ON).toBe(1);
  });
});

describe("Raw Cypher", () => {
  it("should execute read-only Cypher", async () => {
    await client.createEntity("Person", "alice", "Alice");
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
    // Setup: "anna-anne" has edges that belong to two different people
    await client.createEntity("Person", "anna-anne", "Anna");
    await client.createEntity("Project", "proj-a", "Project A");
    await client.createEntity("Project", "proj-b", "Project B");
    await client.createRelationship("anna-anne", "proj-a", "WORKS_ON", 0.8);
    await client.createRelationship("anna-anne", "proj-b", "WORKS_ON", 0.6);

    const result = await client.unmerge(
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

    // Verify the new entity exists
    const anne = await client.getEntity("anne");
    expect(sara).not.toBeNull();
    expect(anne!.type).toBe("Person");
  });
});
