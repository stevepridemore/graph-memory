import { pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { GRAPH_MEMORY_HOME } from "./config.js";
import { join } from "node:path";

// ─── Config ───────────────────────────────────────────────────────────────────
// Model: BAAI's bge-small-en-v1.5 — 33M params, 384-dim, strong on retrieval benchmarks.
// Cached under GRAPH_MEMORY_HOME so it persists across container rebuilds when the
// data volume is mounted, and so users can audit what was downloaded.

export const EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";
export const EMBEDDING_DIM = 384;

// Persist the model under the mounted data volume so it doesn't redownload on every
// container rebuild.
env.cacheDir = join(GRAPH_MEMORY_HOME, ".transformers-cache");
env.allowLocalModels = true;

let embedder: FeatureExtractionPipeline | null = null;
let loadingPromise: Promise<FeatureExtractionPipeline> | null = null;

/** Lazy-load the embedding pipeline. The first call may take 5–30s (model download
 *  + load); subsequent calls are instant. */
export async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (embedder) return embedder;
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    const e = (await pipeline("feature-extraction", EMBEDDING_MODEL, {
      // Use quantized model variants by default — much smaller, marginal accuracy hit.
      dtype: "fp32",
    })) as FeatureExtractionPipeline;
    embedder = e;
    return e;
  })();
  return loadingPromise;
}

/** Embed a single string → 384-dim Float32Array. Mean-pooled and L2-normalized
 *  (so cosine similarity == dot product). */
export async function embedText(text: string): Promise<number[]> {
  const cleaned = text.trim();
  if (!cleaned) return new Array<number>(EMBEDDING_DIM).fill(0);
  const e = await getEmbedder();
  const result = await e(cleaned, { pooling: "mean", normalize: true });
  // result.data is a Float32Array of length 384
  return Array.from(result.data as Float32Array);
}

/** Batch-embed an array of strings. Sequential under the hood — the underlying
 *  pipeline is single-threaded — but exposes a clean API. */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (const t of texts) {
    out.push(await embedText(t));
  }
  return out;
}

/** Build the text fed into the embedder for a graph entity. Includes name plus
 *  a few high-signal optional fields so semantically similar concepts cluster
 *  even when their bare names are short or generic. Em-dash separator gives the
 *  tokenizer a natural break.
 *
 *  Example: "Claude Code" + Object + "Anthropic CLI for coding" ->
 *    "Claude Code — Object — Anthropic CLI for coding"
 */
export function buildEmbedText(
  name: string,
  type: string | undefined,
  properties: Record<string, unknown> = {},
): string {
  const parts: string[] = [name.trim()];
  if (type) parts.push(type);
  // High-signal fields, in priority order. First non-empty wins.
  for (const key of ["subtype", "description", "role", "category", "what", "specialty"]) {
    const v = properties[key];
    if (typeof v === "string" && v.trim()) {
      parts.push(v.trim());
    }
  }
  return parts.join(" — ");
}

/** Test whether the embedder is healthy. Used at startup as a sanity check. */
export async function checkEmbedder(): Promise<{ ok: boolean; dim: number; latency_ms: number; error?: string }> {
  const start = Date.now();
  try {
    const vec = await embedText("hello world");
    return { ok: vec.length === EMBEDDING_DIM, dim: vec.length, latency_ms: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      dim: 0,
      latency_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
