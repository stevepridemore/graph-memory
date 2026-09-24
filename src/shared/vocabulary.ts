// Write-path validation for graph-memory.
//
// Cypher cannot parameterize labels or relationship types, so the client
// interpolates them into query text inside backticks. Before 2026-09-23 those
// strings came straight from tool input with only a TypeScript cast in the way,
// so a backtick in a relation name closed the identifier and let the rest of
// the string run as Cypher. That bypassed tenant isolation, which is enforced
// only by predicates in the query text.
//
// Everything that reaches an interpolated identifier now passes through here.
// The same choke point also enforces the documented vocabulary, which is what
// the missing check had allowed to sprawl to 29 labels and 238 edge types.

import {
  ENTITY_TYPES,
  RELATIONSHIP_TYPES,
  type EntityType,
  type RelationshipType,
} from "./types.js";

export class InvalidIdentifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidIdentifierError";
  }
}

// Letters, digits and underscores, starting with a letter. No backticks, no
// whitespace, nothing that can end a quoted identifier.
const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Throw unless `value` is safe to interpolate as a label or relationship
 *  type. Use this for identifiers that may name existing data (boost, weaken,
 *  filters), where the vocabulary must not be enforced. */
export function assertSafeIdentifier(kind: string, value: unknown): string {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) {
    const shown = typeof value === "string" ? JSON.stringify(value.slice(0, 80)) : typeof value;
    throw new InvalidIdentifierError(
      `invalid ${kind} ${shown}: must be 1-64 letters, digits or underscores, starting with a letter`,
    );
  }
  return value;
}

export const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// ─── Enforcement mode ───────────────────────────────────────────────────────
//
// What to do with a well-formed identifier that is not in the vocabulary.
//   coerce  (default)  write it as the fallback type or verb and keep the
//                      original on the node or edge, so nothing is lost and
//                      no new label or relationship type is created
//   lenient            write it as given, the pre-2026-09-23 behaviour
//   strict             reject it
// The injection check applies in every mode.

export type SchemaEnforcement = "coerce" | "lenient" | "strict";

export function getSchemaEnforcement(): SchemaEnforcement {
  const v = (process.env.SCHEMA_ENFORCEMENT ?? "coerce").toLowerCase();
  if (v === "coerce" || v === "lenient" || v === "strict") return v;
  process.stderr.write(`[graph-memory] unknown SCHEMA_ENFORCEMENT=${v}, using "coerce"\n`);
  return "coerce";
}

export interface Normalized<T extends string> {
  value: T;
  /** The input, when it differed from `value`. */
  coercedFrom?: string;
  /** True when the input was not in the vocabulary at all, as opposed to a
   *  case difference or a known alias. */
  unknown?: boolean;
}

// ─── Entity types ───────────────────────────────────────────────────────────

export const FALLBACK_ENTITY_TYPE: EntityType = "Object";

const ENTITY_TYPE_BY_LOWER = new Map<string, EntityType>(
  ENTITY_TYPES.map((t) => [t.toLowerCase(), t]),
);

// Labels the extractor has invented, mapped to the documented type they meant.
// These are the mappings applied to the live graph on 2026-09-23.
const ENTITY_TYPE_ALIASES: Record<string, EntityType> = {
  tool: "Technology",
  document: "Artifact",
  topic: "Concept",
  system: "Infrastructure",
  account: "Object",
  domain: "Object",
  milestone: "Event",
  product: "Object",
  legalasset: "Object",
  automation: "Object",
  place: "Location",
};

export function normalizeEntityType(raw: unknown): Normalized<EntityType> {
  const input = assertSafeIdentifier("entity type", raw);
  const lower = input.toLowerCase();

  const documented = ENTITY_TYPE_BY_LOWER.get(lower);
  if (documented) {
    return documented === input ? { value: documented } : { value: documented, coercedFrom: input };
  }
  const alias = ENTITY_TYPE_ALIASES[lower];
  if (alias) return { value: alias, coercedFrom: input };

  const mode = getSchemaEnforcement();
  if (mode === "strict") {
    throw new InvalidIdentifierError(
      `entity type "${input}" is not in the documented vocabulary (${ENTITY_TYPES.join(", ")})`,
    );
  }
  if (mode === "lenient") return { value: input as EntityType, unknown: true };
  return { value: FALLBACK_ENTITY_TYPE, coercedFrom: input, unknown: true };
}

// ─── Relationship types ─────────────────────────────────────────────────────

export const FALLBACK_RELATION: RelationshipType = "RELATED_TO";

const RELATIONS = new Set<string>(RELATIONSHIP_TYPES);

// Spellings that mean exactly the documented verb, in the SAME direction.
// Inverse forms (CREATED_BY, DOCUMENTED_IN, RESOLVES, ...) are deliberately
// absent: mapping them without swapping the endpoints would reverse the fact.
// They fall through to the unknown-verb handling, which keeps the original.
const RELATION_ALIASES: Record<string, RelationshipType> = {
  RELATES_TO: "RELATED_TO",
  USES_TECHNOLOGY: "USES_TECH",
  BUILT_WITH: "USES_TECH",
  LOCATED_AT: "LOCATED_IN",
  DEPLOYED_AT: "DEPLOYED_TO",
  DEPLOYED_ON: "DEPLOYED_TO",
  DEPLOYED_IN: "DEPLOYED_TO",
  RUNS_ON: "DEPLOYED_TO",
  PARTICIPATES_IN: "PARTICIPATED_IN",
  PARTICIPANT_IN: "PARTICIPATED_IN",
  IS_STAKEHOLDER_IN: "STAKEHOLDER_IN",
  WORKS_WITH: "COLLABORATES_WITH",
  HAS_PREFERENCE: "PREFERS",
  DECIDED: "DECIDED_FOR",
  // Every IMPACTS edge sampled in the live graph was Decision/Fact -> Object/
  // Project, which is the documented AFFECTS signature.
  IMPACTS: "AFFECTS",
  FEATURE_OF: "PART_OF",
  MILESTONE_OF: "PART_OF",
  BELONGS_TO: "PART_OF",
  INFRASTRUCTURE_OF: "PART_OF",
  INCLUDES: "CONTAINS",
  HAS_MEMBER: "CONTAINS",
  HAS_FEATURE: "CONTAINS",
  CAUSED: "LED_TO",
  TRIGGERED: "LED_TO",
  DEPRECATES: "REPLACES",
};

/** Normalize a relationship type for a WRITE: validate, upper-case, apply
 *  aliases, and handle verbs outside the vocabulary per SCHEMA_ENFORCEMENT. */
export function normalizeRelation(raw: unknown): Normalized<RelationshipType> {
  const input = assertSafeIdentifier("relation", raw);
  const upper = input.toUpperCase();

  if (RELATIONS.has(upper)) {
    return upper === input
      ? { value: upper as RelationshipType }
      : { value: upper as RelationshipType, coercedFrom: input };
  }
  const alias = RELATION_ALIASES[upper];
  if (alias) return { value: alias, coercedFrom: input };

  const mode = getSchemaEnforcement();
  if (mode === "strict") {
    throw new InvalidIdentifierError(`relation "${input}" is not in the documented vocabulary`);
  }
  if (mode === "lenient") return { value: upper as RelationshipType, unknown: true };
  return { value: FALLBACK_RELATION, coercedFrom: upper, unknown: true };
}

/** Normalize a relationship type used to FIND existing edges (boost, weaken,
 *  unmerge). Validated and upper-cased, but never aliased or coerced: the edge
 *  being looked up may legitimately carry a legacy verb. */
export function existingRelation(raw: unknown): RelationshipType {
  return assertSafeIdentifier("relation", raw).toUpperCase() as RelationshipType;
}

// Relations where one source holds many targets at once. Passing `valid_at`
// on these never invalidates sibling edges: recording the date a child was
// born must not mark every other child as superseded.
const NEVER_SUPERSEDE = new Set<string>([
  "FAMILY_OF", "KNOWS", "COLLABORATES_WITH", "MENTOR_OF",
  "ALIAS_OF", "CONTRADICTS", "RELATED_TO",
]);

export const isSupersedable = (relation: string): boolean => !NEVER_SUPERSEDE.has(relation);

// ─── Property sanitation ────────────────────────────────────────────────────
//
// Caller properties are applied with `SET n += $props`, after the fields the
// client manages. Without this, a caller could overwrite `tenant_id` and move
// a node into another tenant, rewrite `id`, or put prose into `confidence`,
// which is what silently disabled decay for weeks in July.

const RESERVED_NODE_KEYS = new Set([
  "id", "tenant_id", "name", "embedding", "aliases",
  "first_seen", "last_seen", "last_decayed", "times_mentioned",
]);
const RESERVED_EDGE_KEYS = new Set([
  "tenant_id", "weight", "last_confirmed", "ingested_at",
  "valid_at", "invalid_at", "last_decayed", "proposed_relations",
]);

export interface SanitizedProperties {
  clean: Record<string, unknown>;
  /** Keys removed or rewritten, for reporting back to the caller. */
  dropped: string[];
}

const isPrimitive = (v: unknown): boolean =>
  v === null || ["string", "number", "boolean"].includes(typeof v);

/** Neo4j stores primitives and homogeneous arrays of primitives only; a nested
 *  object makes the whole statement throw, which inside a batch transaction
 *  would roll back every other write. Serialize those instead. */
function storable(v: unknown): unknown {
  if (isPrimitive(v)) return v;
  if (Array.isArray(v) && v.every((x) => typeof x === typeof v[0] && isPrimitive(x))) return v;
  return JSON.stringify(v);
}

export function sanitizeProperties(
  props: Record<string, unknown> | undefined,
  kind: "node" | "edge",
): SanitizedProperties {
  const reserved = kind === "node" ? RESERVED_NODE_KEYS : RESERVED_EDGE_KEYS;
  const clean: Record<string, unknown> = {};
  const dropped: string[] = [];

  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined) continue;
    if (reserved.has(key)) {
      dropped.push(key);
      continue;
    }
    if (kind === "node" && key === "confidence") {
      const n = typeof value === "number" ? value : Number.NaN;
      if (Number.isFinite(n) && n >= 0 && n <= 1) {
        clean.confidence = n;
      } else {
        // Keep the words, drop them out of the numeric field.
        dropped.push(key);
        if (typeof value === "string" && value.trim()) clean.confidence_note = value;
      }
      continue;
    }
    clean[key] = storable(value);
  }
  return { clean, dropped };
}

/** Clamp a weight or confidence into [0, 1]; non-numbers become `fallback`. */
export function clampUnit(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/** Validate a bi-temporal timestamp before it reaches `datetime()`, where an
 *  unparseable string would throw mid-transaction. */
export function checkValidAt(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new InvalidIdentifierError(`valid_at ${JSON.stringify(value)} is not an ISO-8601 date`);
  }
  return value;
}
