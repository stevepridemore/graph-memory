import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Model-free version of the dream prompt's Step 3. The runner does discovery
// itself and hands the model the exact list, so no tokens go on listing the
// projects folder or reading the (large) manifest, and a night with nothing
// new makes no API call at all.

interface ManifestEntry {
  processed_at?: string;
  file_size_bytes?: number;
  line_count?: number;
}

export interface Manifest {
  last_dream_run?: string | null;
  processed?: Record<string, ManifestEntry>;
  [key: string]: unknown;
}

// Ingest formats the model can read as text. Binary formats need MarkItDown,
// which the runner doesn't have, so they don't count as pending work here:
// otherwise one PDF in pending/ would trigger a paid run every night.
export const TEXT_INGEST_EXTENSIONS = [".md", ".txt", ".srt", ".vtt", ".json", ".html"];

export interface PendingTranscript {
  session_id: string;
  /** In the prompt's form, ~/.claude/projects/<dir>/<file>. */
  path: string;
  /** On disk, for the runner's own use. */
  diskPath: string;
  size_bytes: number;
  modified: string;
  mode: "new" | "delta";
  /** Delta only: extract messages newer than this. */
  previous_processed_at?: string;
}

export interface PendingWork {
  newTranscripts: number;
  grownTranscripts: number;
  ingestFiles: number;
  /** Oldest first. */
  transcripts: PendingTranscript[];
  ingest: string[];
  /** Session ids left for next time because they changed in the last few minutes. */
  skippedActive: string[];
}

export function totalPending(p: PendingWork): number {
  return p.newTranscripts + p.grownTranscripts + p.ingestFiles;
}

export function manifestPath(graphHome: string): string {
  return join(graphHome, "processed", "manifest.json");
}

export function loadManifest(graphHome: string): Manifest {
  try {
    const raw = readFileSync(manifestPath(graphHome), "utf-8");
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as Manifest;
  } catch {
    return {};
  }
}

export function findPendingWork(
  graphHome: string,
  projectsDir: string,
  opts: { activeMinutes?: number; now?: number } = {},
): PendingWork {
  const processed = loadManifest(graphHome).processed ?? {};
  const now = opts.now ?? Date.now();
  const activeMs = (opts.activeMinutes ?? 0) * 60_000;
  const result: PendingWork = {
    newTranscripts: 0,
    grownTranscripts: 0,
    ingestFiles: 0,
    transcripts: [],
    ingest: [],
    skippedActive: [],
  };

  let projectDirs: string[] = [];
  try {
    projectDirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch { /* no projects dir */ }

  for (const dirName of projectDirs) {
    let files: string[] = [];
    try { files = readdirSync(join(projectsDir, dirName)); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith(".jsonl") || file.startsWith("agent-")) continue;
      const sessionId = file.slice(0, -".jsonl".length);
      const diskPath = join(projectsDir, dirName, file);
      let st;
      try { st = statSync(diskPath); } catch { continue; }

      const entry = processed[sessionId];
      let mode: PendingTranscript["mode"] | null = null;
      if (!entry) {
        mode = "new";
      } else {
        const grewBySize = entry.file_size_bytes !== undefined && st.size > entry.file_size_bytes;
        const grewByTime =
          entry.file_size_bytes === undefined &&
          entry.processed_at !== undefined &&
          st.mtimeMs > Date.parse(entry.processed_at);
        if (grewBySize || grewByTime) mode = "delta";
      }
      if (!mode) continue;
      // A session still being written (this one, a live Remote Control
      // session) is picked up next time, once it's settled.
      if (activeMs > 0 && now - st.mtimeMs < activeMs) {
        result.skippedActive.push(sessionId);
        continue;
      }

      result.transcripts.push({
        session_id: sessionId,
        path: `~/.claude/projects/${dirName}/${file}`,
        diskPath,
        size_bytes: st.size,
        modified: st.mtime.toISOString(),
        mode,
        ...(mode === "delta" && entry?.processed_at ? { previous_processed_at: entry.processed_at } : {}),
      });
      if (mode === "new") result.newTranscripts++;
      else result.grownTranscripts++;
    }
  }
  result.transcripts.sort((a, b) => Date.parse(a.modified) - Date.parse(b.modified));

  try {
    result.ingest = readdirSync(join(graphHome, "ingest", "pending"), { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.endsWith(".meta.json"))
      .filter((e) => TEXT_INGEST_EXTENSIONS.some((ext) => e.name.toLowerCase().endsWith(ext)))
      .map((e) => e.name)
      .sort();
    result.ingestFiles = result.ingest.length;
  } catch { /* no pending dir */ }

  return result;
}
