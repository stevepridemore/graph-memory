// Verb selection for edges that would be stored as RELATED_TO.
//
// When a write asks for RELATED_TO, or for a verb outside the vocabulary that
// normalizeRelation() would coerce to RELATED_TO, Jev is asked which
// documented verb the edge actually is. One Choice over the vocabulary plus an
// explicit "keep RELATED_TO" outcome, and one Noul on whether the evidence
// names a specific relationship at all.
//
// Opt-in (JEV_VERB_SELECT=on). Every failure path keeps RELATED_TO: feature
// off, budget spent, timeout, HTTP error, malformed answer, a verb outside
// RELATIONSHIP_TYPES, low confidence, or a source type the verb isn't defined
// for. A write is never blocked or delayed past the timeout by this.

import { RELATIONSHIP_TYPES, type RelationshipType } from "./types.js";
import { normalizeRelation } from "./vocabulary.js";
import {
  JevBudgetError,
  isOn,
  jevClientFromEnv,
  piiReason,
  positiveEnv,
  type JevClient,
  type JevQuestion,
} from "./jev.js";

export const KEEP = "KEEP_RELATED_TO";

// Identity-level verbs are never chosen automatically: they assert that two
// records are the same thing or cannot both be true, which is a merge-class
// decision, not a relabel. RELATED_TO is what KEEP means.
const NEVER_SELECTED = new Set<string>(["RELATED_TO", "ALIAS_OF", "CONTRADICTS", "SUPERSEDES"]);

// One line per verb, read in the a -> b direction. Taken from the "Use when"
// column of GRAPH_SCHEMA.md; keep them in step.
export const VERB_DESCRIPTIONS: Partial<Record<RelationshipType, string>> = {
  WORKS_ON: "A is a person who actively contributes to B, a project.",
  WORKS_AT: "A is a person employed by B, an organization.",
  REPORTS_TO: "A reports to B on an org chart.",
  STAKEHOLDER_IN: "A has an interest in B but does not own it.",
  KNOWS: "A and B are people who are acquainted. Symmetric.",
  COLLABORATES_WITH: "A and B are people in an active working relationship. Symmetric.",
  FAMILY_OF: "A and B are people with a family tie, including partners. Symmetric.",
  MENTOR_OF: "A mentors or teaches B.",
  KNOWS_ABOUT: "A is a person familiar with B as a subject.",
  PREFERS: "A is a person holding B as a stated preference.",
  DECIDED_FOR: "A is a person or project that owns or made decision B.",
  LED_TO: "A, an event or decision, causally produced B.",
  INVOLVED_IN: "A is a person involved in B, an event or project. Lighter than PARTICIPATED_IN.",
  USES: "A uses B, a tool or object, in a general sense.",
  USES_TECH: "A is a project that depends on B, a specific technology.",
  DEPENDS_ON: "A has a functional dependency on B.",
  IMPLEMENTS: "A is a concrete realization of pattern or interface B.",
  EXTENDS: "A is a class inheriting from class B.",
  INSPIRED_BY: "A was influenced by B without inheriting from it.",
  BUILDS_ON: "A directly extends B at the level of ideas.",
  DERIVED_FROM: "A descends from B, such as a fork or an extracted concept.",
  HOSTED_ON: "A runs on or inside B, such as an app on a server or a container on a host.",
  CONTAINS: "A contains B as a component, such as a repo containing a file.",
  PART_OF: "A is a component of B. Inverse of CONTAINS.",
  INSTANCE_OF: "A is a concrete instance of abstract category B.",
  CATEGORIZED_AS: "A is loosely classified under B. Weaker than INSTANCE_OF.",
  ABOUT: "A, a fact or artifact, is about subject B.",
  DESCRIBES: "A is an artifact that describes B, with clearer authoring intent than ABOUT.",
  DOCUMENTS: "A is reference documentation for B.",
  ATTRIBUTED_TO: "A is a statement or observation whose source is person B.",
  PRODUCED: "A is a person or project that produced output B.",
  PRODUCED_BY: "A is an artifact or object that came from B. Inverse of PRODUCED.",
  AUTHORED: "A is a person who wrote artifact B.",
  CREATED: "A is a person who brought B into existence. Broader than AUTHORED.",
  AFFECTS: "A is a decision, fact or event that applies to or constrains B.",
  GOVERNS: "A is a decision or policy that B is bound by. Stronger than AFFECTS.",
  REPLACES: "A succeeds B informally, without a bi-temporal contract.",
  DEPRECATED_BY: "A is on its way out, replaced by B.",
  BLOCKS: "A, a task or issue, blocks B.",
  BLOCKED_BY: "A, a task or issue, is blocked by B.",
  RESOLVED_BY: "A, an open question or contradiction, is closed by B.",
  LOCATED_IN: "A is geographically located in B.",
  DEPLOYED_TO: "A is a project deployed to runtime target B.",
  PARTICIPATED_IN: "A is a person who was a member of or took part in B.",
  OCCURRED_DURING: "A, an event, happened within the span of B.",
  TRIGGERED_BY: "A was caused by B.",
};

export const SELECTABLE_VERBS: RelationshipType[] = RELATIONSHIP_TYPES.filter(
  (v) => !NEVER_SELECTED.has(v) && VERB_DESCRIPTIONS[v] !== undefined,
);

// Source-node types each verb is defined for in GRAPH_SCHEMA.md. A verb not
// listed accepts any source. An array is an allow-list; `deny` is used where
// the schema's stated source type proved too narrow against real data and
// only a short list of sources is actually wrong.
const SOURCE_TYPES: Partial<Record<RelationshipType, string[] | { deny: string[] }>> = {
  ABOUT: { deny: ["Person"] },
  AFFECTS: { deny: ["Person", "Organization"] },
  WORKS_ON: ["Person"], WORKS_AT: ["Person"], REPORTS_TO: ["Person"],
  STAKEHOLDER_IN: ["Person"], KNOWS: ["Person"], COLLABORATES_WITH: ["Person"],
  FAMILY_OF: ["Person"], MENTOR_OF: ["Person"], KNOWS_ABOUT: ["Person"],
  PREFERS: ["Person"], DECIDED_FOR: ["Person", "Project"],
  INVOLVED_IN: ["Person"], PARTICIPATED_IN: ["Person"],
  AUTHORED: ["Person"], CREATED: ["Person"], PRODUCED: ["Person", "Project"],
  PRODUCED_BY: ["Artifact", "Object"],
  LED_TO: ["Event", "Decision"], TRIGGERED_BY: ["Event", "Decision"],
  OCCURRED_DURING: ["Event"],
  USES_TECH: ["Project"], DEPLOYED_TO: ["Project", "Object"],
  DESCRIBES: ["Fact", "Artifact", "Object"],
  DOCUMENTS: ["Artifact", "Object"], ATTRIBUTED_TO: ["Fact"],
  GOVERNS: ["Decision", "Preference", "Concept"],
  INSTANCE_OF: ["Object"], LOCATED_IN: ["Person", "Object"],
};

/** Why `verb` can't start from a `sourceType` node, or null when it can. */
export function typeViolation(verb: string, sourceType: string | undefined): string | null {
  const rule = SOURCE_TYPES[verb as RelationshipType];
  if (!rule || !sourceType) return null;
  if (Array.isArray(rule)) {
    return rule.includes(sourceType) ? null : `${verb} expects a source of ${rule.join("/")}, got ${sourceType}`;
  }
  return rule.deny.includes(sourceType) ? `${verb} is not valid from a ${sourceType} source` : null;
}

export function buildVerbQuestions(): Record<string, JevQuestion> {
  const criteria: Record<string, string> = {};
  for (const v of SELECTABLE_VERBS) criteria[v] = VERB_DESCRIPTIONS[v]!;
  criteria[KEEP] =
    "No verb above fits. The two records are connected somehow, but the evidence does not " +
    "support any specific relationship. Choose this rather than picking an approximate verb.";
  return {
    verb: {
      type: "choice",
      instructions:
        "Two records from a personal knowledge graph are about to be connected by a generic " +
        "`RELATED_TO` edge pointing from `entity_a` to `entity_b`. `evidence`, when present, is " +
        "the note recorded with the edge, and `requested_verb` is the verb the writer asked for. " +
        "Which relationship verb describes this edge, reading it as \"entity_a VERB entity_b\"? " +
        "The sentence must be true in that order. If the relationship naturally runs the other " +
        "way, pick the verb whose inverse reading is correct: PART_OF rather than CONTAINS when " +
        "entity_a is the component, BLOCKED_BY rather than BLOCKS when entity_a is the one held " +
        "up, DEPRECATED_BY rather than REPLACES when entity_a is the one being retired. Judge " +
        `only what the evidence and the two records support. If nothing specific is supported, ` +
        `choose ${KEEP} rather than guessing.`,
      criteria,
    },
    evidence_supports: {
      type: "noul",
      instructions:
        "Does the state contain enough to identify a specific relationship, rather than only " +
        "showing that the two records co-occurred?",
      criteria: {
        true: "The evidence, the requested verb or the names state how the two are connected.",
        false:
          "The records only share a context, or the evidence merely restates that they are " +
          "related without saying how.",
      },
    },
  };
}

// ─── Selection ───

export interface EdgeEnds {
  from: { name: string; type?: string };
  to: { name: string; type?: string };
  evidence?: string;
  /** What the writer asked for, when it was not RELATED_TO itself. */
  requested?: string;
}

export interface VerbSelection {
  verb: RelationshipType;
  confidence: number;
}

/** Why a selection kept RELATED_TO. For the write's report, never for the edge. */
export type KeepReason =
  | "kept" | "low_confidence" | "no_evidence" | "type_mismatch"
  | "not_in_vocabulary" | "pii" | "budget" | "error";

export interface VerbSelectorSettings {
  minConfidence: number;
  minEvidence: number;
}

export class VerbSelector {
  private readonly questions = buildVerbQuestions();

  constructor(
    private readonly jev: JevClient,
    private readonly settings: VerbSelectorSettings = { minConfidence: 0.55, minEvidence: 0.5 },
    private readonly onError: (message: string) => void = () => {},
  ) {}

  /** A documented verb for this edge, or the reason it stays RELATED_TO. */
  async select(edge: EdgeEnds): Promise<VerbSelection | { keep: KeepReason }> {
    if (piiReason(edge.from.name, edge.to.name, edge.evidence)) return { keep: "pii" };

    const state = {
      entity_a: { name: edge.from.name, type: edge.from.type ?? null },
      entity_b: { name: edge.to.name, type: edge.to.type ?? null },
      evidence: edge.evidence || null,
      requested_verb: edge.requested || null,
    };

    let answers;
    try {
      answers = (await this.jev.ask(state, this.questions)).answers;
    } catch (err) {
      if (err instanceof JevBudgetError) return { keep: "budget" };
      this.onError(err instanceof Error ? err.message : String(err));
      return { keep: "error" };
    }

    const verb = answers.verb;
    const support = answers.evidence_supports;
    if (verb?.type !== "choice" || support?.type !== "noul") return { keep: "error" };
    if (verb.choice === KEEP) return { keep: "kept" };
    // Enforced against the write path's vocabulary, not the model's word.
    if (!(SELECTABLE_VERBS as string[]).includes(verb.choice)) return { keep: "not_in_vocabulary" };
    if (verb.confidence < this.settings.minConfidence) return { keep: "low_confidence" };
    if (support.noul < this.settings.minEvidence) return { keep: "no_evidence" };
    if (typeViolation(verb.choice, edge.from.type)) return { keep: "type_mismatch" };
    return { verb: verb.choice as RelationshipType, confidence: verb.confidence };
  }
}

/** The selector configured by the environment, or null when JEV_VERB_SELECT
 *  is off. A missing or unreadable key turns the feature off with a warning
 *  instead of failing the server. */
export function verbSelectorFromEnv(env: NodeJS.ProcessEnv = process.env): VerbSelector | null {
  if (!isOn(env.JEV_VERB_SELECT)) return null;
  const warn = (msg: string) => process.stderr.write(`[graph-memory] jev verb selection: ${msg}\n`);
  try {
    const jev = jevClientFromEnv(env, { name: "JEV_VERB_MAX_COST_USD_PER_DAY", defaultUsd: 0.05, perDay: true });
    return new VerbSelector(
      jev,
      {
        minConfidence: positiveEnv(env, "JEV_VERB_MIN_CONFIDENCE", 0.55),
        minEvidence: positiveEnv(env, "JEV_VERB_MIN_EVIDENCE", 0.5),
      },
      warn,
    );
  } catch (err) {
    warn(`disabled: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ─── Applying it to a write ───

export interface RelationInput {
  from: string;
  to: string;
  relation: string;
  evidence?: string;
  properties?: Record<string, unknown>;
}

export interface SelectionReport {
  from: string;
  to: string;
  /** What was asked for. */
  requested: string;
  /** What is being written. */
  relation: string;
  confidence?: number;
  kept?: KeepReason;
}

/**
 * Run verb selection over the relations that would land as RELATED_TO and
 * return them with the chosen verb swapped in. A swapped edge records
 * `verb_selected_by`, `verb_selection_confidence` and, when the writer asked
 * for an unknown verb, `verb_requested`. Relations that fail validation are
 * passed through untouched for the write path to reject and report.
 */
export async function applyVerbSelection<R extends RelationInput>(
  selector: VerbSelector,
  relations: R[],
  describe: (ref: string) => { name: string; type?: string },
  concurrency = 4,
): Promise<{ relations: R[]; selections: SelectionReport[] }> {
  const out = [...relations];
  const selections: SelectionReport[] = [];
  const todo: number[] = [];
  for (const [i, r] of relations.entries()) {
    try {
      if (normalizeRelation(r.relation).value === "RELATED_TO") todo.push(i);
    } catch { /* invalid: the write path reports it */ }
  }

  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const i = todo[next++];
      const r = relations[i];
      const n = normalizeRelation(r.relation);
      const requested = n.unknown ? n.coercedFrom : undefined;
      const result = await selector.select({
        from: describe(r.from),
        to: describe(r.to),
        evidence: r.evidence,
        requested,
      });
      if ("verb" in result) {
        out[i] = {
          ...r,
          relation: result.verb,
          properties: {
            ...r.properties,
            verb_selected_by: "jev",
            verb_selection_confidence: Number(result.confidence.toFixed(3)),
            ...(requested ? { verb_requested: requested } : {}),
          },
        };
        selections.push({ from: r.from, to: r.to, requested: r.relation, relation: result.verb, confidence: result.confidence });
      } else {
        selections.push({ from: r.from, to: r.to, requested: r.relation, relation: "RELATED_TO", kept: result.keep });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  return { relations: out, selections };
}
