import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { lockStatus } from "../shared/dream-lock.js";
import { parseTranscriptFile } from "../shared/transcript-parser.js";

const GRAPH_MEMORY_HOME = join(homedir(), "graph-memory");
const PROJECTS_DIR = join(homedir(), ".claude", "projects");

interface Manifest {
  last_dream_run: string | null;
  processed: Record<string, unknown>;
}

function loadManifest(): Manifest {
  try {
    const raw = readFileSync(join(GRAPH_MEMORY_HOME, "processed", "manifest.json"), "utf-8");
    return JSON.parse(raw) as Manifest;
  } catch {
    return { last_dream_run: null, processed: {} };
  }
}

function loadConfig(): { cooldown_hours: number } {
  try {
    const raw = readFileSync(join(GRAPH_MEMORY_HOME, "config.json"), "utf-8");
    const config = JSON.parse(raw) as { dream?: { cooldown_hours?: number } };
    return { cooldown_hours: config.dream?.cooldown_hours ?? 4 };
  } catch {
    return { cooldown_hours: 4 };
  }
}

function countUnprocessedTranscripts(processedIds: Set<string>): { count: number; formatWarnings: string[] } {
  let count = 0;
  const formatWarnings: string[] = [];
  try {
    const projectDirs = readdirSync(PROJECTS_DIR, { withFileTypes: true });
    for (const dir of projectDirs) {
      if (!dir.isDirectory()) continue;
      const projectPath = join(PROJECTS_DIR, dir.name);
      try {
        const files = readdirSync(projectPath);
        for (const file of files) {
          if (!file.endsWith(".jsonl")) continue;
          if (file.startsWith("agent-")) continue;
          const sessionId = file.replace(".jsonl", "");
          if (processedIds.has(sessionId)) continue;
          count++;
          // Spot-check the first unprocessed file for format version changes
          if (count === 1) {
            const result = parseTranscriptFile(join(projectPath, file));
            if (result.formatVersion === "unknown") {
              formatWarnings.push(
                `[graph-memory] WARNING: Transcript format may have changed (${file}). ` +
                "Run /graph-dream to see details — the parser may need updating.",
              );
            }
          }
        }
      } catch { /* skip unreadable dirs */ }
    }
  } catch { /* projects dir doesn't exist */ }
  return { count, formatWarnings };
}

function countPendingIngest(): number {
  try {
    const pendingDir = join(GRAPH_MEMORY_HOME, "ingest", "pending");
    const files = readdirSync(pendingDir);
    return files.filter((f) => !f.endsWith(".meta.json")).length;
  } catch {
    return 0;
  }
}

function main() {
  const manifest = loadManifest();
  const config = loadConfig();

  const processedIds = new Set(Object.keys(manifest.processed));
  const { count: unprocessed, formatWarnings } = countUnprocessedTranscripts(processedIds);
  const pendingIngest = countPendingIngest();

  for (const w of formatWarnings) process.stdout.write(w + "\n");

  if (unprocessed === 0 && pendingIngest === 0) {
    process.exit(0);
  }

  // Check if dream is already running
  const lock = lockStatus();
  if (lock) {
    process.stdout.write(`[graph-memory] ${lock}\n`);
    process.exit(0);
  }

  // Check cooldown
  if (manifest.last_dream_run) {
    const lastRun = new Date(manifest.last_dream_run);
    const hoursSince = (Date.now() - lastRun.getTime()) / (1000 * 60 * 60);
    if (hoursSince < config.cooldown_hours) {
      process.exit(0);
    }
    const hoursAgo = Math.round(hoursSince);
    const parts: string[] = [];
    if (unprocessed > 0) parts.push(`${unprocessed} unprocessed transcript${unprocessed > 1 ? "s" : ""}`);
    if (pendingIngest > 0) parts.push(`${pendingIngest} pending ingest doc${pendingIngest > 1 ? "s" : ""}`);
    process.stdout.write(
      `[graph-memory] ${parts.join(", ")}. Last dream: ${hoursAgo} hour${hoursAgo !== 1 ? "s" : ""} ago. Run /graph-dream to process.\n`,
    );
  } else {
    const parts: string[] = [];
    if (unprocessed > 0) parts.push(`${unprocessed} unprocessed transcript${unprocessed > 1 ? "s" : ""}`);
    if (pendingIngest > 0) parts.push(`${pendingIngest} pending ingest doc${pendingIngest > 1 ? "s" : ""}`);
    process.stdout.write(
      `[graph-memory] ${parts.join(", ")}. No dream process has run yet. Run /graph-dream to process.\n`,
    );
  }
}

main();
