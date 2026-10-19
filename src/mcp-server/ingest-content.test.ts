import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateIngestName, readSessionCursors, CLOUD_SESSION_SOURCE } from "./ingest-content.js";

describe("validateIngestName", () => {
  it("accepts plain names with allowed extensions", () => {
    expect(validateIngestName("cloud-session_01abc-20261019.md")).toBe("cloud-session_01abc-20261019.md");
    expect(validateIngestName("notes.txt")).toBe("notes.txt");
  });

  it.each([
    "../escape.md",
    "dir/file.md",
    "dir\\file.md",
    ".hidden.md",
    "file.md.meta.json",
    "script.sh",
    "",
    "a..b.md",
  ])("rejects %s", (name) => {
    expect(() => validateIngestName(name)).toThrow();
  });
});

describe("readSessionCursors", () => {
  let root: string;
  let pending: string;
  let completed: string;

  const meta = (dir: string, file: string, body: Record<string, unknown>) =>
    writeFileSync(join(dir, `${file}.meta.json`), JSON.stringify(body));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ingest-cursors-"));
    pending = join(root, "pending");
    completed = join(root, "completed");
    mkdirSync(pending);
    mkdirSync(completed);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("keeps the newest through per session across pending and completed", () => {
    meta(completed, "a1.md", { source: CLOUD_SESSION_SOURCE, session_id: "s1", through: "2026-10-18T01:00:00Z", last_event_id: "e1" });
    meta(pending, "a2.md", { source: CLOUD_SESSION_SOURCE, session_id: "s1", through: "2026-10-19T01:00:00Z", last_event_id: "e2" });
    meta(completed, "b1.md", { source: CLOUD_SESSION_SOURCE, session_id: "s2", through: "2026-10-17T00:00:00Z" });

    expect(readSessionCursors([pending, completed])).toEqual({
      s1: { through: "2026-10-19T01:00:00Z", last_event_id: "e2", file: "a2.md" },
      s2: { through: "2026-10-17T00:00:00Z", last_event_id: undefined, file: "b1.md" },
    });
  });

  it("ignores other sources, bad dates, and unreadable sidecars", () => {
    meta(completed, "yt.md", { source: "YouTube transcript", session_id: "s1", through: "2026-10-19T00:00:00Z" });
    meta(completed, "bad.md", { source: CLOUD_SESSION_SOURCE, session_id: "s1", through: "not a date" });
    writeFileSync(join(completed, "junk.md.meta.json"), "{not json");
    expect(readSessionCursors([pending, completed])).toEqual({});
  });

  it("tolerates missing dirs", () => {
    expect(readSessionCursors([join(root, "nope")])).toEqual({});
  });
});
