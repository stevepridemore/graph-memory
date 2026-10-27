// Client for TypeSafe's Jev model (System One): typed judgments and
// probabilities rather than generated text. Two optional features use it,
// both off by default: verb selection for edges that would otherwise be
// stored as RELATED_TO (verb-select.ts), and the dream runner's log-only
// duplicate check (dream-runner/duplicates.ts).
//
// API: POST {model, state, questions} -> {answers, usage}. Input tokens are
// billed, output tokens are free. See https://docs.typesafe.ai/api.

import { readSecretFile } from "../dream-runner/api-key.js";

export const JEV_DEFAULT_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_DEFAULT_MODEL = "jev-latest";

/** $0.042 per million input tokens. Output tokens are free. */
export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export const jevCostUsd = (inputTokens: number): number => inputTokens * JEV_USD_PER_INPUT_TOKEN;

// ─── Wire types ───

export type JevQuestion =
  | { type: "choice"; instructions: unknown; criteria: Record<string, unknown> }
  | { type: "noul"; instructions: unknown; criteria?: { true: unknown; false: unknown } }
  | { type: "score"; instructions: unknown; criteria: unknown[] };

export type JevAnswer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> };

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

export class JevBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevBudgetError";
  }
}

// ─── Budget ───

/**
 * A spending cap in input tokens. With `windowMs` the count resets when the
 * window rolls over (a long-running server caps per day); without it the cap
 * covers the budget's whole lifetime (one dream run).
 *
 * A request is refused up front when its estimated size would cross the cap,
 * so the cap is never overshot by more than one estimate's error.
 */
export class JevBudget {
  private spent = 0;
  private windowStart: number;

  constructor(
    readonly maxInputTokens: number,
    private readonly windowMs: number | null = null,
    private readonly now: () => number = Date.now,
  ) {
    this.windowStart = now();
  }

  static fromUsd(maxUsd: number, windowMs: number | null = null, now?: () => number): JevBudget {
    // The epsilon absorbs float error ($0.042 is 999,999.99... tokens otherwise).
    return new JevBudget(Math.floor(maxUsd / JEV_USD_PER_INPUT_TOKEN + 1e-6), windowMs, now);
  }

  private roll(): void {
    if (this.windowMs !== null && this.now() - this.windowStart >= this.windowMs) {
      this.spent = 0;
      this.windowStart = this.now();
    }
  }

  canSpend(estimate: number): boolean {
    this.roll();
    return this.spent + estimate <= this.maxInputTokens;
  }

  record(inputTokens: number): void {
    this.roll();
    this.spent += inputTokens;
  }

  get spentTokens(): number {
    this.roll();
    return this.spent;
  }
}

// ─── Client ───

export interface JevClientOptions {
  apiKey: string;
  url?: string;
  model?: string;
  timeoutMs?: number;
  budget: JevBudget;
  /** Seam for tests. */
  fetch?: typeof fetch;
}

/** Rough token count for the pre-flight budget check: ~3 characters per
 *  token, which over-counts JSON slightly and so errs toward refusing. */
export const estimateTokens = (body: string): number => Math.ceil(body.length / 3);

export class JevClient {
  private readonly url: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: JevClientOptions) {
    this.url = opts.url ?? JEV_DEFAULT_URL;
    this.model = opts.model ?? JEV_DEFAULT_MODEL;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.fetchFn = opts.fetch ?? fetch;
  }

  get budget(): JevBudget {
    return this.opts.budget;
  }

  /** Ask a set of independent questions over one state. Throws on a network
   *  error, timeout, non-2xx reply, malformed body, or a spent budget. */
  async ask(state: unknown, questions: Record<string, JevQuestion>): Promise<JevResponse> {
    const body = JSON.stringify({ model: this.model, state, questions });
    if (!this.opts.budget.canSpend(estimateTokens(body))) {
      throw new JevBudgetError("Jev budget for this period is spent");
    }

    const res = await this.fetchFn(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${text.slice(0, 200)}`);

    let parsed: JevResponse;
    try {
      parsed = JSON.parse(text) as JevResponse;
    } catch {
      throw new Error(`Jev returned non-JSON: ${text.slice(0, 200)}`);
    }
    if (!parsed.answers || typeof parsed.usage?.input_tokens !== "number") {
      throw new Error("Jev response is missing answers or usage");
    }
    this.opts.budget.record(parsed.usage.input_tokens);
    return parsed;
  }
}

// ─── Settings ───

const DAY_MS = 24 * 60 * 60 * 1000;

export const isOn = (v: string | undefined): boolean => /^(1|on|true|yes)$/i.test(v?.trim() ?? "");

export function positiveEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number (got ${raw})`);
  return n;
}

/** Read the key from JEV_API_KEY_FILE (bare value or a JEV_API_KEY=... line).
 *  Never logged; errors name the path only. */
export function resolveJevKey(env: NodeJS.ProcessEnv = process.env): string {
  const keyPath = env.JEV_API_KEY_FILE?.trim();
  if (!keyPath) throw new Error("No Jev key: set JEV_API_KEY_FILE");
  return readSecretFile(keyPath, "JEV_API_KEY_FILE", /^(?:export\s+)?JEV_API_KEY\s*=\s*(.+)$/);
}

/** Build a client for one feature. `cap` names the env var holding that
 *  feature's USD cap and whether it resets daily. Throws when the key is missing. */
export function jevClientFromEnv(
  env: NodeJS.ProcessEnv,
  cap: { name: string; defaultUsd: number; perDay: boolean },
): JevClient {
  return new JevClient({
    apiKey: resolveJevKey(env),
    url: env.JEV_URL?.trim() || JEV_DEFAULT_URL,
    model: env.JEV_MODEL?.trim() || JEV_DEFAULT_MODEL,
    timeoutMs: positiveEnv(env, "JEV_TIMEOUT_MS", 8000),
    budget: JevBudget.fromUsd(positiveEnv(env, cap.name, cap.defaultUsd), cap.perDay ? DAY_MS : null),
  });
}

// ─── Privacy ───

// Names or notes carrying personal identifiers stay on this machine: an
// item matching any of these is never sent to the API.
const PII_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /[\w.+-]+@[\w-]+\.[\w.]+/, why: "contains an email address" },
  { re: /\bSSN\b|social security/i, why: "references a social security number" },
  { re: /\b\d{3}-\d{2}-\d{4}\b/, why: "contains an SSN-shaped number" },
  { re: /birthday|date of birth|\bDOB\b/i, why: "references a date of birth" },
  { re: /\b(?:\d[ -]?){13,19}\b/, why: "contains a card-length number" },
];

/** Why `texts` must not leave the machine, or null when they may. */
export function piiReason(...texts: Array<string | null | undefined>): string | null {
  const joined = texts.filter(Boolean).join(" ");
  for (const { re, why } of PII_PATTERNS) if (re.test(joined)) return why;
  return null;
}
