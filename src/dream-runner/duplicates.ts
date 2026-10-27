// Log-only duplicate check, run after a completed nightly dream when
// JEV_DUPLICATE_CHECK=on (or on its own with --job duplicates).
//
// graph_merge_suggestions supplies candidate pairs from embeddings, shared
// neighbours and name overlap. Jev then judges each pair on what the two
// records refer to. Nothing is merged: every judged pair is appended to
// logs/jev-duplicates.jsonl for a person to review.
//
// The policy is two thresholds on independent judgments: a pair is a likely
// duplicate when `link_state` (0 = different things, 2 = the same thing)
// clears a floor AND `one_contains_other` (one is a part or version of the
// other) stays under a ceiling. Both are settings; measure them on your own
// labelled pairs before trusting the defaults.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  JevBudgetError,
  jevClientFromEnv,
  jevCostUsd,
  piiReason,
  positiveEnv,
  type JevClient,
  type JevQuestion,
} from "../shared/jev.js";

export type CallTool = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export interface DuplicateCheckSettings {
  minScore: number;
  limit: number;
  linkFloor: number;
  containsCeiling: number;
  /** Relationships per entity included in the state. */
  maxRelationships: number;
}

export function loadDuplicateSettings(env: NodeJS.ProcessEnv = process.env): DuplicateCheckSettings {
  return {
    minScore: positiveEnv(env, "JEV_DUPLICATE_MIN_SCORE", 0.6),
    limit: Math.min(100, Math.floor(positiveEnv(env, "JEV_DUPLICATE_LIMIT", 30))),
    linkFloor: positiveEnv(env, "JEV_DUPLICATE_LINK_FLOOR", 0.3),
    containsCeiling: positiveEnv(env, "JEV_DUPLICATE_CONTAINS_CEILING", 0.4),
    maxRelationships: Math.floor(positiveEnv(env, "JEV_DUPLICATE_MAX_RELATIONSHIPS", 15)),
  };
}

// ─── Questions ───

// Ordered levels, low to high; the score's position on this scale is the
// routing axis.
const LINK_LEVELS = [
  "The two records describe two different things. They may share an owner, a project, a " +
    "topic, or a category, or one may be a part or version of the other, but they are not " +
    "the same thing.",
  "The two records describe closely related things that may or may not be the same one: a " +
    "variant, a rename, a narrower and a broader form of the same subject, or a name that " +
    "could plausibly refer to either.",
  "The two records describe one and the same thing, recorded twice under different names " +
    "or wordings.",
];

export function buildDuplicateQuestions(): Record<string, JevQuestion> {
  return {
    link_state: {
      type: "score",
      instructions:
        "Two records from a personal knowledge graph are given as `entity_a` and `entity_b`. " +
        "How do they relate as entities? Judge what each record refers to, using its " +
        "description, aliases and relationships. Do not judge by how similar the names look: " +
        "one name containing the other is not evidence that they are the same thing, and " +
        "sharing a neighbour such as an owner or a parent project is not evidence either.",
      criteria: LINK_LEVELS,
    },
    name_variant: {
      type: "noul",
      instructions:
        "Are `entity_a.name` and `entity_b.name` two ways of writing the same name, such as an " +
        "abbreviation, an alias, a nickname, a spelling variant, a truncation, or an expanded form?",
      criteria: {
        true: "The two names denote the same referent under different wording.",
        false:
          "The names denote different referents, even if one name contains the other or they " +
          "follow the same naming pattern.",
      },
    },
    one_contains_other: {
      type: "noul",
      instructions:
        "Is one of the two records a component, version, environment, sub-topic, instance, or " +
        "subset of the other, rather than the same thing at the same level?",
      criteria: {
        true:
          "One is properly contained by the other, such as a specific version inside a " +
          "product, a development database beside its production counterpart, or one decision " +
          "inside a broader architecture.",
        false: "Neither contains the other, whether or not they are the same thing.",
      },
    },
    only_shares_context: {
      type: "noul",
      instructions:
        "Do these two records have nothing in common beyond a shared owner, project, " +
        "category, or topic?",
      criteria: {
        true:
          "Their only connection is context: the same person holds both preferences, the same " +
          "project contains both events, or they belong to the same category.",
        false:
          "They share substantive content about the same subject matter, beyond merely " +
          "hanging off the same neighbour.",
      },
    },
  };
}

// ─── Graph reads ───

interface Suggestion {
  entity_a: { id: string; name: string; type: string; edge_count: number };
  entity_b: { id: string; name: string; type: string; edge_count: number };
  score: number;
  signals: { shared_neighbors?: Array<{ id: string; relation: string; degree: number }> };
}

interface EntityDetail {
  description: string | null;
  aliases: string[];
  relationships: string[];
}

/** Description, aliases and a few relationships for one entity, read with
 *  graph_query. ALIAS_OF edges and aliases matter most: without them two
 *  names for one person look like strangers. Best-effort: empty on failure. */
async function entityDetail(callTool: CallTool, id: string, name: string, max: number): Promise<EntityDetail> {
  const empty: EntityDetail = { description: null, aliases: [], relationships: [] };
  let res: { nodes?: Array<{ id: string; name: string; properties?: Record<string, unknown> }>; edges?: Array<{ from: string; to: string; type: string }> };
  try {
    res = (await callTool("graph_query", { entities: [name], max_hops: 1, limit: 25, context_level: "full" })) as typeof res;
  } catch {
    return empty;
  }
  const node = res.nodes?.find((n) => n.id === id);
  if (!node) return empty;
  const names = new Map((res.nodes ?? []).map((n) => [n.id, n.name]));
  const edges = (res.edges ?? []).filter((e) => e.from === id || e.to === id);
  // Aliases first, so a truncated list never drops them.
  edges.sort((a, b) => Number(b.type === "ALIAS_OF") - Number(a.type === "ALIAS_OF"));
  const description = node.properties?.description;
  const aliases = node.properties?.aliases;
  return {
    description: typeof description === "string" ? description : null,
    aliases: Array.isArray(aliases) ? aliases.map(String) : [],
    relationships: edges.slice(0, max).map((e) =>
      e.from === id ? `${e.type} -> ${names.get(e.to) ?? e.to}` : `<- ${e.type} ${names.get(e.from) ?? e.from}`,
    ),
  };
}

// ─── The check ───

export interface DuplicateFinding {
  checked_at: string;
  entity_a: { id: string; name: string; type: string };
  entity_b: { id: string; name: string; type: string };
  heuristic_score: number;
  link_state: number;
  one_contains_other: number;
  name_variant: number;
  only_shares_context: number;
  verdict: "likely_duplicate" | "distinct";
}

export interface DuplicateCheckSummary {
  candidates: number;
  judged: number;
  likely: number;
  withheld: number;
  failed: number;
  stoppedByBudget: boolean;
  inputTokens: number;
  costUsd: number;
}

export async function runDuplicateCheck(
  callTool: CallTool,
  jev: JevClient,
  settings: DuplicateCheckSettings,
  reportPath: string,
  now: () => Date = () => new Date(),
): Promise<DuplicateCheckSummary> {
  const res = (await callTool("graph_merge_suggestions", {
    min_score: settings.minScore,
    limit: settings.limit,
    log_to_audit: false,
  })) as { suggestions?: Suggestion[] };
  const suggestions = res.suggestions ?? [];
  const summary: DuplicateCheckSummary = {
    candidates: suggestions.length, judged: 0, likely: 0, withheld: 0, failed: 0,
    stoppedByBudget: false, inputTokens: 0, costUsd: 0,
  };
  const questions = buildDuplicateQuestions();
  const startTokens = jev.budget.spentTokens;
  mkdirSync(dirname(reportPath), { recursive: true });

  for (const s of suggestions) {
    const [a, b] = await Promise.all([
      entityDetail(callTool, s.entity_a.id, s.entity_a.name, settings.maxRelationships),
      entityDetail(callTool, s.entity_b.id, s.entity_b.name, settings.maxRelationships),
    ]);
    // Personal identifiers stay on this machine.
    if (piiReason(s.entity_a.name, s.entity_b.name, a.description, b.description, ...a.aliases, ...b.aliases)) {
      summary.withheld++;
      continue;
    }
    const describe = (e: Suggestion["entity_a"], d: EntityDetail) => ({
      name: e.name,
      type: e.type,
      description: d.description,
      aliases: d.aliases,
      relationships: d.relationships,
      edges_in_graph: e.edge_count,
    });
    const state = {
      entity_a: describe(s.entity_a, a),
      entity_b: describe(s.entity_b, b),
      shared_neighbours: (s.signals.shared_neighbors ?? []).map((n) => ({
        neighbour: n.id, relation: n.relation, neighbour_total_edges: n.degree,
      })),
    };

    let answers;
    try {
      answers = (await jev.ask(state, questions)).answers;
    } catch (err) {
      if (err instanceof JevBudgetError) {
        summary.stoppedByBudget = true;
        break;
      }
      summary.failed++;
      continue;
    }
    const num = (k: string): number | null => {
      const v = answers[k];
      if (v?.type === "score") return v.score;
      if (v?.type === "noul") return v.noul;
      return null;
    };
    const link = num("link_state");
    const contains = num("one_contains_other");
    if (link === null || contains === null) {
      summary.failed++;
      continue;
    }
    const likely = link >= settings.linkFloor && contains <= settings.containsCeiling;
    const finding: DuplicateFinding = {
      checked_at: now().toISOString(),
      entity_a: { id: s.entity_a.id, name: s.entity_a.name, type: s.entity_a.type },
      entity_b: { id: s.entity_b.id, name: s.entity_b.name, type: s.entity_b.type },
      heuristic_score: s.score,
      link_state: Number(link.toFixed(3)),
      one_contains_other: Number(contains.toFixed(3)),
      name_variant: Number((num("name_variant") ?? 0).toFixed(3)),
      only_shares_context: Number((num("only_shares_context") ?? 0).toFixed(3)),
      verdict: likely ? "likely_duplicate" : "distinct",
    };
    appendFileSync(reportPath, JSON.stringify(finding) + "\n");
    summary.judged++;
    if (likely) summary.likely++;
  }

  summary.inputTokens = jev.budget.spentTokens - startTokens;
  summary.costUsd = jevCostUsd(summary.inputTokens);
  return summary;
}

/** Run the check with settings from the environment and log the outcome.
 *  Never throws: a failure here must not change the dream run's result. */
export async function duplicateCheckFromEnv(
  callTool: CallTool,
  graphHome: string,
  log: (line: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DuplicateCheckSummary | null> {
  try {
    const jev = jevClientFromEnv(env, { name: "JEV_DUPLICATE_MAX_COST_USD", defaultUsd: 0.02, perDay: false });
    const reportPath = join(graphHome, "logs", "jev-duplicates.jsonl");
    const s = await runDuplicateCheck(callTool, jev, loadDuplicateSettings(env), reportPath);
    log(
      `jev duplicate check: ${s.candidates} candidates, ${s.judged} judged, ${s.likely} likely duplicates, ` +
        `${s.withheld} withheld (personal data), ${s.failed} failed` +
        (s.stoppedByBudget ? ", stopped at the cost cap" : "") +
        `, ~$${s.costUsd.toFixed(4)}. Report: logs/jev-duplicates.jsonl (nothing merged)`,
    );
    return s;
  } catch (err) {
    log(`jev duplicate check failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
