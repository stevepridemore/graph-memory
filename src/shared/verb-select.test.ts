import { describe, it, expect } from "vitest";
import { RELATIONSHIP_TYPES } from "./types.js";
import { JevBudget, JevClient } from "./jev.js";
import {
  KEEP,
  SELECTABLE_VERBS,
  VerbSelector,
  applyVerbSelection,
  buildVerbQuestions,
  typeViolation,
} from "./verb-select.js";

/** A Jev client whose fetch answers with `verb` at `confidence`. */
function jevAnswering(verb: string, confidence = 0.9, support = 0.9, opts: { fail?: boolean; maxTokens?: number } = {}) {
  const calls: unknown[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    if (opts.fail) throw new Error("network down");
    return new Response(JSON.stringify({
      model: "jev-x",
      answers: {
        verb: { type: "choice", choice: verb, confidence, probabilities: { [verb]: confidence } },
        evidence_supports: { type: "noul", noul: support },
      },
      usage: { input_tokens: 2000, output_tokens: 2 },
    }));
  }) as unknown as typeof fetch;
  const jev = new JevClient({ apiKey: "k", budget: new JevBudget(opts.maxTokens ?? 1_000_000), fetch: fetchFn });
  return { jev, calls };
}

const edge = {
  from: { name: "Falcon API", type: "Project" },
  to: { name: "Test Cluster", type: "Object" },
  evidence: "Falcon API is deployed to the test cluster",
};

describe("vocabulary", () => {
  it("offers only documented verbs, never identity-level ones", () => {
    for (const v of SELECTABLE_VERBS) expect(RELATIONSHIP_TYPES).toContain(v);
    for (const v of ["RELATED_TO", "ALIAS_OF", "CONTRADICTS", "SUPERSEDES"]) {
      expect(SELECTABLE_VERBS).not.toContain(v);
    }
    const criteria = (buildVerbQuestions().verb as { criteria: Record<string, string> }).criteria;
    expect(Object.keys(criteria)).toEqual([...SELECTABLE_VERBS, KEEP]);
  });

  it("checks the source type a verb is defined for", () => {
    expect(typeViolation("WORKS_AT", "Project")).toMatch(/expects a source of Person/);
    expect(typeViolation("WORKS_AT", "Person")).toBeNull();
    expect(typeViolation("ABOUT", "Person")).toMatch(/not valid/);
    expect(typeViolation("USES", "Concept")).toBeNull();
  });
});

describe("VerbSelector.select", () => {
  it("returns a confident, documented verb", async () => {
    const { jev, calls } = jevAnswering("DEPLOYED_TO");
    expect(await new VerbSelector(jev).select(edge)).toEqual({ verb: "DEPLOYED_TO", confidence: 0.9 });
    expect((calls[0] as { state: { evidence: string } }).state.evidence).toBe(edge.evidence);
  });

  it.each([
    ["the model keeps RELATED_TO", KEEP, 0.9, 0.9, "kept"],
    ["confidence is below the bar", "DEPLOYED_TO", 0.4, 0.9, "low_confidence"],
    ["the evidence names no relationship", "DEPLOYED_TO", 0.9, 0.2, "no_evidence"],
    ["the verb is outside the vocabulary", "TELEPORTS_TO", 0.9, 0.9, "not_in_vocabulary"],
    ["the verb is identity-level", "ALIAS_OF", 0.9, 0.9, "not_in_vocabulary"],
    ["the source type is wrong for the verb", "WORKS_AT", 0.9, 0.9, "type_mismatch"],
  ])("keeps RELATED_TO when %s", async (_label, verb, conf, support, reason) => {
    const { jev } = jevAnswering(verb, conf, support);
    expect(await new VerbSelector(jev).select(edge)).toEqual({ keep: reason });
  });

  it("keeps RELATED_TO on a network error, without throwing", async () => {
    const errors: string[] = [];
    const { jev } = jevAnswering("DEPLOYED_TO", 0.9, 0.9, { fail: true });
    expect(await new VerbSelector(jev, undefined, (m) => errors.push(m)).select(edge)).toEqual({ keep: "error" });
    expect(errors[0]).toMatch(/network down/);
  });

  it("keeps RELATED_TO once the budget is spent, without calling the API", async () => {
    const { jev, calls } = jevAnswering("DEPLOYED_TO", 0.9, 0.9, { maxTokens: 50 });
    expect(await new VerbSelector(jev).select(edge)).toEqual({ keep: "budget" });
    expect(calls).toHaveLength(0);
  });

  it("never sends personal identifiers", async () => {
    const { jev, calls } = jevAnswering("USES");
    const r = await new VerbSelector(jev).select({ ...edge, evidence: "contact is someone@example.com" });
    expect(r).toEqual({ keep: "pii" });
    expect(calls).toHaveLength(0);
  });
});

describe("applyVerbSelection", () => {
  const describeRef = (ref: string) =>
    ({ a: { name: "Falcon API", type: "Project" }, b: { name: "Test Cluster", type: "Object" } })[ref] ?? { name: ref };

  it("relabels RELATED_TO and unknown verbs, leaves documented ones alone", async () => {
    const { jev, calls } = jevAnswering("DEPLOYED_TO", 0.8);
    const { relations, selections } = await applyVerbSelection(new VerbSelector(jev), [
      { from: "a", to: "b", relation: "RELATED_TO", evidence: "runs there" },
      { from: "a", to: "b", relation: "LIVES_ON_SERVER", properties: { note: "x" } },
      { from: "a", to: "b", relation: "USES" },
      { from: "a", to: "b", relation: "bad`verb" },
    ], describeRef);

    expect(calls).toHaveLength(2);
    expect(relations[0]).toMatchObject({
      relation: "DEPLOYED_TO",
      properties: { verb_selected_by: "jev", verb_selection_confidence: 0.8 },
    });
    expect(relations[0].properties).not.toHaveProperty("verb_requested");
    expect(relations[1]).toMatchObject({
      relation: "DEPLOYED_TO",
      properties: { note: "x", verb_requested: "LIVES_ON_SERVER" },
    });
    expect(relations[2].relation).toBe("USES");
    expect(relations[3].relation).toBe("bad`verb");
    expect(selections).toHaveLength(2);
    expect((calls[1] as { state: { requested_verb: string } }).state.requested_verb).toBe("LIVES_ON_SERVER");
  });

  it("reports what it kept", async () => {
    const { jev } = jevAnswering(KEEP);
    const { relations, selections } = await applyVerbSelection(
      new VerbSelector(jev), [{ from: "a", to: "b", relation: "RELATED_TO" }], describeRef,
    );
    expect(relations[0].relation).toBe("RELATED_TO");
    expect(selections[0]).toMatchObject({ relation: "RELATED_TO", kept: "kept" });
  });
});
