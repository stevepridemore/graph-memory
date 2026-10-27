import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "task-runner-"));
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.GRAPH_MEMORY_HOME = join(root, "graph-memory");

const { resolveTaskPath, commandArgv, matchHttp, buildTaskPrompt, runTask, loadTask } = await import("./task.js");

const work = join(root, "work");
mkdirSync(join(work, "ads", "audits"), { recursive: true });
mkdirSync(join(root, "outside"), { recursive: true });
writeFileSync(join(work, "ads", "README.md"), "status: ok\n");
writeFileSync(join(work, "SKILL.md"), "---\nname: t\n---\n\nCheck things and write ads/audits/today.md.\n");

const task = {
  name: "test-task",
  prompt_file: join(work, "SKILL.md"),
  workdir: work,
  write_paths: ["ads/audits"],
  log_dir: join(root, "logs"),
  commands: [
    {
      name: "echo_query",
      description: "Echo a query",
      exe: process.execPath,
      args: ["-e", "console.log('got ' + process.argv.at(-1))"],
      arg: { name: "gaql", description: "A SELECT", pattern: "^\\s*SELECT\\b" },
      flags: ["--raw"],
    },
  ],
  http: [{ prefix: "https://api.example.com/graphql", methods: ["POST"], bearer_file: "~/token" }],
};

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("task runner", () => {
  it("confines reads to the folder and writes to write_paths", () => {
    expect(resolveTaskPath("ads/README.md", task, "read")).toContain("README.md");
    expect(resolveTaskPath("ads/audits/x.md", task, "write")).toContain("audits");
    expect(() => resolveTaskPath("ads/README.md", task, "write")).toThrow(/read-only/);
    expect(() => resolveTaskPath("../outside/x", task, "read")).toThrow(/outside/);
    symlinkSync(join(root, "outside"), join(work, "ads", "audits", "escape"));
    expect(() => resolveTaskPath("ads/audits/escape/x", task, "write")).toThrow(/outside/);
  });

  it("checks the command argument and flags", () => {
    const c = task.commands[0];
    expect(commandArgv(c, { gaql: "SELECT a FROM b", flags: ["--raw"] }).slice(-2)).toEqual(["--raw", "SELECT a FROM b"]);
    expect(() => commandArgv(c, { gaql: "DROP x" })).toThrow(/pattern/);
    expect(() => commandArgv(c, { gaql: "SELECT a", flags: ["--mutate"] })).toThrow(/isn't allowed/);
  });

  it("allows only listed URL prefixes and methods", () => {
    expect(matchHttp(task, "POST", "https://api.example.com/graphql").prefix).toBe("https://api.example.com/graphql");
    expect(() => matchHttp(task, "GET", "https://api.example.com/graphql")).toThrow(/GET isn't allowed/);
    expect(() => matchHttp(task, "POST", "https://evil.example.com/")).toThrow(/isn't an allowed URL/);
    expect(() => matchHttp(task, "POST", "https://u:p@api.example.com/graphql")).toThrow(/credentials/);
  });

  it("strips frontmatter and appends the runner notes", () => {
    const p = buildTaskPrompt({ ...task, notes: "Use echo_query for ads-query.py." }, ["read_file", "echo_query"]);
    expect(p.startsWith("Check things")).toBe(true);
    expect(p).toContain("Your tools are: read_file, echo_query");
    expect(p).toContain("Use echo_query for ads-query.py.");
  });

  it("runs the loop: a command, a file write, an email, then done", async () => {
    const script = [
      [{ type: "tool_use", id: "t1", name: "echo_query", input: { gaql: "SELECT x FROM y" } }],
      [
        { type: "tool_use", id: "t2", name: "write_file", input: { path: "ads/audits/today.md", content: "# report" } },
        { type: "tool_use", id: "t3", name: "send_email", input: { subject: "[Site] test", body: "<p>hi</p>", html: true } },
        { type: "tool_use", id: "t4", name: "write_file", input: { path: "ads/README.md", content: "nope" } },
      ],
      [{ type: "text", text: "All clear. Report written, one email sent." }],
    ];
    const seen: unknown[][] = [];
    let i = 0;
    const anthropic = {
      beta: {
        messages: {
          create: async (req: { messages: unknown[] }) => {
            seen.push(structuredClone(req.messages));
            const content = script[i++];
            return {
              content,
              stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
              usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            };
          },
        },
      },
    };
    const sent: Array<{ subject: string; html?: boolean }> = [];
    const result = await runTask(task, { anthropic: anthropic as never, send: async (m) => { sent.push(m); } });

    expect(result.outcome).toBe("completed");
    expect(readFileSync(join(work, "ads", "audits", "today.md"), "utf-8")).toBe("# report");
    expect(readFileSync(join(work, "ads", "README.md"), "utf-8")).toBe("status: ok\n");
    expect(sent).toEqual([{ subject: "[Site] test", text: "<p>hi</p>", html: true }]);
    const turn2 = JSON.stringify(seen[1]);
    expect(turn2).toContain("got SELECT x FROM y");
    const turn3 = JSON.stringify(seen[2]);
    expect(turn3).toContain("read-only");
    const runs = readFileSync(join(root, "logs", "runs.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(runs.at(-1)).toMatchObject({ job: "test-task", outcome: "completed", model: "claude-sonnet-5-5" });
  });

  it("alerts by email when the run fails", async () => {
    const anthropic = { beta: { messages: { create: async () => { throw new Error("401 invalid x-api-key"); } } } };
    const sent: Array<{ subject: string }> = [];
    const result = await runTask(task, { anthropic: anthropic as never, send: async (m) => { sent.push(m); } });
    expect(result.outcome).toBe("error");
    expect(sent[0].subject).toMatch(/^test-task run error/);
  });

  it("validates the task file", () => {
    const path = join(root, "bad.json");
    writeFileSync(path, JSON.stringify({ name: "Bad Name", prompt_file: "x", workdir: "y" }));
    expect(() => loadTask(path)).toThrow(/kebab-case/);
  });
});
