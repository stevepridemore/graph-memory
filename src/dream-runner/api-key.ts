import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolve the Anthropic API key for the dream runner.
 *
 * Order: ANTHROPIC_API_KEY, then the file named by ANTHROPIC_API_KEY_FILE.
 * The file may hold the key on its own or as an `ANTHROPIC_API_KEY=...` line,
 * and the path may be a folder holding exactly one file (Docker mounts a host
 * folder as a folder, so either shape on the host works).
 *
 * The key is never logged. Errors name the path, never the contents.
 */
export function resolveApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const direct = env.ANTHROPIC_API_KEY?.trim();
  if (direct) return direct;

  const keyPath = env.ANTHROPIC_API_KEY_FILE?.trim();
  if (!keyPath) {
    throw new Error("No API key: set ANTHROPIC_API_KEY or ANTHROPIC_API_KEY_FILE");
  }

  let filePath = keyPath;
  let st;
  try {
    st = statSync(keyPath);
  } catch {
    throw new Error(`ANTHROPIC_API_KEY_FILE does not exist: ${keyPath}`);
  }
  if (st.isDirectory()) {
    const files = readdirSync(keyPath, { withFileTypes: true }).filter(
      (e) => e.isFile() && !e.name.startsWith("."),
    );
    if (files.length !== 1) {
      throw new Error(
        `ANTHROPIC_API_KEY_FILE is a folder with ${files.length} files; point it at the key file itself: ${keyPath}`,
      );
    }
    filePath = join(keyPath, files[0].name);
  }

  const key = parseKeyFile(readFileSync(filePath, "utf-8"));
  if (!key) throw new Error(`No API key found in ${filePath}`);
  return key;
}

/** Accepts a bare key, or KEY=value lines (first ANTHROPIC_API_KEY wins). */
export function parseKeyFile(raw: string): string | null {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  for (const line of lines) {
    const m = /^(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*(.+)$/.exec(line);
    if (m) return stripQuotes(m[1].trim());
  }
  if (lines.length === 1 && !lines[0].includes("=")) return stripQuotes(lines[0]);
  return null;
}

function stripQuotes(s: string): string {
  return s.replace(/^(['"])(.*)\1$/, "$2");
}
