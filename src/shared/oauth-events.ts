// ─── OAuth event log ───
// One JSONL line per OAuth-relevant event (registration, authorize, token
// issuance, refresh, revoke, bearer verification failure). Used for
// post-incident forensics: who registered what, when did each token issue,
// what was the reason for a verify failure. Best-effort (never throws).
//
// Lives in src/shared/ rather than src/mcp-server/ so it's importable by
// unit tests without booting the full MCP server.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { GRAPH_MEMORY_HOME } from "./config.js";

export interface OAuthEvent {
  timestamp: string;
  event:
    | "register" | "register_fail"
    | "authorize_ok" | "authorize_fail"
    | "token_issue" | "token_refresh"
    | "token_consume_fail" | "token_pkce_fail" | "token_refresh_fail"
    | "client_deregistered"
    | "revoke_ok" | "revoke_noop"
    | "bearer_verify_fail";
  client_id?: string;
  email?: string;
  jti?: string;
  redirect_uri_host?: string;
  reason?: string;
  source_ip?: string;
}

export function appendOAuthEventLog(event: OAuthEvent): void {
  try {
    const logPath = join(GRAPH_MEMORY_HOME, "logs", "oauth-events.jsonl");
    mkdirSync(join(GRAPH_MEMORY_HOME, "logs"), { recursive: true });
    appendFileSync(logPath, JSON.stringify(event) + "\n");
  } catch { /* never throw from logging */ }
}

// ─── Source-IP extraction ───
// Behind Cloudflare Tunnel the real client IP is in `cf-connecting-ip`.
// Fall through to the standard `x-forwarded-for` first hop, then the raw
// socket address as a last resort.
export interface ClientIpReq {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}

export function pickClientIp(req: ClientIpReq): string | undefined {
  const cf = req.headers["cf-connecting-ip"];
  const cfStr = Array.isArray(cf) ? cf[0] : cf;
  if (cfStr) return cfStr.trim();
  const xff = req.headers["x-forwarded-for"];
  const xffStr = Array.isArray(xff) ? xff[0] : xff;
  if (xffStr) {
    const first = xffStr.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress;
}
