import { readFileSync } from "node:fs";

// ─── Canonical internal types ─────────────────────────────────────────────────
// This module is the single source of truth for the Claude Code JSONL transcript
// format. If Anthropic changes the format, update here — not in prompts or hooks.

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id?: string;
  name?: string;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id?: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking?: string;
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | { type: string };

export interface TranscriptMessage {
  role: "user" | "assistant" | "system";
  content: ContentBlock[];
  timestamp: string;
  sessionId: string;
  cwd: string;
  uuid: string;
  parentUuid?: string;
  model?: string;
  /** Plain text joined from all "text" content blocks */
  textContent: string;
}

export interface ParseResult {
  messages: TranscriptMessage[];
  sessionId: string | null;
  cwd: string | null;
  /** "v1" = known Claude Code JSONL format; "unknown" = unrecognized structure */
  formatVersion: "v1" | "unknown";
  lineCount: number;
  warnings: string[];
}

// ─── Internals ────────────────────────────────────────────────────────────────

// Record types that carry a message payload. All others are silently skipped.
const MESSAGE_TYPES = new Set(["user", "assistant", "system"]);

// Non-message record types known to appear in Claude Code transcripts.
// These are skipped without a warning — they're structural metadata, not messages.
const KNOWN_NON_MESSAGE_TYPES = new Set([
  "queue-operation",
  "attachment",
  "last-prompt",
]);

function extractText(content: ContentBlock[]): string {
  return content
    .filter((b): b is TextBlock => b.type === "text" && typeof (b as TextBlock).text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function detectFormatVersion(sample: unknown[]): "v1" | "unknown" {
  for (const line of sample) {
    if (
      line &&
      typeof line === "object" &&
      "type" in line &&
      "message" in line &&
      "sessionId" in line
    ) {
      return "v1";
    }
  }
  return "unknown";
}

function normalizeContent(rawContent: unknown): ContentBlock[] {
  if (Array.isArray(rawContent)) {
    return rawContent.map((b) => {
      if (b && typeof b === "object" && "type" in (b as object)) return b as ContentBlock;
      if (typeof b === "string") return { type: "text" as const, text: b };
      return { type: "unknown" } as ContentBlock;
    });
  }
  if (typeof rawContent === "string") {
    return [{ type: "text" as const, text: rawContent }];
  }
  return [];
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function parseTranscriptFile(filePath: string): ParseResult {
  const warnings: string[] = [];
  const messages: TranscriptMessage[] = [];
  let sessionId: string | null = null;
  let cwd: string | null = null;

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    return {
      messages: [],
      sessionId: null,
      cwd: null,
      formatVersion: "unknown",
      lineCount: 0,
      warnings: [`Failed to read file: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const lineCount = lines.length;

  const sample: unknown[] = [];
  for (const line of lines.slice(0, 5)) {
    try { sample.push(JSON.parse(line)); } catch { /* skip */ }
  }
  const formatVersion = detectFormatVersion(sample);

  if (formatVersion === "unknown") {
    warnings.push(
      "Unrecognized transcript format — expected fields type/message/sessionId not found. " +
      "The Claude Code JSONL format may have changed; update transcript-parser.ts.",
    );
  }

  for (let i = 0; i < lines.length; i++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      warnings.push(`Line ${i + 1}: invalid JSON, skipped`);
      continue;
    }

    if (!parsed || typeof parsed !== "object") {
      warnings.push(`Line ${i + 1}: not an object, skipped`);
      continue;
    }

    const obj = parsed as Record<string, unknown>;

    if (!("type" in obj)) {
      warnings.push(`Line ${i + 1}: missing "type" field, skipped`);
      continue;
    }

    const type = obj["type"] as string;

    // Skip known non-message record types silently
    if (KNOWN_NON_MESSAGE_TYPES.has(type)) continue;

    // Skip unknown record types without warning — future format additions shouldn't be noisy
    if (!MESSAGE_TYPES.has(type)) continue;

    const msg = obj["message"] as Record<string, unknown> | undefined;
    // system records may be structural metadata (e.g. stop_hook_summary) with no message payload
    if (!msg || typeof msg !== "object") continue;

    const role = (msg["role"] as string) || type;
    if (!MESSAGE_TYPES.has(role)) continue;

    const content = normalizeContent(msg["content"] ?? []);
    const sid = (obj["sessionId"] as string) ?? "";
    const cwdVal = (obj["cwd"] as string) ?? "";

    if (!sessionId && sid) sessionId = sid;
    if (!cwd && cwdVal) cwd = cwdVal;

    messages.push({
      role: role as "user" | "assistant" | "system",
      content,
      timestamp: (obj["timestamp"] as string) ?? "",
      sessionId: sid,
      cwd: cwdVal,
      uuid: (obj["uuid"] as string) ?? "",
      parentUuid: obj["parentUuid"] as string | undefined,
      model: obj["model"] as string | undefined,
      textContent: extractText(content),
    });
  }

  return { messages, sessionId, cwd, formatVersion, lineCount, warnings };
}

/** Returns only messages that have extractable text content (skips pure tool calls). */
export function getTextMessages(result: ParseResult): TranscriptMessage[] {
  return result.messages.filter((m) => m.textContent.length > 0);
}
