import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LOCK_PATH = join(
  homedir(),
  "graph-memory",
  "processed",
  "dream.lock",
);
const STALE_HOURS = 2;

interface LockInfo {
  pid: number;
  timestamp: string;
  source: string;
}

/**
 * Read the current lock file, if it exists.
 * Returns null if no lock or the file is unreadable.
 */
export function readLock(): LockInfo | null {
  try {
    const raw = readFileSync(LOCK_PATH, "utf-8");
    return JSON.parse(raw) as LockInfo;
  } catch {
    return null;
  }
}

/**
 * Returns true if a non-stale lock is currently held.
 */
export function isLocked(): boolean {
  const lock = readLock();
  if (!lock) return false;
  const ageMs = Date.now() - new Date(lock.timestamp).getTime();
  const staleMs = STALE_HOURS * 60 * 60 * 1000;
  return ageMs < staleMs;
}

/**
 * Attempt to acquire the dream lock.
 * Returns true if acquired, false if already held by a non-stale process.
 */
export function acquireLock(source: string): boolean {
  if (isLocked()) return false;
  const info: LockInfo = {
    pid: process.pid,
    timestamp: new Date().toISOString(),
    source,
  };
  writeFileSync(LOCK_PATH, JSON.stringify(info, null, 2), "utf-8");
  return true;
}

/**
 * Release the dream lock.
 */
export function releaseLock(): void {
  try {
    unlinkSync(LOCK_PATH);
  } catch {
    // Already gone — fine
  }
}

/**
 * Get a human-readable description of the current lock state.
 * Used by the check-pending hook.
 */
export function lockStatus(): string | null {
  const lock = readLock();
  if (!lock) return null;
  const ageMs = Date.now() - new Date(lock.timestamp).getTime();
  const staleMs = STALE_HOURS * 60 * 60 * 1000;
  if (ageMs >= staleMs) return null; // stale, treat as unlocked
  const mins = Math.round(ageMs / 60_000);
  return `Dream process running (${lock.source}, started ${mins} min ago)`;
}
