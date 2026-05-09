import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { readBody, PayloadTooLargeError, READ_BODY_CAP_OAUTH } from "./read-body.js";
import type { IncomingMessage } from "node:http";

function makeReq(opts: {
  headers?: Record<string, string>;
  chunks?: Buffer[];
  error?: Error;
}): IncomingMessage & { destroy: ReturnType<typeof vi.fn> } {
  const emitter = new EventEmitter();
  const destroy = vi.fn();
  const req = Object.assign(emitter, {
    headers: opts.headers ?? {},
    destroy,
  }) as unknown as IncomingMessage & { destroy: ReturnType<typeof vi.fn> };

  // Schedule data/end/error emission after the promise listener is attached.
  setImmediate(() => {
    if (opts.error) {
      emitter.emit("error", opts.error);
      return;
    }
    for (const chunk of opts.chunks ?? []) {
      emitter.emit("data", chunk);
    }
    emitter.emit("end");
  });

  return req;
}

function jsonReq(body: unknown, extraHeaders?: Record<string, string>): ReturnType<typeof makeReq> {
  const buf = Buffer.from(JSON.stringify(body), "utf8");
  return makeReq({
    headers: { "content-type": "application/json", "content-length": String(buf.byteLength), ...extraHeaders },
    chunks: [buf],
  });
}

describe("readBody", () => {
  it("normal small JSON body returns parsed object", async () => {
    const req = jsonReq({ hello: "world_tc1" });
    const result = await readBody(req);
    expect(result).toEqual({ hello: "world_tc1" });
  });

  it("JSON body well within cap parses correctly", async () => {
    const payload = { key: "value_tc2", num: 42 };
    const req = jsonReq(payload);
    const result = await readBody(req, READ_BODY_CAP_OAUTH);
    expect(result).toEqual(payload);
  });

  it("body exceeds cap with honest oversized Content-Length throws synchronously, req.destroy NOT called", async () => {
    const oversized = READ_BODY_CAP_OAUTH + 1;
    const req = makeReq({
      headers: { "content-type": "application/json", "content-length": String(oversized) },
      chunks: [],
    });
    await expect(readBody(req, READ_BODY_CAP_OAUTH)).rejects.toThrow(PayloadTooLargeError);
    expect(req.destroy).not.toHaveBeenCalled();
  });

  it("body exceeds cap with no Content-Length throws streaming error and calls req.destroy", async () => {
    // ~80 KB of data, no content-length, small cap
    const bigChunk = Buffer.alloc(80 * 1024, "x");
    const req = makeReq({
      headers: { "content-type": "application/json" },
      chunks: [bigChunk],
    });
    await expect(readBody(req, 64 * 1024)).rejects.toThrow(PayloadTooLargeError);
    expect(req.destroy).toHaveBeenCalled();
  });

  it("body exceeds cap with lying-low Content-Length catches via streaming and calls req.destroy", async () => {
    // declares 100 bytes, sends ~80 KB
    const bigChunk = Buffer.alloc(80 * 1024, "y");
    const req = makeReq({
      headers: { "content-type": "application/json", "content-length": "100" },
      chunks: [bigChunk],
    });
    await expect(readBody(req, 64 * 1024)).rejects.toThrow(PayloadTooLargeError);
    expect(req.destroy).toHaveBeenCalled();
  });

  it("exactly-at-cap body succeeds (cap is exclusive: > rejects, == is OK)", async () => {
    const cap = 100;
    const buf = Buffer.alloc(cap, "z");
    const req = makeReq({
      headers: { "content-type": "application/json", "content-length": String(cap) },
      chunks: [buf],
    });
    // buf is not valid JSON but the fallback returns {} — just check it doesn't throw PayloadTooLargeError
    await expect(readBody(req, cap)).resolves.toBeDefined();
  });

  it("empty body returns {}", async () => {
    const req = makeReq({
      headers: { "content-type": "application/json" },
      chunks: [],
    });
    const result = await readBody(req);
    expect(result).toEqual({});
  });

  it("malformed JSON within cap returns {}", async () => {
    const buf = Buffer.from("not valid json at all tc8", "utf8");
    const req = makeReq({
      headers: { "content-type": "application/json", "content-length": String(buf.byteLength) },
      chunks: [buf],
    });
    const result = await readBody(req);
    expect(result).toEqual({});
  });

  it("application/x-www-form-urlencoded body within cap returns parsed key-value object", async () => {
    const body = "grant_type=authorization_code_tc9&client_id=abc";
    const buf = Buffer.from(body, "utf8");
    const req = makeReq({
      headers: { "content-type": "application/x-www-form-urlencoded", "content-length": String(buf.byteLength) },
      chunks: [buf],
    });
    const result = await readBody(req);
    expect(result).toEqual({ grant_type: "authorization_code_tc9", client_id: "abc" });
  });

  it("override maxBytes argument honors smaller cap over default", async () => {
    const smallCap = 10;
    const buf = Buffer.from('{"key":"value_tc10_long_enough"}', "utf8");
    const req = makeReq({
      headers: { "content-type": "application/json", "content-length": String(buf.byteLength) },
      chunks: [buf],
    });
    await expect(readBody(req, smallCap)).rejects.toThrow(PayloadTooLargeError);
  });
});
