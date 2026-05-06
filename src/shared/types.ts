export const ENTITY_TYPES = [
  "Person",
  "Project",
  "Preference",
  "Concept",
  "Decision",
  "Fact",
  "Event",
  "Object",
  "Reasoning",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export const RELATIONSHIP_TYPES = [
  "WORKS_ON",
  "PREFERS",
  "KNOWS_ABOUT",
  "DEPENDS_ON",
  "USES_TECH",
  "DECIDED_FOR",
  "SUPERSEDES",
  "CONTRADICTS",
  "RELATED_TO",
  "ALIAS_OF",
  "PARTICIPATED_IN",
  "OCCURRED_DURING",
  "PRODUCED",
  "TRIGGERED_BY",
  "USES",
  "HOSTED_ON",
  "PRODUCED_BY",
  // Reasoning trace edges (Reasoning -> any)
  "LED_TO",       // Reasoning -> Decision/Event/Fact (this thinking led to that outcome)
  "INVOLVED_IN",  // Reasoning -> Person/Project/Concept/Object (these entities took part in the reasoning)
  // Organizational relationships (added 2026-05-06 after claude.ai introduced them)
  "WORKS_AT",     // Person -> Organization (employment / membership)
  "REPORTS_TO",   // Person -> Person (org hierarchy)
  "STAKEHOLDER_IN", // Person -> Decision/Project/Event (interested party, not necessarily decider)
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
