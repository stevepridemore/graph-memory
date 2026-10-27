import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { getTextMessages, parseTranscriptFile } from "../shared/transcript-parser.js";
import { loadManifest, manifestPath, type PendingTranscript } from "./pending.js";

// Two runner-side tools that replace the expensive parts of the prompt:
//
// read_transcript  — graph_read_transcript returns a whole session in one
//   result (a busy session runs to megabytes). This pages through the same
//   parser's output and applies the delta filter before anything reaches the
//   model.
// update_manifest  — the manifest grows with every session ever processed.
//   Rewriting it through write_file means reading and re-emitting all of it;
//   this merges one entry on disk instead.

export const TRANSCRIPT_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "read_transcript",
    description:
      "Read a pending transcript's text messages a page at a time, through the canonical transcript parser " +
      "(tool calls, tool results and thinking already stripped). Pass 'since' (the item's previous_processed_at) " +
      "for delta items so only new messages come back. Keep calling with next_offset until it is null.",
    input_schema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        since: { type: "string", description: "ISO timestamp; only messages after it are returned." },
        offset: { type: "integer", minimum: 0, description: "Index into the (filtered) message list. Default 0." },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  {
    name: "update_manifest",
    description:
      "Record a transcript as processed in ~/graph-memory/processed/manifest.json (Step 4h). The runner fills in " +
      "path, processed_at, file_size_bytes and line_count from when it read the file, and sets last_dream_run. " +
      "Call it once per transcript as soon as you finish it, including skipped or empty-delta ones.",
    input_schema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        entities_extracted: { type: "integer", minimum: 0 },
        edges_created: { type: "integer", minimum: 0 },
        note: { type: "string", description: "Optional, e.g. 'skipped: unknown format'." },
      },
      required: ["session_id", "entities_extracted", "edges_created"],
      additionalProperties: false,
    },
  },
];

export const TRANSCRIPT_TOOL_NAMES = new Set(TRANSCRIPT_TOOLS.map((t) => t.name));

interface ParsedSession {
  readAt: string;
  sizeBytes: number;
  lineCount: number;
  cwd: string | null;
  formatVersion: string;
  warnings: string[];
  messages: Array<{ role: string; timestamp: string; text: string }>;
}

export class TranscriptTools {
  private parsed = new Map<string, ParsedSession>();
  private recorded = new Map<string, { entities: number; edges: number }>();
  private items: Map<string, PendingTranscript>;

  constructor(
    items: PendingTranscript[],
    private graphHome: string,
    private pageChars = 60_000,
  ) {
    this.items = new Map(items.map((i) => [i.session_id, i]));
  }

  run(name: string, input: Record<string, unknown>): string {
    if (name === "read_transcript") return this.read(input);
    if (name === "update_manifest") return this.updateManifest(input);
    throw new Error(`unknown transcript tool: ${name}`);
  }

  private item(sessionId: unknown): PendingTranscript {
    const item = this.items.get(String(sessionId ?? ""));
    if (!item) throw new Error(`${String(sessionId)} is not in this run's pending list`);
    return item;
  }

  private parse(item: PendingTranscript): ParsedSession {
    const cached = this.parsed.get(item.session_id);
    if (cached) return cached;
    // Stat before parsing: anything appended after this point is newer than
    // the watermark and gets picked up next run.
    const readAt = new Date().toISOString();
    const st = statSync(item.diskPath);
    const result = parseTranscriptFile(item.diskPath);
    const session: ParsedSession = {
      readAt,
      sizeBytes: st.size,
      lineCount: result.lineCount,
      cwd: result.cwd,
      formatVersion: result.formatVersion,
      warnings: result.warnings,
      messages: getTextMessages(result).map((m) => ({ role: m.role, timestamp: m.timestamp, text: m.textContent })),
    };
    this.parsed.set(item.session_id, session);
    return session;
  }

  private read(input: Record<string, unknown>): string {
    const item = this.item(input.session_id);
    const s = this.parse(item);
    const since = typeof input.since === "string" && input.since ? Date.parse(input.since) : NaN;
    const all = Number.isNaN(since) ? s.messages : s.messages.filter((m) => Date.parse(m.timestamp) > since);
    const offset = Number.isInteger(input.offset) ? (input.offset as number) : 0;

    const page: Array<{ role: string; timestamp: string; text: string }> = [];
    let chars = 0;
    let i = offset;
    for (; i < all.length; i++) {
      let m = all[i];
      if (m.text.length > this.pageChars) {
        // One message bigger than a page (usually a pasted log): show the
        // start, say so, and move on rather than stall.
        m = { ...m, text: m.text.slice(0, this.pageChars) + `\n[message cut at ${this.pageChars} of ${m.text.length} characters]` };
      }
      if (page.length > 0 && chars + m.text.length > this.pageChars) break;
      page.push(m);
      chars += m.text.length;
    }

    return JSON.stringify({
      session_id: item.session_id,
      path: item.path,
      cwd: s.cwd,
      format_version: s.formatVersion,
      line_count: s.lineCount,
      warnings: s.warnings,
      text_message_count: s.messages.length,
      matching_messages: all.length,
      offset,
      next_offset: i < all.length ? i : null,
      messages: page,
    });
  }

  /** What update_manifest recorded this run, for the summary email. */
  stats(): { sessions: number; entities: number; edges: number } {
    let entities = 0;
    let edges = 0;
    for (const r of this.recorded.values()) {
      entities += r.entities;
      edges += r.edges;
    }
    return { sessions: this.recorded.size, entities, edges };
  }

  private updateManifest(input: Record<string, unknown>): string {
    const item = this.item(input.session_id);
    let watermark: { readAt: string; sizeBytes: number; lineCount: number };
    const s = this.parsed.get(item.session_id);
    if (s) {
      watermark = s;
    } else {
      // Skipped without reading: record the size seen at discovery.
      watermark = { readAt: new Date().toISOString(), sizeBytes: item.size_bytes, lineCount: countLines(item.diskPath) };
    }

    const manifest = loadManifest(this.graphHome);
    const processed = manifest.processed ?? {};
    const now = new Date().toISOString();
    processed[item.session_id] = {
      ...processed[item.session_id],
      path: item.path,
      processed_at: watermark.readAt,
      file_size_bytes: watermark.sizeBytes,
      line_count: watermark.lineCount,
      entities_extracted: Number(input.entities_extracted ?? 0),
      edges_created: Number(input.edges_created ?? 0),
      ...(typeof input.note === "string" && input.note ? { note: input.note } : {}),
    } as (typeof processed)[string];
    manifest.processed = processed;
    manifest.last_dream_run = now;

    const target = manifestPath(this.graphHome);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf-8");
    renameSync(tmp, target);
    this.recorded.set(item.session_id, {
      entities: Number(input.entities_extracted ?? 0),
      edges: Number(input.edges_created ?? 0),
    });
    return `manifest updated for ${item.session_id} (processed_at ${watermark.readAt}, ${watermark.sizeBytes} bytes)`;
  }
}

function countLines(path: string): number {
  try {
    const buf = readFileSync(path);
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
    if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) n++;
    return n;
  } catch {
    return 0;
  }
}
