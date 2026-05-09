import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { homedir } from "node:os";
import { verifyAccessToken } from "./oauth.js";

// ─── Tenant resolution ───────────────────────────────────────────────────────
//
// graph-memory supports three sources for the request-scoped tenant id:
//
//   - "static"     — Tenant id is hard-coded via LOCAL_TENANT_ID. Used by the
//                    stdio transport (Claude Code / Claude Desktop running
//                    locally) and for unit tests.
//   - "cf-access"  — Tenant id is extracted from a Cloudflare Access JWT
//                    (Cf-Access-Jwt-Assertion header). Used by the HTTP/HTTPS
//                    transport when the server sits behind Cloudflare Tunnel
//                    + Access. JWT signature is verified against the team's
//                    JWKS endpoint.
//   - "header"     — Trust an explicit X-Graph-Memory-Tenant request header.
//                    Insecure on its own — only enable when fronted by an
//                    auth proxy that you trust to set the header. Useful for
//                    self-hosted reverse-proxy setups.
//
// The MCP server reads TENANT_ID_SOURCE to pick a strategy at boot. Unknown
// values default to "static" with a warning.

export type TenantSource = "static" | "cf-access" | "header" | "oauth";

export function getTenantSource(): TenantSource {
  const v = (process.env.TENANT_ID_SOURCE ?? "static").toLowerCase();
  if (v === "static" || v === "cf-access" || v === "header" || v === "oauth") return v;
  process.stderr.write(`[graph-memory] unknown TENANT_ID_SOURCE=${v}, defaulting to "static"\n`);
  return "static";
}

export function getStaticTenantId(): string {
  return (
    process.env.LOCAL_TENANT_ID ??
    process.env.BOOTSTRAP_TENANT_ID ??
    "bootstrap"
  );
}

// ─── Cloudflare Access JWT verification ──────────────────────────────────────

/** Memoized JWKS resolver. createRemoteJWKSet handles caching internally and
 *  refreshes when an unknown kid appears, so we instantiate it once per
 *  process and reuse. */
let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedTeamDomain: string | null = null;

function getJwks(teamDomain: string) {
  if (jwksCache && cachedTeamDomain === teamDomain) return jwksCache;
  const url = new URL(`https://${teamDomain}/cdn-cgi/access/certs`);
  jwksCache = createRemoteJWKSet(url);
  cachedTeamDomain = teamDomain;
  return jwksCache;
}

export interface VerifiedAccessIdentity {
  email: string;
  /** The resolved tenant id (currently = email; could be hashed later). */
  tenantId: string;
  /** Raw JWT claims for downstream auditing. */
  claims: JWTPayload;
}

/** Verify a Cloudflare Access JWT and return the authenticated identity.
 *  Throws if the JWT is missing, malformed, expired, or fails signature
 *  verification. */
export async function verifyCfAccessJwt(
  jwt: string,
  config: { teamDomain: string; audience: string },
): Promise<VerifiedAccessIdentity> {
  const jwks = getJwks(config.teamDomain);
  const { payload } = await jwtVerify(jwt, jwks, {
    issuer: `https://${config.teamDomain}`,
    audience: config.audience,
  });

  const email =
    (typeof payload.email === "string" ? payload.email : null) ??
    (typeof payload.sub === "string" ? payload.sub : null);

  if (!email) {
    throw new Error("Cloudflare Access JWT does not contain an email or sub claim");
  }

  return {
    email,
    tenantId: email, // simple mapping; revisit if we ever want hashed tenant ids
    claims: payload,
  };
}

// ─── Resolve tenant per request ──────────────────────────────────────────────

export interface RequestHeaders {
  [name: string]: string | string[] | undefined;
}

function pickHeader(headers: RequestHeaders, name: string): string | undefined {
  // Node lowercases header names automatically, but be defensive.
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      const v = headers[key];
      if (Array.isArray(v)) return v[0];
      return v;
    }
  }
  return undefined;
}

export interface ResolveTenantResult {
  tenantId: string;
  identity?: VerifiedAccessIdentity;
}

export class TenantAuthError extends Error {
  constructor(message: string, readonly status = 401) {
    super(message);
    this.name = "TenantAuthError";
  }
}

/** Thrown when bearer-token verification fails. The public `message` is a
 *  constant string (no detail leaked to the wire); the verbose jose reason
 *  is carried separately on `.reason` so the request handler can route it
 *  to the OAuth events log instead. */
export class BearerVerifyError extends TenantAuthError {
  constructor(public readonly reason: string) {
    super("bearer token verification failed", 401);
    this.name = "BearerVerifyError";
  }
}

/** Resolve the tenant id for an inbound HTTP request, applying the strategy
 *  configured by TENANT_ID_SOURCE. Throws TenantAuthError when the request
 *  doesn't carry the expected proof of identity. */
export async function resolveTenantFromRequest(
  headers: RequestHeaders,
): Promise<ResolveTenantResult> {
  const source = getTenantSource();

  if (source === "static") {
    return { tenantId: getStaticTenantId() };
  }

  if (source === "header") {
    const tenant = pickHeader(headers, "x-graph-memory-tenant");
    if (!tenant) {
      throw new TenantAuthError("missing X-Graph-Memory-Tenant header");
    }
    return { tenantId: tenant };
  }

  if (source === "oauth") {
    return await resolveTenantViaBearer(headers);
  }

  // cf-access
  const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN;
  const audience = process.env.CF_ACCESS_AUD;
  if (!teamDomain || !audience) {
    throw new TenantAuthError(
      "TENANT_ID_SOURCE=cf-access requires CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD env vars",
      500,
    );
  }
  const jwt = pickHeader(headers, "cf-access-jwt-assertion");
  if (!jwt) {
    throw new TenantAuthError("missing Cf-Access-Jwt-Assertion header (request must come through Cloudflare Access)");
  }
  try {
    const identity = await verifyCfAccessJwt(jwt, { teamDomain, audience });
    return { tenantId: identity.tenantId, identity };
  } catch (err) {
    throw new TenantAuthError(
      `Cf-Access-Jwt-Assertion verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Resolve tenant from a bearer token issued by our OAuth provider.
 *  Used when TENANT_ID_SOURCE=oauth (the standard remote MCP setup). */
async function resolveTenantViaBearer(
  headers: RequestHeaders,
): Promise<ResolveTenantResult> {
  const auth = pickHeader(headers, "authorization");
  if (!auth || !auth.toLowerCase().startsWith("bearer ")) {
    throw new TenantAuthError(
      "missing or non-Bearer Authorization header — see /.well-known/oauth-protected-resource",
    );
  }
  const token = auth.slice(7).trim();
  try {
    const claims = await verifyAccessToken(token);
    const email = claims.email;
    if (!email) throw new Error("token missing email claim");
    return {
      tenantId: email,
      identity: {
        email,
        tenantId: email,
        claims,
      },
    };
  } catch (err) {
    throw new BearerVerifyError(err instanceof Error ? err.message : String(err));
  }
}

// ─── Admin tenant check ──────────────────────────────────────────────────────
// A handful of operations (graph_cypher, global graph_export, embedding
// backfill via graph_reembed across tenants) require admin privileges. We
// gate them on whether the calling tenant matches BOOTSTRAP_TENANT_ID. This
// is intentionally simple — no role system. If finer-grained roles become
// necessary, this is the seam.

export function isAdminTenant(tenantId: string): boolean {
  const bootstrap = process.env.BOOTSTRAP_TENANT_ID;
  if (!bootstrap) return false;
  return tenantId === bootstrap;
}
