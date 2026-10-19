import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Inline content queued over HTTP has to fit inside one MCP request body
// (READ_BODY_CAP_MCP, 4 MB), so cap it well below that.
export const MAX_INGEST_CONTENT_BYTES = 2 * 1024 * 1024;

// Source tag the cloud-session collector writes into .meta.json sidecars.
export const CLOUD_SESSION_SOURCE = "claude-code-cloud";

const ALLOWED_EXTENSIONS = [".md", ".txt", ".json"];

/**
 * Validate a caller-supplied file name for inline content. Returns the name
 * unchanged when it is a plain basename with an allowed extension, or throws.
 * Rejecting (rather than rewriting) keeps the caller's cursor math honest:
 * the name it sent is the name status reports back.
 */
export function validateIngestName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/.test(name) || name.includes("..")) {
    throw new Error(
      `file_name must be a plain file name (letters, digits, '.', '_', '-'), got "${name}"`,
    );
  }
  const lower = name.toLowerCase();
  if (lower.endsWith(".meta.json") || !ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    throw new Error(`file_name must end in ${ALLOWED_EXTENSIONS.join(", ")} (and not .meta.json)`);
  }
  return name;
}

export interface SessionCursor {
  /** ISO timestamp of the newest event already queued for this session. */
  through: string;
  last_event_id?: string;
  file: string;
}

/**
 * Collect the high-water mark per cloud session across the pending and
 * completed ingest dirs, from the .meta.json sidecars the collector writes.
 * The collector reads this through graph_ingest status so it only queues
 * events newer than what is already queued or dreamed.
 */
export function readSessionCursors(dirs: string[]): Record<string, SessionCursor> {
  const cursors: Record<string, SessionCursor> = {};
  for (const dir of dirs) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".meta.json"));
    } catch {
      continue; // dir doesn't exist yet
    }
    for (const f of files) {
      let meta: Record<string, unknown>;
      try {
        meta = JSON.parse(readFileSync(join(dir, f), "utf-8"));
      } catch {
        continue;
      }
      if (meta.source !== CLOUD_SESSION_SOURCE) continue;
      const sessionId = meta.session_id;
      const through = meta.through;
      if (typeof sessionId !== "string" || typeof through !== "string") continue;
      if (Number.isNaN(Date.parse(through))) continue;
      const prev = cursors[sessionId];
      if (!prev || Date.parse(through) > Date.parse(prev.through)) {
        cursors[sessionId] = {
          through,
          last_event_id: typeof meta.last_event_id === "string" ? meta.last_event_id : undefined,
          file: f.slice(0, -".meta.json".length),
        };
      }
    }
  }
  return cursors;
}
