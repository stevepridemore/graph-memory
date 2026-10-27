#!/usr/bin/env node
// Standalone dream runner: runs prompts/dream-nightly.md against the Claude
// Messages API with an Anthropic API key, instead of as a Claude Code
// scheduled task on a claude.ai subscription.
//
//   node dist/dream-runner/index.js            # one run, then exit
//   node dist/dream-runner/index.js --daemon   # run daily at DREAM_SCHEDULE
//
// The graph tools come from this repo's own MCP server, spawned over stdio as
// a child process (the same way .mcp.json.example connects Claude Code), so it
// runs as LOCAL_TENANT_ID with no network auth. File access goes through the
// confined tools in file-tools.ts. See docs/DREAM_PROCESS.md, "API-key runner".

import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { GRAPH_MEMORY_HOME } from "../shared/config.js";
import { acquireLock, releaseLock } from "../shared/dream-lock.js";
import { resolveApiKey } from "./api-key.js";
import { FILE_TOOLS, FILE_TOOL_NAMES, runFileTool, type FileRoots } from "./file-tools.js";
import { findPendingWork, totalPending, type PendingWork } from "./pending.js";
import { TRANSCRIPT_TOOLS, TRANSCRIPT_TOOL_NAMES, TranscriptTools } from "./transcript-tools.js";

const here = dirname(fileURLToPath(import.meta.url));

// ─── Settings (env) ───

export interface RunnerSettings {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxCostUsd: number;
  maxTurns: number;
  maxToolResultChars: number;
  fallbacks: boolean;
  schedule: string;
  promptPath: string;
  excludeTools: Set<string>;
  activeMinutes: number;
  roots: FileRoots;
  force: boolean;
}

// Graph tools left out of an unattended run: ones the nightly prompt never
// calls, plus graph_read_transcript, which read_transcript replaces (it
// returns a whole session at once). DREAM_EXCLUDE_TOOLS overrides the list
// ("" keeps all).
const DEFAULT_EXCLUDED_TOOLS =
  "graph_cypher,graph_prune,graph_reembed,graph_export,graph_ingest,graph_unmerge,graph_read_transcript";

// Models whose server-side `fallbacks: "default"` mode is accepted.
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

export function loadSettings(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): RunnerSettings {
  const model = env.DREAM_MODEL?.trim() || "claude-opus-5-5";
  const effort = (env.DREAM_EFFORT?.trim() || "medium") as RunnerSettings["effort"];
  if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) {
    throw new Error(`DREAM_EFFORT must be low, medium, high, xhigh or max (got ${effort})`);
  }
  const num = (name: string, fallback: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number (got ${raw})`);
    return n;
  };
  const fallbackSetting = env.DREAM_FALLBACKS?.trim().toLowerCase();
  const promptOverride = env.DREAM_PROMPT?.trim();
  const hostPrompt = join(GRAPH_MEMORY_HOME, "prompts", "dream-nightly.md");
  return {
    model,
    effort,
    maxCostUsd: num("DREAM_MAX_COST_USD", 3),
    maxTurns: Math.floor(num("DREAM_MAX_TURNS", 200)),
    maxToolResultChars: Math.floor(num("DREAM_MAX_TOOL_RESULT_CHARS", 40_000)),
    fallbacks: fallbackSetting === "off" ? false : FALLBACK_MODELS.has(model),
    schedule: env.DREAM_SCHEDULE?.trim() || "02:30",
    excludeTools: new Set(
      (env.DREAM_EXCLUDE_TOOLS ?? DEFAULT_EXCLUDED_TOOLS).split(",").map((t) => t.trim()).filter(Boolean),
    ),
    activeMinutes: env.DREAM_SKIP_ACTIVE_MINUTES?.trim() === "0" ? 0 : num("DREAM_SKIP_ACTIVE_MINUTES", 30),
    promptPath: promptOverride || (existsSync(hostPrompt) ? hostPrompt : join(here, "..", "..", "prompts", "dream-nightly.md")),
    roots: {
      graphHome: GRAPH_MEMORY_HOME,
      projectsDir: env.DREAM_PROJECTS_DIR?.trim() || join(homedir(), ".claude", "projects"),
    },
    force: argv.includes("--force"),
  };
}

// ─── Cost estimate ───

// USD per million tokens: [input, output, cache read]. Cache writes are
// billed at 1.25x input (5-minute TTL). Unknown models use the Opus row.
const PRICES: Record<string, [number, number, number]> = {
  "claude-fable-5-1": [10, 50, 0.25],
  "claude-opus-5-5": [4, 20, 0.2],
  "claude-opus-5": [5, 25, 0.5],
  "claude-sonnet-5-5": [2, 10, 0.2],
  "claude-sonnet-5": [2, 10, 0.2],
  "claude-haiku-5-5": [0.1, 0.5, 0.01],
};

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function estimateCostUsd(model: string, u: UsageTotals): number {
  const [inp, out, read] = PRICES[model] ?? PRICES["claude-opus-5-5"];
  return (u.input * inp + u.cacheWrite * inp * 1.25 + u.cacheRead * read + u.output * out) / 1_000_000;
}

// ─── Prompt ───

const RUNNER_NOTES = `

---

## Runner notes (API-key runner)

You are running from the standalone dream runner, not from Claude Code. Nobody is watching this run, so don't ask questions: make the call the prompt describes and note anything doubtful in the changelog.

- **Discovery is done (Step 3).** The first message lists the exact pending transcripts (oldest first, each marked new or delta, with previous_processed_at for deltas) and the pending text ingest files. Work from that list. Don't list ~/.claude/projects and don't read manifest.json: both are large, and the runner has already compared them. Do read ~/graph-memory/config.json for max_transcripts_per_run and the other settings.
- **Reading transcripts (Steps 4a-4b).** Use read_transcript instead of graph_read_transcript. It runs the same parser and returns pages of messages; for a delta item pass since = previous_processed_at and you get only the new messages. Page through with next_offset until it is null. You can extract and write to the graph page by page rather than holding the whole session.
- **Manifest (Step 4h).** Use update_manifest instead of editing manifest.json. Call it once per transcript as soon as you finish it, including ones you skip (format, agent-internal, empty delta), so they aren't offered again.
- **Other tools.** The graph tools are the graph-memory MCP tools. For files you have list_dir, stat_file, read_file, write_file, move_file and delete_file. They accept the prompt's paths as written (~/graph-memory/...). ~/.claude/projects is read-only. There is no shell.
- **Lock.** The runner has already acquired ~/graph-memory/processed/dream.lock and releases it after you finish, so skip creating it in Step 2 and deleting it in Step 10. Still make the graph_audit run_start and run_end calls, with "source": "api-runner".
- **MarkItDown is not available.** Take Step 5a's "not installed" branch: skip conversion, leave binary files in pending/, and say so in the changelog Notes.
- **Large results.** A tool result over the size limit is saved to a file and you get the start of it plus the path. Read the rest with read_file and an offset before extracting from it.
- **Budget.** If a message tells you the run's budget is spent, stop starting new transcripts or documents. Finish the item in hand, update the manifest for it, write the changelog (noting what's left for the next run), make the run_end audit call, and stop.
- **Finish** with a short plain-text summary of what the run did. That ends the run.
`;

// The pending list goes in the first user message, not the system prompt, so
// the system prompt stays byte-identical across runs for caching.
export function kickoffMessage(started: Date, pending: PendingWork): string {
  const transcripts = pending.transcripts.map((t) => ({
    session_id: t.session_id,
    path: t.path,
    mode: t.mode,
    size_bytes: t.size_bytes,
    modified: t.modified,
    ...(t.previous_processed_at ? { previous_processed_at: t.previous_processed_at } : {}),
  }));
  return [
    `Run the nightly dream process now. Current time: ${started.toISOString()}.`,
    "",
    `Pending transcripts (${transcripts.length}, oldest first; process up to max_transcripts_per_run):`,
    "```json",
    JSON.stringify(transcripts, null, 1),
    "```",
    "",
    `Pending text ingest files in ~/graph-memory/ingest/pending/ (${pending.ingest.length}):` +
      (pending.ingest.length ? "\n" + pending.ingest.map((f) => `- ${f}`).join("\n") : " none"),
  ].join("\n");
}

export function buildSystemPrompt(promptPath: string): string {
  return readFileSync(promptPath, "utf-8") + RUNNER_NOTES;
}

// ─── Logging ───

function makeLogger(logPath: string) {
  mkdirSync(dirname(logPath), { recursive: true });
  return (line: string) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    console.error(stamped);
    try { appendFileSync(logPath, stamped + "\n"); } catch { /* logging is best-effort */ }
  };
}

function stamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ─── MCP ───

async function connectGraphServer(): Promise<Client> {
  // Pass the environment through (the server needs NEO4J_*, GRAPH_MEMORY_HOME,
  // tenant ids) but not the API key: the server has no use for it.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("ANTHROPIC_")) env[k] = v;
  }
  env.MCP_TRANSPORT = "stdio";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [process.env.DREAM_MCP_SERVER?.trim() || join(here, "..", "mcp-server", "index.js")],
    env,
    stderr: "ignore",
  });
  const client = new Client({ name: "graph-dream-runner", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

async function graphTools(mcp: Client, exclude: Set<string>): Promise<Anthropic.Beta.BetaTool[]> {
  const tools: Anthropic.Beta.BetaTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await mcp.listTools(cursor ? { cursor } : undefined);
    for (const t of page.tools) {
      if (exclude.has(t.name)) continue;
      tools.push({
        name: t.name,
        description: t.description ?? t.title ?? t.name,
        input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
      });
    }
    cursor = page.nextCursor;
  } while (cursor);
  // Sorted so the tools prefix is byte-identical run to run (prompt caching).
  return tools.sort((a, b) => a.name.localeCompare(b.name));
}

function mcpResultText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const parts = content.map((c: { type: string; text?: string }) =>
    c.type === "text" ? (c.text ?? "") : `[${c.type} content omitted]`,
  );
  if (parts.length === 0 && result.structuredContent) return JSON.stringify(result.structuredContent);
  return parts.join("\n");
}

// ─── One run ───

export type RunOutcome = "nothing_pending" | "locked" | "completed" | "budget_stopped" | "turn_limit" | "refused" | "error";

/** Seams for tests: a fake Messages client and a fake graph server. */
export interface RunnerDeps {
  anthropic?: Pick<Anthropic, "beta">;
  connect?: () => Promise<Client>;
}

export async function runDream(settings: RunnerSettings, deps: RunnerDeps = {}): Promise<RunOutcome> {
  const started = new Date();
  const runId = stamp(started);
  const logDir = join(settings.roots.graphHome, "logs", "dream-runner");
  const log = makeLogger(join(logDir, `${runId}.log`));

  const pending = findPendingWork(settings.roots.graphHome, settings.roots.projectsDir, {
    activeMinutes: settings.activeMinutes,
  });
  if (totalPending(pending) === 0 && !settings.force) {
    log("nothing pending; no API call made");
    return "nothing_pending";
  }
  log(
    `pending: ${pending.newTranscripts} new, ${pending.grownTranscripts} grown transcripts, ${pending.ingestFiles} ingest files` +
      (pending.skippedActive ? ` (${pending.skippedActive} still active, left for next run)` : ""),
  );

  mkdirSync(join(homedir(), "graph-memory", "processed"), { recursive: true });
  if (!acquireLock("api-runner")) {
    log("dream.lock is held by another run; exiting");
    return "locked";
  }

  const spillDir = join(settings.roots.graphHome, "dream-runner", "spill", runId);
  const usage: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let outcome: RunOutcome = "error";
  let turns = 0;
  let mcp: Client | null = null;

  try {
    const client = deps.anthropic ?? new Anthropic({ apiKey: resolveApiKey(), maxRetries: 4 });
    mcp = await (deps.connect ?? connectGraphServer)();
    const tools = [...(await graphTools(mcp, settings.excludeTools)), ...FILE_TOOLS, ...TRANSCRIPT_TOOLS];
    const transcriptTools = new TranscriptTools(pending.transcripts, settings.roots.graphHome, Math.floor(settings.maxToolResultChars * 0.75));
    log(`model=${settings.model} effort=${settings.effort} tools=${tools.length} budget=$${settings.maxCostUsd}`);

    const system = buildSystemPrompt(settings.promptPath);
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      {
        role: "user",
        content: kickoffMessage(started, pending),
      },
    ];

    const betas: Anthropic.Beta.AnthropicBeta[] = ["context-management-2025-06-27"];
    if (settings.fallbacks) betas.push("server-side-fallback-2026-07-01");

    let wrapUpSent = false;
    let turnLimit = settings.maxTurns;

    while (turns < turnLimit) {
      turns++;
      const response = await client.beta.messages.create({
        model: settings.model,
        max_tokens: 16000,
        betas,
        ...(settings.fallbacks ? { fallbacks: "default" as const } : {}),
        output_config: { effort: settings.effort },
        // Caches the growing conversation; tools + system stay a stable prefix.
        cache_control: { type: "ephemeral" },
        // Old tool results (transcripts mostly) are cleared once the
        // conversation gets long. The manifest and changelog are on disk.
        context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
        system,
        tools,
        messages,
      });

      usage.input += response.usage.input_tokens;
      usage.output += response.usage.output_tokens;
      usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
      usage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0;
      const cost = estimateCostUsd(settings.model, usage);

      // Append the whole content unchanged (thinking blocks included).
      messages.push({ role: "assistant", content: response.content });

      const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      log(`turn ${turns}: stop=${response.stop_reason} tools=[${toolUses.map((t) => t.name).join(", ")}] cost~$${cost.toFixed(3)}`);

      if (response.stop_reason === "refusal") {
        log(`refused (${response.stop_details?.category ?? "no category"}); stopping`);
        outcome = "refused";
        break;
      }
      if (response.stop_reason === "pause_turn") continue;
      if (response.stop_reason === "max_tokens" && toolUses.length === 0) {
        messages.push({ role: "user", content: "Your last reply was cut off at the output limit. Continue from where it stopped." });
        continue;
      }
      if (toolUses.length === 0) {
        const text = response.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (text) log(`summary: ${text.replace(/\s+/g, " ")}`);
        outcome = wrapUpSent ? "budget_stopped" : "completed";
        break;
      }

      if (cost >= settings.maxCostUsd * 1.5) {
        log(`estimated cost passed 1.5x the $${settings.maxCostUsd} budget during wrap-up; stopping`);
        outcome = "budget_stopped";
        break;
      }

      const results: Anthropic.Beta.BetaContentBlockParam[] = [];
      for (const use of toolUses) {
        results.push(await runTool(use, mcp, transcriptTools, settings, spillDir));
      }
      // Wrap-up starts at 80% so the closing turns (changelog, audit) land
      // near the budget rather than well past it.
      if (!wrapUpSent && cost >= settings.maxCostUsd * 0.8) {
        wrapUpSent = true;
        turnLimit = turns + 20;
        log(`80% of the $${settings.maxCostUsd} budget used; asking the model to wrap up`);
        results.push({
          type: "text",
          text: `Runner: this run's budget ($${settings.maxCostUsd}) is spent. Wrap up now as the Runner notes describe.`,
        });
      }
      messages.push({ role: "user", content: results });
    }

    if (turns >= turnLimit && outcome === "error") {
      log(`stopped at the turn limit (${turnLimit})`);
      outcome = "turn_limit";
    }
  } catch (err) {
    log(`error: ${err instanceof Error ? err.message : String(err)}`);
    outcome = "error";
  } finally {
    try { await mcp?.close(); } catch { /* already gone */ }
    rmSync(spillDir, { recursive: true, force: true });
    releaseLock();
    const cost = estimateCostUsd(settings.model, usage);
    const summary = {
      run_id: runId,
      started: started.toISOString(),
      finished: new Date().toISOString(),
      outcome,
      model: settings.model,
      turns,
      usage,
      estimated_cost_usd: Number(cost.toFixed(4)),
    };
    log(`done: ${outcome}, ${turns} turns, ~$${cost.toFixed(3)}`);
    try { appendFileSync(join(logDir, "runs.jsonl"), JSON.stringify(summary) + "\n"); } catch { /* best-effort */ }
  }
  return outcome;
}

async function runTool(
  use: Anthropic.Beta.BetaToolUseBlock,
  mcp: Client,
  transcriptTools: TranscriptTools,
  settings: RunnerSettings,
  spillDir: string,
): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  const input = (use.input ?? {}) as Record<string, unknown>;
  let text: string;
  let isError = false;
  try {
    if (FILE_TOOL_NAMES.has(use.name)) {
      text = runFileTool(use.name, input, settings.roots);
    } else if (TRANSCRIPT_TOOL_NAMES.has(use.name)) {
      text = transcriptTools.run(use.name, input);
    } else if (settings.excludeTools.has(use.name)) {
      throw new Error(`${use.name} is not available to the dream runner`);
    } else {
      const result = await mcp.callTool({ name: use.name, arguments: input });
      text = mcpResultText(result);
      isError = result.isError === true;
    }
  } catch (err) {
    text = err instanceof Error ? err.message : String(err);
    isError = true;
  }

  if (text.length > settings.maxToolResultChars) {
    mkdirSync(spillDir, { recursive: true });
    const spillPath = join(spillDir, `${use.id}.txt`);
    writeFileSync(spillPath, text, "utf-8");
    const shown = text.slice(0, settings.maxToolResultChars);
    const rel = spillPath.slice(settings.roots.graphHome.length).replace(/\\/g, "/");
    text =
      `[This result is ${text.length} characters, over the ${settings.maxToolResultChars} limit. ` +
      `The full result is saved at ~/graph-memory${rel}. The first ${shown.length} characters follow; ` +
      `read the rest with read_file starting at offset ${shown.length}.]\n` + shown;
  }
  return { type: "tool_result", tool_use_id: use.id, content: text || "(empty)", ...(isError ? { is_error: true } : {}) };
}

// ─── Daemon ───

export function nextRunAt(schedule: string, now = new Date()): Date {
  const m = /^(\d{1,2}):(\d{2})$/.exec(schedule);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
    throw new Error(`DREAM_SCHEDULE must be HH:MM in 24-hour local time (got ${schedule})`);
  }
  const next = new Date(now);
  next.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

async function daemon(settings: RunnerSettings): Promise<void> {
  let stopping = false;
  let wake: (() => void) | null = null;
  const stop = () => { stopping = true; wake?.(); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  while (!stopping) {
    const at = nextRunAt(settings.schedule);
    console.error(`[dream-runner] next run at ${at.toString()}`);
    await new Promise<void>((resolve) => {
      wake = resolve;
      // Re-check at least hourly so clock or DST changes can't strand it.
      setTimeout(resolve, Math.min(at.getTime() - Date.now(), 60 * 60 * 1000));
    });
    wake = null;
    if (stopping) break;
    if (Date.now() < at.getTime()) continue;
    await runDream(settings).catch((err) => console.error(`[dream-runner] run failed: ${err}`));
  }
}

// ─── Entry ───

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const settings = loadSettings();
  if (process.argv.includes("--daemon")) {
    await daemon(settings);
  } else {
    const outcome = await runDream(settings);
    process.exit(outcome === "error" || outcome === "refused" ? 1 : 0);
  }
}
