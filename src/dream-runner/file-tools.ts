import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type Anthropic from "@anthropic-ai/sdk";

// The handful of file operations the dream prompt needs (manifest, changelog,
// ingest folder moves), confined to two roots. The graph-memory data root is
// read-write; the Claude Code transcripts folder is read-only. There is no
// shell tool: the dream doesn't need one, and the model's input is untrusted.

export interface FileRoots {
  /** Read-write. The prompt calls it ~/graph-memory. */
  graphHome: string;
  /** Read-only. The prompt calls it ~/.claude/projects. */
  projectsDir: string;
}

export class FileToolError extends Error {}

const DEFAULT_READ_LIMIT = 100_000;

export const FILE_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "list_dir",
    description:
      "List a directory. Returns one entry per line: type, size in bytes, modified time (ISO), name. " +
      "Paths may start with ~/ (e.g. ~/graph-memory/ingest/pending, ~/.claude/projects).",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean", description: "Walk subfolders too (max depth 3). Default false." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "stat_file",
    description:
      "Size in bytes, modified time and, for text files, line count. Use it for manifest watermarks.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description:
      `Read a UTF-8 text file. Returns up to 'limit' characters (default ${DEFAULT_READ_LIMIT}) ` +
      "starting at character 'offset', with a header saying the total length so you can read on.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1 },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a text file under ~/graph-memory. Parent folders are created.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "move_file",
    description: "Move or rename a file within ~/graph-memory. Parent folders of the target are created.",
    input_schema: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_file",
    description: "Delete one file under ~/graph-memory. Folders can't be deleted.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
];

export const FILE_TOOL_NAMES = new Set(FILE_TOOLS.map((t) => t.name));

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Resolve the deepest existing ancestor through symlinks, keep the rest. */
function realish(p: string): string {
  let existing = p;
  const tail: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    tail.unshift(existing.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    existing = parent;
  }
  try {
    return join(realpathSync(existing), ...tail);
  } catch {
    return p;
  }
}

/**
 * Map a model-supplied path onto disk and check it against the roots.
 * `~/graph-memory` and `~/.claude/projects` are aliases for the configured
 * roots, so the prompt's paths work wherever the data actually lives.
 */
export function resolvePath(raw: string, roots: FileRoots, mode: "read" | "write"): string {
  if (typeof raw !== "string" || raw.trim() === "") throw new FileToolError("path is required");
  let p = raw.trim().replace(/\\/g, "/");
  const aliases: Array<[string, string]> = [
    ["~/graph-memory", roots.graphHome],
    ["~/.claude/projects", roots.projectsDir],
  ];
  let mapped: string | null = null;
  for (const [alias, target] of aliases) {
    if (p === alias || p.startsWith(alias + "/")) {
      mapped = join(target, p.slice(alias.length));
      break;
    }
  }
  if (mapped === null) {
    if (p === "~" || p.startsWith("~/")) p = join(homedir(), p.slice(1));
    mapped = resolve(p);
  }

  const real = realish(resolve(mapped));
  const home = realish(resolve(roots.graphHome));
  const projects = realish(resolve(roots.projectsDir));
  if (isInside(real, home)) {
    if (mode === "write" && real === join(home, "processed", "dream.lock")) {
      throw new FileToolError("the runner holds dream.lock and releases it itself");
    }
    return real;
  }
  if (isInside(real, projects)) {
    if (mode === "write") throw new FileToolError(`read-only location: ${raw}`);
    return real;
  }
  throw new FileToolError(`outside the allowed folders (~/graph-memory, ~/.claude/projects): ${raw}`);
}

function countLines(path: string): number {
  const buf = readFileSync(path);
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
  if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) n++;
  return n;
}

function listDir(dir: string, recursive: boolean, depth: number, prefix: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, e.name);
    const name = prefix + e.name;
    try {
      const st = statSync(full);
      const type = st.isDirectory() ? "dir " : "file";
      out.push(`${type}\t${st.isDirectory() ? "-" : st.size}\t${st.mtime.toISOString()}\t${name}`);
      if (recursive && st.isDirectory() && depth < 3) listDir(full, true, depth + 1, name + "/", out);
    } catch {
      out.push(`?\t-\t-\t${name}`);
    }
    if (out.length >= 5000) {
      out.push("… listing stopped at 5000 entries");
      return;
    }
  }
}

export function runFileTool(name: string, input: Record<string, unknown>, roots: FileRoots): string {
  switch (name) {
    case "list_dir": {
      const dir = resolvePath(String(input.path ?? ""), roots, "read");
      if (!existsSync(dir)) return `(does not exist) ${input.path}`;
      const out: string[] = [];
      listDir(dir, input.recursive === true, 1, "", out);
      return out.length ? out.join("\n") : "(empty)";
    }
    case "stat_file": {
      const p = resolvePath(String(input.path ?? ""), roots, "read");
      if (!existsSync(p)) return JSON.stringify({ exists: false });
      const st = statSync(p);
      return JSON.stringify({
        exists: true,
        type: st.isDirectory() ? "dir" : "file",
        size_bytes: st.size,
        modified: st.mtime.toISOString(),
        ...(st.isFile() ? { line_count: countLines(p) } : {}),
      });
    }
    case "read_file": {
      const p = resolvePath(String(input.path ?? ""), roots, "read");
      const text = readFileSync(p, "utf-8");
      const offset = Number.isInteger(input.offset) ? (input.offset as number) : 0;
      const limit = Number.isInteger(input.limit) ? (input.limit as number) : DEFAULT_READ_LIMIT;
      const slice = text.slice(offset, offset + limit);
      const end = offset + slice.length;
      const header =
        end < text.length || offset > 0
          ? `[characters ${offset}-${end} of ${text.length}${end < text.length ? `; read on with offset ${end}` : ""}]\n`
          : "";
      return header + slice;
    }
    case "write_file": {
      const p = resolvePath(String(input.path ?? ""), roots, "write");
      if (typeof input.content !== "string") throw new FileToolError("content must be a string");
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, input.content, "utf-8");
      return `wrote ${Buffer.byteLength(input.content)} bytes to ${input.path}`;
    }
    case "move_file": {
      const from = resolvePath(String(input.from ?? ""), roots, "write");
      const to = resolvePath(String(input.to ?? ""), roots, "write");
      if (!statSync(from).isFile()) throw new FileToolError("only files can be moved");
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
      return `moved ${input.from} -> ${input.to}`;
    }
    case "delete_file": {
      const p = resolvePath(String(input.path ?? ""), roots, "write");
      if (!statSync(p).isFile()) throw new FileToolError("only files can be deleted");
      unlinkSync(p);
      return `deleted ${input.path}`;
    }
    default:
      throw new FileToolError(`unknown file tool: ${name}`);
  }
}
