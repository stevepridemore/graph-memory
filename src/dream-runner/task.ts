#!/usr/bin/env node
// General API task runner: runs one scheduled prompt (a Claude Code
// scheduled-task SKILL.md, say) on the Messages API with the same Anthropic
// API key as the dream runner, with only the capabilities its task file
// grants. There is no shell. Instead the task file lists:
//
//   - a working folder (read anywhere under it, write only under write_paths)
//   - commands: fixed executable + fixed leading args, one model-supplied
//     argument checked against a pattern, optional flags from a fixed list
//   - http: URL prefixes and methods; a bearer token or {{VAR}} values read
//     from files and injected here, so the model never sees them
//   - mcp_servers: stdio MCP servers, with an allowlist of their tools
//   - email: a gws-mcp notify profile (fixed sender and recipient)
//
//   node dist/dream-runner/task.js path/to/task.json
//
// Runs log to <log_dir>/<run_id>-<name>.log and append to <log_dir>/runs.jsonl,
// which by default is the dream runner's, so its month-to-date spend counts
// these runs too. See docs/DREAM_PROCESS.md, "Other scheduled tasks".

import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveApiKey, readSecretFile } from "./api-key.js";
import { FALLBACK_MODELS, estimateCostUsd, makeLogger, mcpResultText, stamp, type UsageTotals } from "./index.js";
import { notifySender, type SendFn } from "./notify.js";

// ─── Task file ───

export interface CommandSpec {
  /** Tool name the model sees, e.g. "ads_query". */
  name: string;
  description: string;
  exe: string;
  /** Fixed leading arguments, e.g. ["tools/ads-query.py"]. */
  args?: string[];
  /** The one argument the model supplies, checked against `pattern`. */
  arg: { name: string; description: string; pattern: string };
  /** Flags the model may add, from this list only. */
  flags?: string[];
  timeout_s?: number;
}

export interface HttpSpec {
  prefix: string;
  methods: string[];
  /** File whose contents go in `Authorization: Bearer ...`. */
  bearer_file?: string;
  /** {{NAME}} in the URL or body is replaced with this file's contents. */
  vars?: Record<string, string>;
}

export interface McpSpec {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Tools the model may call; the rest are hidden. */
  tools: string[];
}

export interface TaskFile {
  name: string;
  prompt_file: string;
  /** Appended to the prompt: how this task's instructions map onto the tools. */
  notes?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  max_cost_usd?: number;
  max_turns?: number;
  workdir: string;
  /** Relative to workdir. Folders or files the task may write. */
  write_paths?: string[];
  commands?: CommandSpec[];
  http?: HttpSpec[];
  mcp_servers?: McpSpec[];
  email?: { url: string; token_file: string; max_per_run?: number };
  log_dir?: string;
}

const expand = (p: string) => (p.startsWith("~/") || p.startsWith("~\\") ? join(homedir(), p.slice(2)) : p);

export function loadTask(path: string): TaskFile {
  const raw = readFileSync(path, "utf-8");
  const task = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as TaskFile;
  for (const k of ["name", "prompt_file", "workdir"] as const) {
    if (typeof task[k] !== "string" || !task[k]) throw new Error(`task file needs "${k}"`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(task.name)) throw new Error(`task name must be kebab-case (got ${task.name})`);
  for (const c of task.commands ?? []) new RegExp(c.arg.pattern); // fail early on a bad pattern
  return task;
}

// ─── Confined file tools ───

const WIN = process.platform === "win32";
const norm = (p: string) => (WIN ? p.toLowerCase() : p);

function isInside(child: string, parent: string): boolean {
  const rel = relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Resolve symlinks on the longest existing prefix, so a link can't step outside. */
function realish(p: string): string {
  let cur = p;
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) return p;
    tail.unshift(cur.slice(up.length).replace(/^[\\/]/, ""));
    cur = up;
  }
  return join(realpathSync(cur), ...tail);
}

export function resolveTaskPath(raw: string, task: TaskFile, mode: "read" | "write"): string {
  const root = realish(resolve(expand(task.workdir)));
  const full = realish(resolve(root, expand(raw)));
  if (!isInside(full, root)) throw new Error(`${raw} is outside the task's folder (${task.workdir})`);
  if (mode === "write") {
    const ok = (task.write_paths ?? []).some((w) => isInside(full, resolve(root, w)));
    if (!ok) throw new Error(`${raw} is read-only; this task may write only under: ${(task.write_paths ?? []).join(", ") || "nothing"}`);
  }
  return full;
}

const FILE_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "list_dir",
    description: "List a folder (paths relative to the task's working folder). One line per entry: type, size, modified time, name.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  },
  {
    name: "read_file",
    description: "Read a text file, optionally from a character offset. Long files come back in pages; the result says where to continue.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1 } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a text file. Only paths under the task's writable folders are allowed.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_file",
    description: "Replace one exact, unique occurrence of old_string with new_string in a writable file.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
];

function runFileTool(name: string, input: Record<string, unknown>, task: TaskFile): string {
  const path = String(input.path ?? "");
  if (name === "list_dir") {
    const dir = resolveTaskPath(path || ".", task, "read");
    return readdirSync(dir, { withFileTypes: true })
      .map((e) => {
        const st = statSync(join(dir, e.name));
        return `${e.isDirectory() ? "dir " : "file"} ${String(st.size).padStart(9)} ${st.mtime.toISOString()} ${e.name}`;
      })
      .join("\n") || "(empty)";
  }
  if (name === "read_file") {
    const text = readFileSync(resolveTaskPath(path, task, "read"), "utf-8");
    const offset = Number(input.offset ?? 0);
    const limit = Number(input.limit ?? 30_000);
    const page = text.slice(offset, offset + limit);
    const end = offset + page.length;
    return end < text.length ? `${page}\n[... ${text.length - end} more characters; continue with offset ${end}]` : page;
  }
  if (name === "write_file") {
    const full = resolveTaskPath(path, task, "write");
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, String(input.content ?? ""), "utf-8");
    return `wrote ${path} (${String(input.content ?? "").length} characters)`;
  }
  if (name === "edit_file") {
    const full = resolveTaskPath(path, task, "write");
    const text = readFileSync(full, "utf-8");
    const oldS = String(input.old_string ?? "");
    const count = oldS ? text.split(oldS).length - 1 : 0;
    if (count !== 1) throw new Error(`old_string must occur exactly once in ${path} (found ${count})`);
    writeFileSync(full, text.replace(oldS, () => String(input.new_string ?? "")), "utf-8");
    return `edited ${path}`;
  }
  throw new Error(`unknown file tool ${name}`);
}

// ─── Commands ───

export function commandTool(c: CommandSpec): Anthropic.Beta.BetaTool {
  return {
    name: c.name,
    description: `${c.description}\nRuns: ${[c.exe.split(/[\\/]/).pop(), ...(c.args ?? [])].join(" ")} [flags] <${c.arg.name}>` +
      (c.flags?.length ? `\nAllowed flags: ${c.flags.join(", ")}` : ""),
    input_schema: {
      type: "object",
      properties: {
        [c.arg.name]: { type: "string", description: c.arg.description },
        ...(c.flags?.length ? { flags: { type: "array", items: { type: "string", enum: c.flags } } } : {}),
      },
      required: [c.arg.name],
      additionalProperties: false,
    },
  };
}

export function commandArgv(c: CommandSpec, input: Record<string, unknown>): string[] {
  const value = String(input[c.arg.name] ?? "");
  if (!new RegExp(c.arg.pattern, "s").test(value)) throw new Error(`${c.arg.name} doesn't match the allowed pattern ${c.arg.pattern}`);
  const flags = Array.isArray(input.flags) ? input.flags.map(String) : [];
  for (const f of flags) if (!(c.flags ?? []).includes(f)) throw new Error(`flag ${f} isn't allowed`);
  return [...(c.args ?? []), ...flags, value];
}

function runCommand(c: CommandSpec, input: Record<string, unknown>, task: TaskFile): Promise<string> {
  const argv = commandArgv(c, input);
  return new Promise((resolveP, reject) => {
    const child = spawn(expand(c.exe), argv, { cwd: expand(task.workdir), shell: false, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => child.kill(), (c.timeout_s ?? 120) * 1000);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = `exit ${code}\n${out}${err ? `\n[stderr]\n${err}` : ""}`;
      code === 0 ? resolveP(text) : reject(new Error(text));
    });
  });
}

// ─── HTTP ───

const HTTP_TOOL: Anthropic.Beta.BetaTool = {
  name: "http_request",
  description:
    "Make an HTTP request to one of this task's allowed URLs. Credentials for an allowed host are added for you; " +
    "write {{NAME}} where a configured value (like an account id) belongs in the URL or body. Returns status and body.",
  input_schema: {
    type: "object",
    properties: {
      method: { type: "string", enum: ["GET", "POST"] },
      url: { type: "string" },
      body: { type: "string", description: "Request body (POST). JSON is sent as application/json." },
    },
    required: ["method", "url"],
    additionalProperties: false,
  },
};

export function matchHttp(task: TaskFile, method: string, url: string): HttpSpec {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`not a URL: ${url}`); }
  if (parsed.username || parsed.password) throw new Error("URLs with credentials aren't allowed");
  const spec = (task.http ?? []).find((h) => url.startsWith(h.prefix));
  if (!spec) throw new Error(`${url} isn't an allowed URL for this task. Allowed: ${(task.http ?? []).map((h) => h.prefix).join(", ")}`);
  if (!spec.methods.includes(method)) throw new Error(`${method} isn't allowed for ${spec.prefix}`);
  return spec;
}

async function httpRequest(task: TaskFile, input: Record<string, unknown>): Promise<string> {
  const method = String(input.method ?? "GET").toUpperCase();
  const url = String(input.url ?? "");
  const spec = matchHttp(task, method, url);
  const fill = (s: string) =>
    s.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, name: string) => {
      const file = spec.vars?.[name];
      return file ? readSecretFile(expand(file), name) : m;
    });
  const headers: Record<string, string> = { "User-Agent": "graph-memory-task-runner" };
  if (spec.bearer_file) headers.Authorization = `Bearer ${readSecretFile(expand(spec.bearer_file), "bearer_file")}`;
  let body: string | undefined;
  if (method === "POST" && typeof input.body === "string") {
    body = fill(input.body);
    headers["Content-Type"] = /^\s*[{[]/.test(body) ? "application/json" : "text/plain";
  }
  const res = await fetch(fill(url), { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  return `status ${res.status}\n${text}`;
}

// ─── Email ───

const EMAIL_TOOL: Anthropic.Beta.BetaTool = {
  name: "send_email",
  description:
    "Send one email. The sender and the recipient are fixed by this task's configuration and can't be changed. " +
    "Set html: true to send body as an HTML fragment (inline styles only).",
  input_schema: {
    type: "object",
    properties: { subject: { type: "string" }, body: { type: "string" }, html: { type: "boolean" } },
    required: ["subject", "body"],
    additionalProperties: false,
  },
};

// ─── MCP servers ───

async function connectMcp(spec: McpSpec): Promise<{ client: Client; tools: Anthropic.Beta.BetaTool[] }> {
  const transport = new StdioClientTransport({
    command: expand(spec.command),
    args: spec.args ?? [],
    env: { ...(Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith("ANTHROPIC_"))) as Record<string, string>), ...(spec.env ?? {}) },
    stderr: "ignore",
  });
  const client = new Client({ name: "graph-memory-task-runner", version: "0.1.0" });
  await client.connect(transport);
  const tools: Anthropic.Beta.BetaTool[] = [];
  const page = await client.listTools();
  for (const t of page.tools) {
    if (!spec.tools.includes(t.name)) continue;
    tools.push({ name: t.name, description: t.description ?? t.name, input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema });
  }
  return { client, tools };
}

// ─── Prompt ───

export function buildTaskPrompt(task: TaskFile, toolNames: string[]): string {
  let prompt = readFileSync(expand(task.prompt_file), "utf-8");
  if (prompt.startsWith("---")) {
    const end = prompt.indexOf("\n---", 3);
    if (end > 0) prompt = prompt.slice(end + 4);
  }
  return (
    prompt.trim() +
    `\n\n## Runner notes (API task runner, unattended)\n\n` +
    `This task runs on the Claude API with no shell and no person watching. Your tools are: ${toolNames.join(", ")}. ` +
    `File paths are relative to the working folder (${task.workdir}); you can write only under ${(task.write_paths ?? []).join(", ") || "nothing"}. ` +
    `Where these instructions say to run a command, call the tool that wraps it. Where they say curl or fetch, use http_request. ` +
    `Where they say to email through gws, use send_email (the sender and recipient are already fixed). ` +
    `ToolSearch isn't needed: every tool you have is already loaded. ` +
    `Your final message is the run's summary in the log; keep it to two or three lines.\n` +
    (task.notes ? `\n${task.notes.trim()}\n` : "")
  );
}

// ─── Run ───

export type TaskOutcome = "completed" | "budget_stopped" | "turn_limit" | "refused" | "error";

export interface TaskDeps {
  anthropic?: Pick<Anthropic, "beta">;
  send?: SendFn | null;
}

const MAX_RESULT_CHARS = 40_000;

export async function runTask(task: TaskFile, deps: TaskDeps = {}): Promise<{ outcome: TaskOutcome; costUsd: number; turns: number; logPath: string }> {
  const started = new Date();
  const runId = `${stamp(started)}-${task.name}`;
  const logDir = expand(task.log_dir ?? join("~", "graph-memory", "logs", "dream-runner"));
  const logPath = join(logDir, `${runId}.log`);
  const log = makeLogger(logPath);
  const model = task.model ?? "claude-sonnet-5-5";
  const effort = task.effort ?? "medium";
  const maxCost = task.max_cost_usd ?? 1;
  const usage: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const send = deps.send !== undefined ? deps.send : task.email ? notifySender({ url: task.email.url, tokenFile: expand(task.email.token_file) }) : null;
  const maxEmails = task.email?.max_per_run ?? 2;
  let emails = 0;
  let outcome: TaskOutcome = "error";
  let turns = 0;
  const servers: Client[] = [];

  try {
    const client = deps.anthropic ?? new Anthropic({ apiKey: resolveApiKey(), maxRetries: 4 });
    const mcpTools = new Map<string, Client>();
    const tools: Anthropic.Beta.BetaTool[] = [...FILE_TOOLS, ...(task.commands ?? []).map(commandTool)];
    if (task.http?.length) tools.push(HTTP_TOOL);
    if (send) tools.push(EMAIL_TOOL);
    for (const spec of task.mcp_servers ?? []) {
      try {
        const { client: c, tools: ts } = await connectMcp(spec);
        servers.push(c);
        for (const t of ts) { mcpTools.set(t.name, c); tools.push(t); }
      } catch (err) {
        log(`mcp server ${spec.name} unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const commands = new Map((task.commands ?? []).map((c) => [c.name, c]));
    log(`task=${task.name} model=${model} effort=${effort} tools=${tools.length} budget=$${maxCost}`);

    const system = buildTaskPrompt(task, tools.map((t) => t.name));
    const local = started.toLocaleString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: `Run the scheduled task "${task.name}" now. It is ${local}.` }];
    const betas: Anthropic.Beta.AnthropicBeta[] = ["context-management-2025-06-27"];
    const fallbacks = FALLBACK_MODELS.has(model);
    if (fallbacks) betas.push("server-side-fallback-2026-07-01");

    let wrapUpSent = false;
    let turnLimit = task.max_turns ?? 60;
    while (turns < turnLimit) {
      turns++;
      const response = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        betas,
        ...(fallbacks ? { fallbacks: "default" as const } : {}),
        output_config: { effort },
        cache_control: { type: "ephemeral" },
        context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
        system,
        tools,
        messages,
      });
      usage.input += response.usage.input_tokens;
      usage.output += response.usage.output_tokens;
      usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
      usage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0;
      const cost = estimateCostUsd(model, usage);
      messages.push({ role: "assistant", content: response.content });
      const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      log(`turn ${turns}: stop=${response.stop_reason} tools=[${toolUses.map((t) => t.name).join(", ")}] cost~$${cost.toFixed(3)}`);

      if (response.stop_reason === "refusal") { outcome = "refused"; break; }
      if (response.stop_reason === "pause_turn") continue;
      if (response.stop_reason === "max_tokens" && toolUses.length === 0) {
        messages.push({ role: "user", content: "Your last reply was cut off at the output limit. Continue from where it stopped." });
        continue;
      }
      if (toolUses.length === 0) {
        const text = response.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join(" ").trim();
        if (text) log(`summary: ${text.replace(/\s+/g, " ")}`);
        outcome = wrapUpSent ? "budget_stopped" : "completed";
        break;
      }
      if (cost >= maxCost * 1.5) { log(`estimated cost passed 1.5x the $${maxCost} budget; stopping`); outcome = "budget_stopped"; break; }

      const results: Anthropic.Beta.BetaContentBlockParam[] = [];
      for (const use of toolUses) {
        const input = (use.input ?? {}) as Record<string, unknown>;
        let text: string;
        let isError = false;
        try {
          if (FILE_TOOLS.some((t) => t.name === use.name)) text = runFileTool(use.name, input, task);
          else if (commands.has(use.name)) text = await runCommand(commands.get(use.name)!, input, task);
          else if (use.name === "http_request") text = await httpRequest(task, input);
          else if (use.name === "send_email" && send) {
            if (emails >= maxEmails) throw new Error(`this run has already sent ${maxEmails} emails; no more`);
            await send({ subject: String(input.subject ?? ""), text: String(input.body ?? ""), html: input.html === true });
            emails++;
            log(`emailed: ${String(input.subject ?? "")}`);
            text = "sent";
          } else if (mcpTools.has(use.name)) {
            const r = await mcpTools.get(use.name)!.callTool({ name: use.name, arguments: input });
            text = mcpResultText(r);
            isError = r.isError === true;
          } else throw new Error(`${use.name} isn't available to this task`);
        } catch (err) {
          text = err instanceof Error ? err.message : String(err);
          isError = true;
        }
        if (text.length > MAX_RESULT_CHARS) text = text.slice(0, MAX_RESULT_CHARS) + `\n[... cut at ${MAX_RESULT_CHARS} characters]`;
        results.push({ type: "tool_result", tool_use_id: use.id, content: text || "(empty)", ...(isError ? { is_error: true } : {}) });
      }
      if (!wrapUpSent && cost >= maxCost * 0.8) {
        wrapUpSent = true;
        turnLimit = turns + 10;
        log(`80% of the $${maxCost} budget used; asking the model to wrap up`);
        results.push({ type: "text", text: `Runner: this run's budget ($${maxCost}) is nearly spent. Write the output file with what you have, say what was skipped, and finish.` });
      }
      messages.push({ role: "user", content: results });
    }
    if (turns >= turnLimit && outcome === "error") outcome = "turn_limit";
  } catch (err) {
    log(`error: ${err instanceof Error ? err.message : String(err)}`);
    outcome = "error";
  } finally {
    for (const s of servers) { try { await s.close(); } catch { /* gone */ } }
    const cost = estimateCostUsd(model, usage);
    log(`done: ${outcome}, ${turns} turns, ~$${cost.toFixed(3)}`);
    try {
      appendFileSync(join(logDir, "runs.jsonl"), JSON.stringify({
        job: task.name, run_id: runId, started: started.toISOString(), finished: new Date().toISOString(),
        outcome, model, turns, usage, estimated_cost_usd: Number(cost.toFixed(4)),
      }) + "\n");
    } catch { /* best-effort */ }
  }

  const costUsd = estimateCostUsd(model, usage);
  // Tell someone when the task itself didn't finish; its own emails cover the rest.
  if (outcome !== "completed" && send) {
    let tail = "";
    try { tail = readFileSync(logPath, "utf-8").split("\n").slice(-40).join("\n"); } catch { /* no log */ }
    try {
      await send({
        subject: `${task.name} run ${outcome} — ${stamp(started).slice(0, 10)}`,
        text: `The scheduled task ${task.name} ended with outcome ${outcome} (~$${costUsd.toFixed(2)}, ${turns} turns, ${model}).\n\nLog: ${logPath}\n\n${tail}\n`,
      });
      log("emailed: failure alert");
    } catch (err) {
      log(`email failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { outcome, costUsd, turns, logPath };
}

// ─── Entry ───

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const path = process.argv[2];
  if (!path) throw new Error("usage: node dist/dream-runner/task.js <task.json>");
  const { outcome } = await runTask(loadTask(path));
  process.exit(outcome === "error" || outcome === "refused" ? 1 : 0);
}
