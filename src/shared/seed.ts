import { Neo4jClient } from "./neo4j-client.js";

async function seed() {
  const client = new Neo4jClient(
    "bolt://localhost:7687",
    "neo4j",
    process.env.NEO4J_PASSWORD || "graph-memory-local",
  );

  // Seed everything under the bootstrap tenant. Override via env for testing.
  const T = process.env.BOOTSTRAP_TENANT_ID ?? "bootstrap";

  try {
    await client.verifyConnectivity();
    await client.initializeSchema();

    console.log(`Seeding graph (tenant=${T})...`);

    // ─── People ───
    await client.createEntity(T, "Person", "alice", "Alice", {
      relationship_to_user: "self",
      subtype: "individual",
    }, 1.0);

    // ─── Projects ───
    await client.createEntity(T, "Project", "graph-memory", "Graph Memory", {
      status: "active",
      subtype: "active",
      description: "Graph-based memory system for Claude Code using Neo4j",
      stack: "TypeScript, Node.js, Neo4j, MCP",
      directory: "/path/to/graph-memory",
    }, 0.9);

    // ─── Concepts / Technologies ───
    await client.createEntity(T, "Concept", "neo4j", "Neo4j", {
      category: "technology",
      subtype: "technology",
      description: "Graph database used for the memory system",
      user_expertise: "beginner",
    }, 0.8);

    await client.createEntity(T, "Concept", "typescript", "TypeScript", {
      category: "language",
      subtype: "language",
      user_expertise: "intermediate",
    }, 0.8);

    await client.createEntity(T, "Concept", "mcp", "Model Context Protocol", {
      category: "technology",
      subtype: "technology",
      description: "Protocol for exposing tools to Claude Code",
    }, 0.7);

    await client.createEntity(T, "Concept", "docker", "Docker", {
      category: "technology",
      subtype: "technology",
      user_expertise: "working",
    }, 0.7);

    await client.createEntity(T, "Concept", "claude-code", "Claude Code", {
      category: "technology",
      subtype: "tool",
      description: "Anthropic CLI for Claude, used with Max plan",
    }, 0.8);

    // ─── Objects ───
    await client.createEntity(T, "Object", "neo4j-container", "Neo4j Container", {
      object_type: "container",
      subtype: "container",
      status: "active",
      url: "bolt://localhost:7687",
      description: "Neo4j Community running in Docker on WSL2",
    }, 0.8);

    await client.createEntity(T, "Object", "graph-memory-repo", "graph-memory repo", {
      object_type: "repository",
      subtype: "repository",
      status: "active",
      url: "/path/to/graph-memory",
    }, 0.8);

    // ─── Decisions ───
    await client.createEntity(T, "Decision", "decision-neo4j", "Use Neo4j over Kuzu", {
      subtype: "architectural",
      what: "Use Neo4j Community instead of Kuzu for the graph database",
      why: "Kuzu npm package is deprecated, native bindings add Windows compilation complexity, no concurrent access support",
      status: "active",
      reversible: true,
    }, 0.8);

    await client.createEntity(T, "Decision", "decision-no-api-key", "No API key required", {
      subtype: "architectural",
      what: "All LLM work runs inside Claude Code sessions covered by Max plan",
      why: "MCP server is a dumb pipe to Neo4j — no LLM calls needed in the server",
      status: "active",
      reversible: false,
    }, 0.9);

    await client.createEntity(T, "Decision", "decision-dream-process", "Dream process as scheduled task", {
      subtype: "architectural",
      what: "Dream process runs as a Claude Code scheduled task, not a standalone script",
      why: "No API key needed — runs as full Claude Code session with Max plan",
      status: "active",
    }, 0.8);

    // ─── Preferences ───
    await client.createEntity(T, "Preference", "pref-max-plan", "Max plan for LLM", {
      subtype: "tools",
      domain: "tools",
      key: "llm_plan",
      value: "Anthropic Max plan",
    }, 0.9);

    // ─── Relationships ───
    const provenance = {
      source_session: "seed",
      source_type: "manual",
      source_tenant: T,
    };

    // Alice works on graph-memory
    await client.createRelationship(T, "alice", "graph-memory", "WORKS_ON", 0.9, { role: "lead" }, provenance);

    // Graph-memory uses technologies
    await client.createRelationship(T, "graph-memory", "neo4j", "USES_TECH", 0.9, { role: "primary" }, provenance);
    await client.createRelationship(T, "graph-memory", "typescript", "USES_TECH", 0.8, { role: "primary" }, provenance);
    await client.createRelationship(T, "graph-memory", "mcp", "USES_TECH", 0.8, { role: "primary" }, provenance);
    await client.createRelationship(T, "graph-memory", "docker", "USES_TECH", 0.6, { role: "infrastructure" }, provenance);

    // Alice knows about things
    await client.createRelationship(T, "alice", "typescript", "KNOWS_ABOUT", 0.7, { depth: "working" }, provenance);
    await client.createRelationship(T, "alice", "claude-code", "KNOWS_ABOUT", 0.7, { depth: "working" }, provenance);
    await client.createRelationship(T, "alice", "neo4j", "KNOWS_ABOUT", 0.3, { depth: "beginner" }, provenance);
    await client.createRelationship(T, "alice", "docker", "KNOWS_ABOUT", 0.5, { depth: "working" }, provenance);

    // Decisions relate to the project
    await client.createRelationship(T, "decision-neo4j", "graph-memory", "DECIDED_FOR", 0.8, {}, provenance);
    await client.createRelationship(T, "decision-no-api-key", "graph-memory", "DECIDED_FOR", 0.9, {}, provenance);
    await client.createRelationship(T, "decision-dream-process", "graph-memory", "DECIDED_FOR", 0.8, {}, provenance);

    // Objects
    await client.createRelationship(T, "graph-memory", "neo4j-container", "USES", 0.8, { purpose: "primary database" }, provenance);
    await client.createRelationship(T, "graph-memory", "graph-memory-repo", "RELATED_TO", 0.9, { relationship_type: "part_of" }, provenance);
    await client.createRelationship(T, "neo4j-container", "docker", "RELATED_TO", 0.7, { relationship_type: "implements" }, provenance);

    // Alice preferences
    await client.createRelationship(T, "alice", "pref-max-plan", "PREFERS", 0.9, { strength: "strong" }, provenance);

    // Print stats
    const stats = await client.getStats(T);
    console.log("\nSeed complete!");
    console.log(`Nodes: ${stats.nodes.total}`, stats.nodes.by_type);
    console.log(`Edges: ${stats.edges.total}`, stats.edges.by_type);

  } finally {
    await client.close();
  }
}

seed().catch(console.error);
