import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Cheap, model-free version of the dream prompt's Step 3. The runner calls
// this before it spends any API tokens, so a night with nothing new costs
// nothing. It errs towards "pending": the model makes the final call.

interface ManifestEntry {
  processed_at?: string;
  file_size_bytes?: number;
}

interface Manifest {
  processed?: Record<string, ManifestEntry>;
}

// Ingest formats the model can read as text. Binary formats need MarkItDown,
// which the runner doesn't have, so they don't count as pending work here:
// otherwise one PDF in pending/ would trigger a paid run every night.
export const TEXT_INGEST_EXTENSIONS = [".md", ".txt", ".srt", ".vtt", ".json", ".html"];

export interface PendingWork {
  newTranscripts: number;
  grownTranscripts: number;
  ingestFiles: number;
}

export function totalPending(p: PendingWork): number {
  return p.newTranscripts + p.grownTranscripts + p.ingestFiles;
}

export function loadManifest(graphHome: string): Manifest {
  try {
    const raw = readFileSync(join(graphHome, "processed", "manifest.json"), "utf-8");
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as Manifest;
  } catch {
    return {};
  }
}

export function findPendingWork(graphHome: string, projectsDir: string): PendingWork {
  const processed = loadManifest(graphHome).processed ?? {};
  const result: PendingWork = { newTranscripts: 0, grownTranscripts: 0, ingestFiles: 0 };

  let projectDirs: string[] = [];
  try {
    projectDirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(projectsDir, d.name));
  } catch { /* no projects dir */ }

  for (const dir of projectDirs) {
    let files: string[] = [];
    try { files = readdirSync(dir); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith(".jsonl") || file.startsWith("agent-")) continue;
      const entry = processed[file.slice(0, -".jsonl".length)];
      if (!entry) {
        result.newTranscripts++;
        continue;
      }
      try {
        const st = statSync(join(dir, file));
        const grewBySize = entry.file_size_bytes !== undefined && st.size > entry.file_size_bytes;
        const grewByTime =
          entry.file_size_bytes === undefined &&
          entry.processed_at !== undefined &&
          st.mtimeMs > Date.parse(entry.processed_at);
        if (grewBySize || grewByTime) result.grownTranscripts++;
      } catch { /* vanished between readdir and stat */ }
    }
  }

  try {
    result.ingestFiles = readdirSync(join(graphHome, "ingest", "pending"), { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.endsWith(".meta.json"))
      .filter((e) => TEXT_INGEST_EXTENSIONS.some((ext) => e.name.toLowerCase().endsWith(ext)))
      .length;
  } catch { /* no pending dir */ }

  return result;
}
