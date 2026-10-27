import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// dream-lock.ts and config.ts read HOME / GRAPH_MEMORY_HOME at import time,
// so point both at a scratch folder before importing anything under test.
const root = mkdtempSync(join(tmpdir(), "dream-runner-"));
const graphHome = join(root, "graph-memory");
const projectsDir = join(root, ".claude", "projects");
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.GRAPH_MEMORY_HOME = graphHome;

const { parseKeyFile, resolveApiKey } = await import("./api-key.js");
const { findPendingWork, totalPending } = await import("./pending.js");
const { resolvePath, runFileTool, FileToolError } = await import("./file-tools.js");
const { estimateCostUsd, nextRunAt, loadSettings, runDream } = await import("./index.js");

const roots = { graphHome, projectsDir };

beforeAll(() => {
  mkdirSync(join(graphHome, "processed"), { recursive: true });
  mkdirSync(join(graphHome, "ingest", "pending"), { recursive: true });
  mkdirSync(join(projectsDir, "proj-a"), { recursive: true });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("api key", () => {
  it("parses a bare key and an env-style line", () => {
    expect(parseKeyFile("sk-test-123\n")).toBe("sk-test-123");
    expect(parseKeyFile("﻿# comment\nANTHROPIC_API_KEY=\"sk-test-456\"\r\n")).toBe("sk-test-456");
    expect(parseKeyFile("OTHER=1\nFOO=2\n")).toBeNull();
  });

  it("prefers the env var, then the file, and accepts a folder with one file", () => {
    expect(resolveApiKey({ ANTHROPIC_API_KEY: "sk-env" })).toBe("sk-env");
    const keyDir = join(root, "claude-api-key");
    mkdirSync(keyDir);
    writeFileSync(join(keyDir, "key.txt"), "sk-from-folder\n");
    expect(resolveApiKey({ ANTHROPIC_API_KEY_FILE: keyDir })).toBe("sk-from-folder");
    expect(resolveApiKey({ ANTHROPIC_API_KEY_FILE: join(keyDir, "key.txt") })).toBe("sk-from-folder");
  });

  it("errors without leaking contents", () => {
    expect(() => resolveApiKey({})).toThrow(/ANTHROPIC_API_KEY_FILE/);
    const bad = join(root, "bad-key");
    writeFileSync(bad, "A=sk-secret\nB=2\n");
    expect(() => resolveApiKey({ ANTHROPIC_API_KEY_FILE: bad })).toThrow(/No API key found/);
    try { resolveApiKey({ ANTHROPIC_API_KEY_FILE: bad }); } catch (e) {
      expect(String(e)).not.toContain("sk-secret");
    }
  });
});

describe("pending work", () => {
  it("counts new and grown transcripts and text ingest files only", () => {
    writeFileSync(join(projectsDir, "proj-a", "s-new.jsonl"), "{}\n");
    writeFileSync(join(projectsDir, "proj-a", "s-old.jsonl"), "{}\n{}\n");
    writeFileSync(join(projectsDir, "proj-a", "s-same.jsonl"), "{}\n");
    writeFileSync(join(projectsDir, "proj-a", "agent-x.jsonl"), "{}\n");
    writeFileSync(
      join(graphHome, "processed", "manifest.json"),
      JSON.stringify({ processed: { "s-old": { file_size_bytes: 3 }, "s-same": { file_size_bytes: 3 } } }),
    );
    writeFileSync(join(graphHome, "ingest", "pending", "notes.md"), "hi");
    writeFileSync(join(graphHome, "ingest", "pending", "notes.md.meta.json"), "{}");
    writeFileSync(join(graphHome, "ingest", "pending", "scan.pdf"), "%PDF");

    const p = findPendingWork(graphHome, projectsDir);
    expect(p).toEqual({ newTranscripts: 1, grownTranscripts: 1, ingestFiles: 1 });
    expect(totalPending(p)).toBe(3);
  });
});

describe("file tools", () => {
  it("maps the prompt's ~ paths onto the roots", () => {
    expect(resolvePath("~/graph-memory/processed/manifest.json", roots, "read")).toBe(
      join(graphHome, "processed", "manifest.json"),
    );
    expect(resolvePath("~/.claude/projects/proj-a", roots, "read")).toBe(join(projectsDir, "proj-a"));
  });

  it("refuses paths outside the roots, writes to transcripts, and the lock", () => {
    expect(() => resolvePath("/etc/passwd", roots, "read")).toThrow(FileToolError);
    expect(() => resolvePath("~/graph-memory/../.ssh/id_rsa", roots, "read")).toThrow(FileToolError);
    expect(() => resolvePath("~/.claude/projects/proj-a/s-new.jsonl", roots, "write")).toThrow(/read-only/);
    expect(() => resolvePath("~/graph-memory/processed/dream.lock", roots, "write")).toThrow(/lock/);
  });

  it("refuses a symlink that escapes the root", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(graphHome, "escape"));
    expect(() => resolvePath("~/graph-memory/escape/x.txt", roots, "write")).toThrow(FileToolError);
  });

  it("writes, reads in pages, stats, moves and deletes", () => {
    const out = runFileTool("write_file", { path: "~/graph-memory/logs/test.md", content: "abcdef\nghi" }, roots);
    expect(out).toContain("wrote");
    expect(runFileTool("read_file", { path: "~/graph-memory/logs/test.md" }, roots)).toBe("abcdef\nghi");
    expect(runFileTool("read_file", { path: "~/graph-memory/logs/test.md", offset: 2, limit: 3 }, roots)).toBe(
      "[characters 2-5 of 10; read on with offset 5]\ncde",
    );
    expect(JSON.parse(runFileTool("stat_file", { path: "~/graph-memory/logs/test.md" }, roots))).toMatchObject({
      size_bytes: 10,
      line_count: 2,
    });
    runFileTool("move_file", { from: "~/graph-memory/logs/test.md", to: "~/graph-memory/ingest/completed/test.md" }, roots);
    expect(existsSync(join(graphHome, "ingest", "completed", "test.md"))).toBe(true);
    runFileTool("delete_file", { path: "~/graph-memory/ingest/completed/test.md" }, roots);
    expect(existsSync(join(graphHome, "ingest", "completed", "test.md"))).toBe(false);
  });
});

describe("schedule and cost", () => {
  it("picks today's slot if it's ahead, else tomorrow's", () => {
    const now = new Date(2026, 9, 27, 1, 0, 0);
    expect(nextRunAt("02:30", now)).toEqual(new Date(2026, 9, 27, 2, 30, 0));
    expect(nextRunAt("00:15", now)).toEqual(new Date(2026, 9, 28, 0, 15, 0));
    expect(() => nextRunAt("25:00", now)).toThrow();
  });

  it("estimates cost from usage", () => {
    const usage = { input: 1_000_000, output: 100_000, cacheRead: 1_000_000, cacheWrite: 0 };
    expect(estimateCostUsd("claude-opus-5-5", usage)).toBeCloseTo(4 + 2 + 0.2);
  });
});

describe("runDream loop", () => {
  it("runs tools until the model finishes, then releases the lock", async () => {
    // Fake model: one turn calls a graph tool and a file tool, the next ends.
    const calls: Array<Record<string, unknown>> = [];
    const replies = [
      {
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "t1", name: "graph_stats", input: {} },
          { type: "tool_use", id: "t2", name: "write_file", input: { path: "~/graph-memory/logs/run.md", content: "ok" } },
        ],
      },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] },
    ];
    const anthropic = {
      beta: {
        messages: {
          create: async (params: Record<string, unknown>) => {
            calls.push(structuredClone(params));
            const r = replies.shift()!;
            return { ...r, usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
          },
        },
      },
    };
    const mcpCalls: string[] = [];
    const fakeMcp = {
      listTools: async () => ({ tools: [{ name: "graph_stats", description: "stats", inputSchema: { type: "object" } }] }),
      callTool: async ({ name }: { name: string }) => {
        mcpCalls.push(name);
        return { content: [{ type: "text", text: "x".repeat(50) }] };
      },
      close: async () => {},
    };

    const settings = { ...loadSettings({}, []), maxToolResultChars: 20, roots };
    const outcome = await runDream(settings, {
      anthropic: anthropic as never,
      connect: async () => fakeMcp as never,
    });

    expect(outcome).toBe("completed");
    expect(mcpCalls).toEqual(["graph_stats"]);
    expect(readFileSync(join(graphHome, "logs", "run.md"), "utf-8")).toBe("ok");
    expect(existsSync(join(root, "graph-memory", "processed", "dream.lock"))).toBe(false);

    // Second request carried both tool results in one user message, and the
    // oversized one was spilled to a file with a pointer.
    const second = calls[1].messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const results = second[second.length - 1].content;
    expect(results.map((r) => r.tool_use_id)).toEqual(["t1", "t2"]);
    expect(String(results[0].content)).toMatch(/over the 20 limit/);
    expect(calls[0].fallbacks).toBe("default");
    expect(calls[0].model).toBe("claude-opus-5-5");
  });

  it("makes no API call when nothing is pending", async () => {
    rmSync(projectsDir, { recursive: true, force: true });
    rmSync(join(graphHome, "ingest", "pending"), { recursive: true, force: true });
    let called = false;
    const anthropic = { beta: { messages: { create: async () => { called = true; return {}; } } } };
    const outcome = await runDream({ ...loadSettings({}, []), roots }, { anthropic: anthropic as never });
    expect(outcome).toBe("nothing_pending");
    expect(called).toBe(false);
  });
});
