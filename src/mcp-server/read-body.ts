import type { IncomingMessage } from "node:http";

export const READ_BODY_CAP_OAUTH = 64 * 1024;        // 64 KB — DCR + token endpoints
export const READ_BODY_CAP_MCP   = 4 * 1024 * 1024;  // 4 MB  — batch graph_relate from transcripts

export class PayloadTooLargeError extends Error {
  override readonly name = "PayloadTooLargeError";
  constructor(maxBytes: number) {
    super(`Request body exceeds the ${maxBytes}-byte limit`);
  }
}

/** Read body, supporting application/json or application/x-www-form-urlencoded.
 *  Returns a key→value record; values are strings or string arrays.
 *  Throws PayloadTooLargeError if the body exceeds maxBytes. */
export async function readBody(
  req: IncomingMessage,
  maxBytes: number = READ_BODY_CAP_OAUTH,
): Promise<Record<string, unknown>> {
  // Fast reject: if Content-Length is present and already over the cap, bail
  // before reading any body bytes.
  const contentLengthHeader = req.headers["content-length"];
  if (contentLengthHeader !== undefined) {
    const declared = parseInt(contentLengthHeader, 10);
    if (!isNaN(declared) && declared > maxBytes) {
      throw new PayloadTooLargeError(maxBytes);
    }
  }
  const raw = await new Promise<string>((resolve, reject) => {
    let data = "";
    let bytes = 0;
    req.on("data", (c: Buffer | string) => {
      bytes += Buffer.byteLength(c);
      if (bytes > maxBytes) {
        req.destroy();
        reject(new PayloadTooLargeError(maxBytes));
        return;
      }
      data += c;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
  if (!raw) return {};
  const ct = (req.headers["content-type"] ?? "").toString();
  if (ct.includes("application/json")) {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  }
  if (ct.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(raw);
    const out: Record<string, string> = {};
    for (const [k, v] of params) out[k] = v;
    return out;
  }
  // Fallback: try JSON, then form
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { /* fall through */ }
  try {
    const params = new URLSearchParams(raw);
    const out: Record<string, string> = {};
    for (const [k, v] of params) out[k] = v;
    return out;
  } catch { return {}; }
}
