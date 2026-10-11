import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseTranscriptFile } from "./transcript-parser.js";

const dir = mkdtempSync(join(tmpdir(), "graph-memory-parser-test-"));

afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const SESSION = "00000000-0000-4000-8000-000000000001";

function metadata(type: string): Record<string, unknown> {
  return { type, sessionId: SESSION, timestamp: "2026-10-11T12:00:00.000Z" };
}

function message(role: "user" | "assistant", text: string): Record<string, unknown> {
  return {
    type: role,
    sessionId: SESSION,
    cwd: "C:\work",
    uuid: `${role}-${text}`,
    timestamp: "2026-10-11T12:00:01.000Z",
    message: { role, content: [{ type: "text", text }] },
  };
}

function write(name: string, records: Record<string, unknown>[]): string {
  const path = join(dir, name);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  return path;
}

const FORMAT_WARNING = "Unrecognized transcript format";

describe("parseTranscriptFile format detection", () => {
  it("recognizes a transcript that starts with a message", () => {
    const result = parseTranscriptFile(write("plain.jsonl", [
      message("user", "hello"),
      message("assistant", "hi"),
    ]));
    expect(result.formatVersion).toBe("v1");
    expect(result.messages).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });

  // Regression: real transcripts open with queue-operation and attachment
  // records, which pushed the first message to line 6. Detection only looked
  // at the first 5 lines, called the file "unknown", and the dream skipped it.
  it("recognizes a transcript whose first message follows five metadata records", () => {
    const result = parseTranscriptFile(write("leading-metadata.jsonl", [
      metadata("queue-operation"),
      metadata("queue-operation"),
      metadata("attachment"),
      metadata("attachment"),
      metadata("attachment"),
      message("user", "first real message"),
      message("assistant", "reply"),
    ]));
    expect(result.formatVersion).toBe("v1");
    expect(result.warnings.some((w) => w.includes(FORMAT_WARNING))).toBe(false);
    expect(result.messages.map((m) => m.textContent)).toEqual(["first real message", "reply"]);
    expect(result.sessionId).toBe(SESSION);
  });

  it("recognizes a transcript with a long run of leading metadata", () => {
    const lead = Array.from({ length: 120 }, (_, i) =>
      metadata(i % 2 === 0 ? "attachment" : "custom-title"));
    const result = parseTranscriptFile(write("long-lead.jsonl", [...lead, message("user", "late")]));
    expect(result.formatVersion).toBe("v1");
    expect(result.messages).toHaveLength(1);
  });

  it("still reports unknown when no record carries a message", () => {
    const result = parseTranscriptFile(write("no-messages.jsonl", [
      metadata("queue-operation"),
      metadata("attachment"),
      { kind: "journal", step: 1 },
    ]));
    expect(result.formatVersion).toBe("unknown");
    expect(result.warnings.some((w) => w.includes(FORMAT_WARNING))).toBe(true);
    expect(result.messages).toHaveLength(0);
  });

  it("skips an unparseable leading line without losing detection", () => {
    const path = join(dir, "bad-first-line.jsonl");
    writeFileSync(path, "{not json\n" + JSON.stringify(message("user", "ok")) + "\n", "utf-8");
    const result = parseTranscriptFile(path);
    expect(result.formatVersion).toBe("v1");
    expect(result.messages).toHaveLength(1);
  });
});
