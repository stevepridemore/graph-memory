import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const GRAPH_MEMORY_HOME = process.env.GRAPH_MEMORY_HOME ?? join(homedir(), "graph-memory");

export interface GraphMemoryConfig {
  neo4j: {
    uri: string;
    user: string;
    password: string;
    database: string;
  };
  weights: {
    explicit_statement: number;
    inferred: number;
    from_memory_file: number;
    boost_on_confirm: number;
    boost_on_mention: number;
    weaken_on_correct: number;
    project_context_boost: number;
  };
  decay: {
    rates: Record<string, number>;
    edge_rate: number;
    prune_node_threshold: number;
    prune_edge_threshold: number;
    prune_orphan_days: number;
  };
  query: {
    default_max_hops: number;
    default_min_weight: number;
    default_limit: number;
    cypher_timeout_ms: number;
  };
  affinity: {
    hop_1_multiplier: number;
    hop_2_multiplier: number;
  };
  dream: {
    cooldown_hours: number;
    max_transcripts_per_run: number;
    chunk_size_lines: number;
  };
}

const DEFAULTS: GraphMemoryConfig = {
  neo4j: {
    uri: process.env.NEO4J_URI ?? "",
    user: process.env.NEO4J_USER ?? "neo4j",
    password: process.env.NEO4J_PASSWORD ?? "",
    database: process.env.NEO4J_DATABASE ?? "neo4j",
  },
  weights: {
    explicit_statement: 0.7,
    inferred: 0.3,
    from_memory_file: 0.5,
    boost_on_confirm: 0.15,
    boost_on_mention: 0.05,
    weaken_on_correct: 0.3,
    project_context_boost: 0.1,
  },
  decay: {
    rates: {
      Person: 0.998,
      Project: 0.995,
      Preference: 0.999,
      Concept: 0.999,
      Decision: 0.997,
      Fact: 0.996,
      Event: 0.993,
      Object: 0.996,
    },
    edge_rate: 0.997,
    prune_node_threshold: 0.1,
    prune_edge_threshold: 0.05,
    prune_orphan_days: 30,
  },
  query: {
    default_max_hops: 2,
    default_min_weight: 0.3,
    default_limit: 20,
    cypher_timeout_ms: 5000,
  },
  affinity: {
    hop_1_multiplier: 1.3,
    hop_2_multiplier: 1.15,
  },
  dream: {
    cooldown_hours: 4,
    max_transcripts_per_run: 10,
    chunk_size_lines: 500,
  },
};

function deepMerge<T extends Record<string, unknown>>(target: T, source: Record<string, unknown>): T {
  const result = { ...target } as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = result[key];
    if (
      sourceVal !== null &&
      typeof sourceVal === "object" &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      typeof targetVal === "object" &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal;
    }
  }
  return result as T;
}

function clampWeights(config: GraphMemoryConfig): GraphMemoryConfig {
  for (const [key, val] of Object.entries(config.weights)) {
    if (typeof val === "number") {
      (config.weights as Record<string, number>)[key] = Math.max(0, Math.min(1, val));
    }
  }
  for (const [key, val] of Object.entries(config.decay.rates)) {
    config.decay.rates[key] = Math.max(0, Math.min(1, val));
  }
  return config;
}

export function loadConfig(): GraphMemoryConfig {
  const configPath = join(GRAPH_MEMORY_HOME, "config.json");
  try {
    const raw = readFileSync(configPath, "utf-8");
    const overrides = JSON.parse(raw) as Record<string, unknown>;
    const merged = deepMerge(DEFAULTS as unknown as Record<string, unknown>, overrides) as unknown as GraphMemoryConfig;
    return clampWeights(merged);
  } catch {
    return { ...DEFAULTS };
  }
}

let _config: GraphMemoryConfig | null = null;

export function getConfig(): GraphMemoryConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

export function resetConfig(): void {
  _config = null;
}
