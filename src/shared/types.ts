// The documented vocabulary. GRAPH_SCHEMA.md is the human-readable source;
// these lists are what the write path enforces, so keep the two in step.
// Before 2026-09-23 these were compile-time types only and nothing checked
// them at runtime, which let the live graph grow to 29 node labels and 238
// relationship types.

export const ENTITY_TYPES = [
  "Person",
  "Organization",
  "Project",
  "Feature",
  "Concept",
  "Technology",
  "Decision",
  "Reasoning",
  "Preference",
  "Event",
  "Fact",
  "Artifact",
  "Object",
  "Resource",
  "Infrastructure",
  "Alias",
  "Location",
  "Issue",
  "Task",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export const RELATIONSHIP_TYPES = [
  // People and roles
  "WORKS_ON", "WORKS_AT", "REPORTS_TO", "STAKEHOLDER_IN",
  "KNOWS", "COLLABORATES_WITH", "FAMILY_OF", "MENTOR_OF",
  // Knowledge, preferences, decisions
  "KNOWS_ABOUT", "PREFERS", "DECIDED_FOR", "LED_TO", "INVOLVED_IN",
  // Tech and dependencies
  "USES", "USES_TECH", "DEPENDS_ON", "IMPLEMENTS", "EXTENDS",
  "INSPIRED_BY", "BUILDS_ON", "DERIVED_FROM", "HOSTED_ON",
  // Composition and taxonomy
  "CONTAINS", "PART_OF", "INSTANCE_OF", "CATEGORIZED_AS",
  // Reference and description
  "ABOUT", "DESCRIBES", "DOCUMENTS", "ATTRIBUTED_TO",
  // Authorship, production, governance
  "PRODUCED", "PRODUCED_BY", "AUTHORED", "CREATED", "AFFECTS", "GOVERNS",
  // Lifecycle and ordering
  "SUPERSEDES", "REPLACES", "DEPRECATED_BY", "BLOCKS", "BLOCKED_BY", "RESOLVED_BY",
  // Place and runtime
  "LOCATED_IN", "DEPLOYED_TO",
  // Events and temporal
  "PARTICIPATED_IN", "OCCURRED_DURING", "TRIGGERED_BY",
  // Identity and contradiction
  "ALIAS_OF", "CONTRADICTS", "RELATED_TO",
] as const;

export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export const RELATED_TO_SUBTYPES = [
  "similar_to",
  "part_of",
  "enables",
  "impacts",
  "depends_on",
  "alternative_to",
  "derived_from",
  "implements",
  "extends",
  "configured_by",
] as const;

export interface EntityNode {
  id: string;
  name: string;
  type: EntityType;
  subtype?: string;
  confidence: number;
  times_mentioned: number;
  first_seen: string;
  last_seen: string;
  source_file?: string;
  properties: Record<string, unknown>;
}

export interface RelationshipEdge {
  from: string;
  to: string;
  type: RelationshipType;
  weight: number;
  effective_weight?: number;
  last_confirmed: string;
  evidence?: string;
  // Bi-temporal modeling:
  //   valid_at      — when the fact became true in the world
  //   invalid_at    — when the fact stopped being true
  //   ingested_at   — when the system learned about it (set once on edge create, never updated)
  //   last_confirmed— most recent reinforcement (updated on every match)
  valid_at?: string | null;
  invalid_at?: string | null;
  ingested_at?: string | null;
  source_session?: string;
  source_transcript?: string;
  source_type?: string;
  properties: Record<string, unknown>;
}

export interface QueryResult {
  nodes: EntityNode[];
  edges: RelationshipEdge[];
  source_files: string[];
}

export interface BatchEntity {
  localId: string;
  name: string;
  type: EntityType;
  properties?: Record<string, unknown>;
}

export interface BatchRelation {
  from: string;
  to: string;
  relation: RelationshipType;
  weight: number;
  properties?: Record<string, unknown>;
  evidence?: string;
  valid_at?: string;
}

export interface BatchInput {
  entities: BatchEntity[];
  relations: BatchRelation[];
  source_session?: string;
  source_transcript?: string;
  source_type?: string;
}
