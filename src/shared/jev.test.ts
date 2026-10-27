import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JevBudget, JevBudgetError, JevClient, piiReason, resolveJevKey } from "./jev.js";

const root = mkdtempSync(join(tmpdir(), "jev-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A fetch stand-in that records calls and replies with `body`. */
function fakeFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const ok = { model: "jev-x", answers: { q: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 120, output_tokens: 3 } };
const question = { q: { type: "noul" as const, instructions: "Is it a widget?" } };

describe("JevBudget", () => {
  it("refuses a request that would cross the cap", () => {
    const b = new JevBudget(1000);
    expect(b.canSpend(900)).toBe(true);
    b.record(900);
    expect(b.canSpend(200)).toBe(false);
    expect(b.canSpend(100)).toBe(true);
  });

  it("resets when its window rolls over", () => {
    let t = 0;
    const b = new JevBudget(100, 1000, () => t);
    b.record(100);
    expect(b.canSpend(1)).toBe(false);
    t = 1000;
    expect(b.canSpend(1)).toBe(true);
    expect(b.spentTokens).toBe(0);
  });

  it("converts dollars to input tokens", () => {
    expect(JevBudget.fromUsd(0.042).maxInputTokens).toBe(1_000_000);
  });
});

describe("JevClient", () => {
  it("sends the key as a bearer token and records usage", async () => {
    const f = fakeFetch(ok);
    const budget = new JevBudget(10_000);
    const jev = new JevClient({ apiKey: "test-key", budget, fetch: f.fn });
    const res = await jev.ask({ name: "Acme Widget" }, question);
    expect(res.answers.q).toEqual({ type: "noul", noul: 0.9 });
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(JSON.parse(String(f.calls[0].init.body)).model).toBe("jev-latest");
    expect(budget.spentTokens).toBe(120);
  });

  it("refuses before calling the API when the budget is spent", async () => {
    const f = fakeFetch(ok);
    const jev = new JevClient({ apiKey: "k", budget: new JevBudget(10), fetch: f.fn });
    await expect(jev.ask({ name: "Acme Widget" }, question)).rejects.toBeInstanceOf(JevBudgetError);
    expect(f.calls).toHaveLength(0);
  });

  it("throws on an HTTP error or a malformed reply", async () => {
    const budget = new JevBudget(10_000);
    await expect(new JevClient({ apiKey: "k", budget, fetch: fakeFetch({ detail: "bad" }, 422).fn }).ask({}, question))
      .rejects.toThrow(/HTTP 422/);
    await expect(new JevClient({ apiKey: "k", budget, fetch: fakeFetch("<html>").fn }).ask({}, question))
      .rejects.toThrow(/non-JSON/);
    await expect(new JevClient({ apiKey: "k", budget, fetch: fakeFetch({ answers: {} }).fn }).ask({}, question))
      .rejects.toThrow(/missing/);
  });
});

describe("resolveJevKey", () => {
  it("reads a bare key or a JEV_API_KEY= line from the file", () => {
    const bare = join(root, "bare");
    writeFileSync(bare, "abc123\n");
    expect(resolveJevKey({ JEV_API_KEY_FILE: bare })).toBe("abc123");
    const line = join(root, "line");
    writeFileSync(line, "# comment\nJEV_API_KEY=xyz789\n");
    expect(resolveJevKey({ JEV_API_KEY_FILE: line })).toBe("xyz789");
  });

  it("names the path, not the contents, when it can't", () => {
    expect(() => resolveJevKey({})).toThrow(/JEV_API_KEY_FILE/);
    expect(() => resolveJevKey({ JEV_API_KEY_FILE: join(root, "missing") })).toThrow(/does not exist/);
  });
});

describe("piiReason", () => {
  it("holds back personal identifiers", () => {
    expect(piiReason("someone@example.com")).toMatch(/email/);
    expect(piiReason("Note", "SSN on file")).toMatch(/social security/);
    expect(piiReason("Card 4111 1111 1111 1111")).toMatch(/card/);
    expect(piiReason("Pat's date of birth")).toMatch(/birth/);
  });

  it("lets ordinary names through", () => {
    expect(piiReason("Project Falcon", "Acme Widgets", undefined, null)).toBeNull();
  });
});
