import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JevBudget, JevClient } from "../shared/jev.js";
import { runDuplicateCheck, type CallTool } from "./duplicates.js";

const root = mkdtempSync(join(tmpdir(), "jev-dup-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const settings = { minScore: 0.6, limit: 30, linkFloor: 0.3, containsCeiling: 0.4, maxRelationships: 15 };

const pair = (a: string, b: string, score = 0.7) => ({
  entity_a: { id: a.toLowerCase().replace(/ /g, "-"), name: a, type: "Project", edge_count: 3 },
  entity_b: { id: b.toLowerCase().replace(/ /g, "-"), name: b, type: "Project", edge_count: 2 },
  score,
  signals: { shared_neighbors: [{ id: "acme", relation: "PART_OF", degree: 40, weight: 0.5 }] },
});

function fakeGraph(suggestions: unknown[]) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const callTool: CallTool = async (name, args) => {
    calls.push({ name, args });
    if (name === "graph_merge_suggestions") return { suggestions };
    if (name === "graph_query") {
      const n = String((args.entities as string[])[0]);
      const id = n.toLowerCase().replace(/ /g, "-");
      return {
        nodes: [
          { id, name: n, properties: { description: `${n} is a widget service`, aliases: [] } },
          { id: "acme", name: "Acme" },
        ],
        edges: [{ from: id, to: "acme", type: "PART_OF" }],
      };
    }
    throw new Error(`unexpected tool ${name}`);
  };
  return { callTool, calls };
}

/** Jev answers keyed by entity_a's name: [link_state, one_contains_other]. */
function fakeJev(byName: Record<string, [number, number]>, maxTokens = 1_000_000, tokensPerCall = 900) {
  const states: Array<{ entity_a: { name: string; relationships: string[] } }> = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const { state } = JSON.parse(String(init.body));
    states.push(state);
    const [link, contains] = byName[state.entity_a.name] ?? [0, 0];
    return new Response(JSON.stringify({
      model: "jev-x",
      answers: {
        link_state: { type: "score", score: link, confidence: 0.8, probabilities: {} },
        name_variant: { type: "noul", noul: 0.5 },
        one_contains_other: { type: "noul", noul: contains },
        only_shares_context: { type: "noul", noul: 0.1 },
      },
      usage: { input_tokens: tokensPerCall, output_tokens: 4 },
    }));
  }) as unknown as typeof fetch;
  return { jev: new JevClient({ apiKey: "k", budget: new JevBudget(maxTokens), fetch: fetchFn }), states };
}

describe("runDuplicateCheck", () => {
  it("judges each candidate and logs a verdict, merging nothing", async () => {
    const { callTool, calls } = fakeGraph([
      pair("Falcon API", "Falcon Service"),
      pair("Falcon API v2", "Falcon API"),
      pair("Heron Docs", "Falcon Docs"),
    ]);
    const { jev, states } = fakeJev({
      "Falcon API": [1.6, 0.1],      // same thing
      "Falcon API v2": [1.2, 0.85],  // a version of the other
      "Heron Docs": [0.1, 0.1],      // different things
    });
    const report = join(root, "a", "jev-duplicates.jsonl");
    const s = await runDuplicateCheck(callTool, jev, settings, report);

    expect(s).toMatchObject({ candidates: 3, judged: 3, likely: 1, withheld: 0, failed: 0, stoppedByBudget: false, inputTokens: 2700 });
    const lines = readFileSync(report, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.verdict)).toEqual(["likely_duplicate", "distinct", "distinct"]);
    expect(calls[0]).toEqual({ name: "graph_merge_suggestions", args: { min_score: 0.6, limit: 30, log_to_audit: false } });
    expect(calls.every((c) => c.name === "graph_merge_suggestions" || c.name === "graph_query")).toBe(true);
    expect(states[0].entity_a.relationships).toEqual(["PART_OF -> Acme"]);
  });

  it("never sends a pair carrying personal identifiers", async () => {
    const { callTool } = fakeGraph([pair("someone@example.com", "Someone")]);
    const { jev, states } = fakeJev({});
    const report = join(root, "b", "jev-duplicates.jsonl");
    const s = await runDuplicateCheck(callTool, jev, settings, report);
    expect(s).toMatchObject({ withheld: 1, judged: 0 });
    expect(states).toHaveLength(0);
    expect(existsSync(report)).toBe(false);
  });

  it("stops at the cost cap", async () => {
    const { callTool } = fakeGraph([pair("Falcon API", "Falcon Service"), pair("Heron Docs", "Falcon Docs")]);
    // The first call leaves less headroom than any request needs.
    const { jev } = fakeJev({ "Falcon API": [1.6, 0.1] }, 1_000_000, 999_900);
    const s = await runDuplicateCheck(callTool, jev, settings, join(root, "c", "jev-duplicates.jsonl"));
    expect(s).toMatchObject({ judged: 1, stoppedByBudget: true });
  });
});
