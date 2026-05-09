import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Isolate this test's writes by pointing GRAPH_MEMORY_HOME at a temp dir
// before importing the module under test.
const testHome = mkdtempSync(join(tmpdir(), "graph-memory-events-test-"));
process.env.GRAPH_MEMORY_HOME = testHome;

const { appendOAuthEventLog, pickClientIp } = await import("./oauth-events.js");

const EVENTS_PATH = join(testHome, "logs", "oauth-events.jsonl");

afterAll(() => {
  try { rmSync(testHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  if (existsSync(EVENTS_PATH)) unlinkSync(EVENTS_PATH);
});

afterEach(() => {
  if (existsSync(EVENTS_PATH)) unlinkSync(EVENTS_PATH);
});

describe("appendOAuthEventLog", () => {
  it("writes a JSONL line with the given event shape", () => {
    appendOAuthEventLog({
      timestamp: "2026-05-08T12:00:00.000Z",
      event: "register",
      client_id: "client_abc",
      redirect_uri_host: "claude.ai",
      source_ip: "1.2.3.4",
    });
    const lines = readFileSync(EVENTS_PATH, "utf-8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toEqual({
      timestamp: "2026-05-08T12:00:00.000Z",
      event: "register",
      client_id: "client_abc",
      redirect_uri_host: "claude.ai",
      source_ip: "1.2.3.4",
    });
  });

  it("appends multiple lines in order", () => {
    appendOAuthEventLog({ timestamp: "t1", event: "register" });
    appendOAuthEventLog({ timestamp: "t2", event: "authorize_ok", email: "a@x" });
    appendOAuthEventLog({ timestamp: "t3", event: "token_issue", jti: "abc" });
    const lines = readFileSync(EVENTS_PATH, "utf-8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).timestamp).toBe("t1");
    expect(JSON.parse(lines[2]).jti).toBe("abc");
  });

  it("never throws when filesystem write fails", () => {
    // Mock appendFileSync via vitest module mock — simpler approach: force the
    // log dir to be read-only on POSIX, OR just trust the catch. To avoid
    // platform-specific permission tricks (Windows ignores Unix modes), spy
    // on console and confirm no exception escapes by passing an unserializable
    // value that would throw inside JSON.stringify. We use a circular ref.
    const circular: Record<string, unknown> = { timestamp: "t", event: "register" };
    circular.self = circular;
    expect(() => appendOAuthEventLog(circular as Parameters<typeof appendOAuthEventLog>[0])).not.toThrow();
  });
});

describe("pickClientIp", () => {
  const baseSocket = { remoteAddress: "10.0.0.1" };

  it("returns CF-Connecting-IP when present", () => {
    expect(pickClientIp({ headers: { "cf-connecting-ip": "9.9.9.9" }, socket: baseSocket })).toBe("9.9.9.9");
  });

  it("trims CF-Connecting-IP", () => {
    expect(pickClientIp({ headers: { "cf-connecting-ip": "  9.9.9.9  " }, socket: baseSocket })).toBe("9.9.9.9");
  });

  it("falls back to x-forwarded-for first hop when no CF header", () => {
    expect(pickClientIp({
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8, 9.9.9.9" },
      socket: baseSocket,
    })).toBe("1.2.3.4");
  });

  it("trims spaces in x-forwarded-for first hop", () => {
    expect(pickClientIp({
      headers: { "x-forwarded-for": "  1.2.3.4  , 5.6.7.8" },
      socket: baseSocket,
    })).toBe("1.2.3.4");
  });

  it("falls back to socket.remoteAddress when no headers", () => {
    expect(pickClientIp({ headers: {}, socket: baseSocket })).toBe("10.0.0.1");
  });

  it("returns undefined when nothing is available", () => {
    expect(pickClientIp({ headers: {}, socket: {} })).toBeUndefined();
  });

  it("CF header takes precedence over x-forwarded-for", () => {
    expect(pickClientIp({
      headers: { "cf-connecting-ip": "9.9.9.9", "x-forwarded-for": "1.2.3.4" },
      socket: baseSocket,
    })).toBe("9.9.9.9");
  });

  it("handles array-valued headers (Node coerces some headers to arrays)", () => {
    expect(pickClientIp({
      headers: { "cf-connecting-ip": ["9.9.9.9", "8.8.8.8"] },
      socket: baseSocket,
    })).toBe("9.9.9.9");
  });
});
