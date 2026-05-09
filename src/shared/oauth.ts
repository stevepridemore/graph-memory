// ─── OAuth 2.1 provider ──────────────────────────────────────────────────────
//
// graph-memory's HTTP transport speaks OAuth 2.1 with dynamic client
// registration (RFC 7591) so that AI clients like claude.ai web can connect
// via the standard bearer-token flow. Identity is delegated to Cloudflare
// Access — the /oauth/authorize endpoint is the only one still gated by CF
// Access; everything else (metadata, register, token, mcp) is public and
// authenticated by tokens we sign ourselves.
//
// Storage is intentionally minimal: an RSA keypair on disk for token signing,
// a JSON file of registered clients, and an in-memory map of pending auth
// codes (codes are short-lived; losing them on restart is fine — clients
// will just retry the flow).

import {
  generateKeyPair,
  exportPKCS8,
  exportSPKI,
  importPKCS8,
  importSPKI,
  SignJWT,
  jwtVerify,
  type JWTPayload,
} from "jose";

// jose v6 dropped the KeyLike alias. importPKCS8/importSPKI return CryptoKey;
// we use that type directly.
type SigningKey = CryptoKey;
import { readFileSync, writeFileSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { GRAPH_MEMORY_HOME } from "./config.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const OAUTH_DIR = join(GRAPH_MEMORY_HOME, "oauth");
const PRIVATE_KEY_PATH = join(OAUTH_DIR, "private.pem");
const PUBLIC_KEY_PATH = join(OAUTH_DIR, "public.pem");
const CLIENTS_PATH = join(OAUTH_DIR, "clients.json");
const REVOKED_PATH = join(OAUTH_DIR, "revoked.json");

const ACCESS_TOKEN_TTL_SECONDS = 3600;        // 1 hour
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const AUTH_CODE_TTL_SECONDS = 600;            // 10 minutes
const ALG = "RS256";

// ─── Issuer URL ──────────────────────────────────────────────────────────────
//
// The issuer URL is the public origin of this server (e.g.
// https://your-host.example). Clients use it as `iss` in tokens and as
// the base for OAuth metadata discovery. We read it from OAUTH_ISSUER, falling
// back to localhost for dev.

export function getIssuer(): string {
  return process.env.OAUTH_ISSUER ?? "https://localhost:3847";
}

// ─── Keypair management ──────────────────────────────────────────────────────

let cachedKeys: { privateKey: SigningKey; publicKey: SigningKey; publicJwk: Record<string, unknown> } | null = null;

async function loadOrGenerateKeys() {
  if (cachedKeys) return cachedKeys;
  mkdirSync(OAUTH_DIR, { recursive: true });

  let privatePem: string;
  let publicPem: string;

  if (existsSync(PRIVATE_KEY_PATH) && existsSync(PUBLIC_KEY_PATH)) {
    privatePem = readFileSync(PRIVATE_KEY_PATH, "utf-8");
    publicPem = readFileSync(PUBLIC_KEY_PATH, "utf-8");
  } else {
    const { privateKey, publicKey } = await generateKeyPair(ALG, { extractable: true });
    privatePem = await exportPKCS8(privateKey);
    publicPem = await exportSPKI(publicKey);
    writeFileSync(PRIVATE_KEY_PATH, privatePem, { mode: 0o600 });
    writeFileSync(PUBLIC_KEY_PATH, publicPem, { mode: 0o644 });
    process.stderr.write(`[graph-memory] generated new OAuth signing keypair at ${OAUTH_DIR}\n`);
  }

  const privateKey = await importPKCS8(privatePem, ALG, { extractable: true });
  const publicKey = await importSPKI(publicPem, ALG, { extractable: true });

  // Build JWK for the JWKS endpoint. Compute kid as a stable hash of the
  // public key's PEM so it doesn't change unless the key rotates.
  const kid = createHash("sha256").update(publicPem).digest("hex").slice(0, 16);
  const { exportJWK } = await import("jose");
  const publicJwk = (await exportJWK(publicKey)) as Record<string, unknown>;
  publicJwk.kid = kid;
  publicJwk.use = "sig";
  publicJwk.alg = ALG;

  cachedKeys = { privateKey, publicKey, publicJwk };
  return cachedKeys;
}

export async function getJwksJson(): Promise<{ keys: Record<string, unknown>[] }> {
  const { publicJwk } = await loadOrGenerateKeys();
  return { keys: [publicJwk] };
}

// ─── Client registration store (RFC 7591) ────────────────────────────────────

export interface RegisteredClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "none";
  grant_types: string[];
  response_types: string[];
  registered_at: string;
}

interface ClientStore {
  clients: Record<string, RegisteredClient>;
}

function loadClients(): ClientStore {
  try {
    return JSON.parse(readFileSync(CLIENTS_PATH, "utf-8")) as ClientStore;
  } catch {
    return { clients: {} };
  }
}

function saveClients(store: ClientStore): void {
  mkdirSync(OAUTH_DIR, { recursive: true });
  writeFileSync(CLIENTS_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
  // Best-effort chmod to upgrade permissions on existing files (no-op on Windows).
  try { chmodSync(CLIENTS_PATH, 0o600); } catch { /* ignore */ }
}

export function getClient(clientId: string): RegisteredClient | null {
  return loadClients().clients[clientId] ?? null;
}

// ─── Revocation deny-list (RFC 7009) ─────────────────────────────────────────

interface RevokedEntry {
  revoked_at: string; // ISO
  exp: number;        // original token expiry (epoch seconds) — for pruning
}

interface RevokedStore {
  revoked: Record<string, RevokedEntry>;
}

function loadRevoked(): RevokedStore {
  let store: RevokedStore;
  try {
    store = JSON.parse(readFileSync(REVOKED_PATH, "utf-8")) as RevokedStore;
  } catch {
    store = { revoked: {} };
  }
  // Prune entries whose token has already expired naturally.
  const now = Date.now() / 1000;
  let changed = false;
  for (const jti of Object.keys(store.revoked)) {
    if (store.revoked[jti].exp < now) {
      delete store.revoked[jti];
      changed = true;
    }
  }
  if (changed) saveRevoked(store);
  return store;
}

function saveRevoked(store: RevokedStore): void {
  mkdirSync(OAUTH_DIR, { recursive: true });
  writeFileSync(REVOKED_PATH, JSON.stringify(store, null, 2));
}

export function isRevoked(jti: string): boolean {
  const store = loadRevoked();
  return jti in store.revoked;
}

export function addRevocation(jti: string, exp: number): void {
  const store = loadRevoked();
  store.revoked[jti] = { revoked_at: new Date().toISOString(), exp };
  saveRevoked(store);
}

// ─── Registration limit error ────────────────────────────────────────────────

export class RegistrationLimitError extends Error {
  constructor(limit: number) {
    super(`registration limit reached (max ${limit} clients)`);
    this.name = "RegistrationLimitError";
  }
}

export class InvalidClientMetadataError extends Error {
  constructor(description: string) {
    super(description);
    this.name = "InvalidClientMetadataError";
  }
}

// ─── redirect_uri hostname allowlist ─────────────────────────────────────────
//
// Only redirect URIs whose hostname belongs to an allowlisted domain are
// accepted at registration time. This closes the OAuth phishing chain where an
// attacker registers https://attacker.example/cb, sends the operator a crafted
// /oauth/authorize URL on the legitimate hostname, CF Access lets the operator
// through, and the server 302s the auth code to the attacker.
//
// The allowlist is driven by OAUTH_REDIRECT_URI_HOSTS (comma-separated exact
// hostnames and/or "*.domain" one-level-subdomain patterns). When unset it
// defaults to the production-safe list below.
//
// Wildcard matching is intentionally strict: "*.claude.ai" matches
// "connector.claude.ai" but NOT "evil.claude.ai.attacker.example" — we split
// on "." and only accept a single label prepended to the exact base domain.

const DEFAULT_REDIRECT_URI_HOSTS = "claude.ai,*.claude.ai,claude.com,*.claude.com,localhost,127.0.0.1";

function getRedirectUriAllowlist(): string[] {
  // `||` (not `??`) so docker-compose's `${VAR:-}` empty-string default falls
  // through to the production default rather than producing an empty allowlist
  // that rejects every registration.
  const raw = process.env.OAUTH_REDIRECT_URI_HOSTS?.trim() || DEFAULT_REDIRECT_URI_HOSTS;
  return raw.split(",").map(h => h.trim()).filter(Boolean);
}

export function isRedirectUriHostAllowed(hostname: string, allowlist?: string[]): boolean {
  const list = allowlist ?? getRedirectUriAllowlist();
  for (const pattern of list) {
    if (pattern.startsWith("*.")) {
      // One-level subdomain: pattern "*.claude.ai" matches "connector.claude.ai"
      // but not "a.b.claude.ai" or "claude.ai" itself.
      const base = pattern.slice(2); // e.g. "claude.ai"
      // hostname must be exactly <single-label>.<base> — no extra dots allowed.
      if (hostname.endsWith("." + base)) {
        const prefix = hostname.slice(0, hostname.length - base.length - 1);
        if (prefix.length > 0 && !prefix.includes(".")) return true;
      }
    } else {
      if (hostname === pattern) return true;
    }
  }
  return false;
}

export function registerClient(input: {
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method?: string;
  grant_types?: string[];
  response_types?: string[];
}): RegisteredClient {
  if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length === 0) {
    throw new Error("redirect_uris is required and must be a non-empty array");
  }
  for (const uri of input.redirect_uris) {
    try {
      const u = new URL(uri);
      // Allow only https in production-ish settings, plus http://localhost for testing.
      if (u.protocol !== "https:" && !(u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"))) {
        throw new Error(`redirect_uri must use https (or http://localhost): ${uri}`);
      }
      // Hostname allowlist check — reject anything not in the approved list.
      if (!isRedirectUriHostAllowed(u.hostname)) {
        throw new Error(`redirect_uri hostname not allowed: ${u.hostname}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("redirect_uri must")) throw err;
      if (err instanceof Error && err.message.startsWith("redirect_uri hostname")) throw err;
      throw new Error(`redirect_uri is not a valid URL: ${uri}`);
    }
  }

  const maxClients = parseInt(process.env.OAUTH_MAX_CLIENTS ?? "100", 10);
  const store = loadClients();
  if (Object.keys(store.clients).length >= maxClients) {
    throw new RegistrationLimitError(maxClients);
  }

  const authMethod = input.token_endpoint_auth_method ?? "none";
  if (authMethod !== "none") {
    throw new InvalidClientMetadataError(
      "only public clients (token_endpoint_auth_method=none) are supported",
    );
  }
  const client: RegisteredClient = {
    client_id: `client_${randomBytes(16).toString("hex")}`,
    client_name: input.client_name,
    redirect_uris: input.redirect_uris,
    token_endpoint_auth_method: "none",
    grant_types: input.grant_types ?? ["authorization_code", "refresh_token"],
    response_types: input.response_types ?? ["code"],
    registered_at: new Date().toISOString(),
  };

  store.clients[client.client_id] = client;
  saveClients(store);
  return client;
}

// ─── Authorization code store (in-memory) ────────────────────────────────────
//
// Codes are short-lived (10 min TTL) and single-use. Losing them on restart
// is safe — clients just retry the authorize flow.

interface AuthCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  email: string;       // resolved identity
  scope: string;
  code_challenge?: string;
  code_challenge_method?: "S256" | "plain";
  expires_at: number;  // ms epoch
}

const authCodes = new Map<string, AuthCode>();

function purgeExpiredCodes() {
  const now = Date.now();
  for (const [k, v] of authCodes) if (v.expires_at < now) authCodes.delete(k);
}

export function issueAuthCode(input: {
  client_id: string;
  redirect_uri: string;
  email: string;
  scope?: string;
  code_challenge?: string;
  code_challenge_method?: "S256" | "plain";
}): string {
  purgeExpiredCodes();
  const code = randomBytes(32).toString("base64url");
  authCodes.set(code, {
    code,
    client_id: input.client_id,
    redirect_uri: input.redirect_uri,
    email: input.email,
    scope: input.scope ?? "",
    code_challenge: input.code_challenge,
    code_challenge_method: input.code_challenge_method,
    expires_at: Date.now() + AUTH_CODE_TTL_SECONDS * 1000,
  });
  return code;
}

export function consumeAuthCode(code: string): AuthCode | null {
  purgeExpiredCodes();
  const entry = authCodes.get(code);
  if (!entry) return null;
  authCodes.delete(code); // single-use
  return entry;
}

// ─── Token issuance and verification ─────────────────────────────────────────

export interface AccessTokenClaims extends JWTPayload {
  email: string;
  client_id: string;
  scope: string;
  /** type is "access" or "refresh" — different lifetimes, otherwise same shape */
  type: "access" | "refresh";
}

export async function issueAccessToken(input: {
  email: string;
  client_id: string;
  scope?: string;
}): Promise<string> {
  const { privateKey, publicJwk } = await loadOrGenerateKeys();
  return new SignJWT({
    email: input.email,
    client_id: input.client_id,
    scope: input.scope ?? "",
    type: "access",
  })
    .setProtectedHeader({ alg: ALG, kid: String(publicJwk.kid), typ: "JWT" })
    .setJti(randomBytes(16).toString("hex"))
    .setIssuer(getIssuer())
    .setSubject(input.email)
    .setAudience(getIssuer())
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(privateKey);
}

export async function issueRefreshToken(input: {
  email: string;
  client_id: string;
  scope?: string;
}): Promise<string> {
  const { privateKey, publicJwk } = await loadOrGenerateKeys();
  return new SignJWT({
    email: input.email,
    client_id: input.client_id,
    scope: input.scope ?? "",
    type: "refresh",
  })
    .setProtectedHeader({ alg: ALG, kid: String(publicJwk.kid), typ: "JWT" })
    .setJti(randomBytes(16).toString("hex"))
    .setIssuer(getIssuer())
    .setSubject(input.email)
    .setAudience(getIssuer())
    .setIssuedAt()
    .setExpirationTime(`${REFRESH_TOKEN_TTL_SECONDS}s`)
    .sign(privateKey);
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  const { publicKey } = await loadOrGenerateKeys();
  const issuer = getIssuer();
  const { payload } = await jwtVerify(token, publicKey, {
    issuer,
    audience: issuer,
  });
  if (payload.type !== "access") {
    throw new Error(`expected access token, got type=${payload.type}`);
  }
  if (payload.jti && isRevoked(payload.jti)) {
    throw new Error("token revoked");
  }
  return payload as AccessTokenClaims;
}

export async function verifyRefreshToken(token: string): Promise<AccessTokenClaims> {
  const { publicKey } = await loadOrGenerateKeys();
  const issuer = getIssuer();
  const { payload } = await jwtVerify(token, publicKey, {
    issuer,
    audience: issuer,
  });
  if (payload.type !== "refresh") {
    throw new Error(`expected refresh token, got type=${payload.type}`);
  }
  if (payload.jti && isRevoked(payload.jti)) {
    throw new Error("token revoked");
  }
  return payload as AccessTokenClaims;
}

/** Revoke a token (access or refresh) per RFC 7009.
 *  Returns `{ revoked: true, jti }` if the token was valid and newly revoked.
 *  Returns `{ revoked: false }` if unknown / expired / already revoked / pre-jti.
 *  Per RFC 7009 callers should return 200 regardless. */
export async function revokeToken(token: string): Promise<{ revoked: boolean; jti?: string }> {
  const { publicKey } = await loadOrGenerateKeys();
  const issuer = getIssuer();
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, publicKey, { issuer, audience: issuer }));
  } catch {
    // Unknown, expired, or already revoked — RFC 7009 §2.2: respond 200 anyway.
    return { revoked: false };
  }
  const jti = payload.jti;
  if (!jti) return { revoked: false }; // pre-jti token — grace period: can't revoke
  if (isRevoked(jti)) return { revoked: false }; // already revoked
  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  addRevocation(jti, exp);
  return { revoked: true, jti };
}

// ─── PKCE verification ───────────────────────────────────────────────────────

export function verifyPkce(
  verifier: string,
  challenge: string,
  method: "S256" | "plain" = "S256",
): boolean {
  // OAuth 2.1 forbids `plain`. Reject defensively even though /oauth/authorize
  // already rejects it at issue time.
  if (method !== "S256") return false;
  // S256: challenge = base64url(sha256(verifier))
  const computed = createHash("sha256").update(verifier).digest("base64url");
  return computed === challenge;
}

// ─── Discovery metadata ──────────────────────────────────────────────────────

export function authorizationServerMetadata(issuer = getIssuer()) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    registration_endpoint: `${issuer}/oauth/register`,
    jwks_uri: `${issuer}/oauth/jwks`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["openid", "email", "profile", "mcp"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: [ALG],
  };
}

export function protectedResourceMetadata(issuer = getIssuer()) {
  return {
    resource: issuer,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    resource_documentation: `${issuer}/health`,
  };
}

// ─── Email allowlist ─────────────────────────────────────────────────────────

const _warnedMalformedAllowEmail = new Set<string>();
//
// If OAUTH_ALLOWED_EMAILS is set to a non-empty value, only emails in the
// comma-separated list are allowed through /oauth/authorize and
// grant_type=refresh_token. Unset or empty string → allow any identity that
// passes Cloudflare Access (the existing behaviour).
//
// Each entry is either:
//   - an exact email  e.g. user@example.com
//   - a wildcard      e.g. *@example.com  (matches any local-part for that domain)
//
// Wildcard matching is strict: *@example.com matches foo@example.com but NOT
// foo@mail.example.com.  A malformed entry (no @, multiple @, wildcard not at
// start, etc.) is skipped with a one-time console.warn.  If ALL entries are
// malformed, the function falls back to allow-any but still logs the warning.

export function isEmailAllowed(email: string): boolean {
  // Use || so that docker-compose ${VAR:-} empty-string falls through to
  // allow-any, matching the pattern used for OAUTH_REDIRECT_URI_HOSTS.
  const raw = process.env.OAUTH_ALLOWED_EMAILS?.trim() || "";
  if (!raw) return true;

  const normalized = email.trim().toLowerCase();
  const entries = raw.split(",");
  const validEntries: string[] = [];

  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const parts = trimmed.split("@");
    if (parts.length !== 2) {
      if (!_warnedMalformedAllowEmail.has(trimmed)) {
        _warnedMalformedAllowEmail.add(trimmed);
        console.warn(`[graph-memory] OAUTH_ALLOWED_EMAILS: malformed entry (expected one @): "${trimmed}"`);
      }
      continue;
    }
    const [local, domain] = parts;
    if (!domain) {
      if (!_warnedMalformedAllowEmail.has(trimmed)) {
        _warnedMalformedAllowEmail.add(trimmed);
        console.warn(`[graph-memory] OAUTH_ALLOWED_EMAILS: malformed entry (empty domain): "${trimmed}"`);
      }
      continue;
    }
    if (local !== "*" && local!.includes("*")) {
      if (!_warnedMalformedAllowEmail.has(trimmed)) {
        _warnedMalformedAllowEmail.add(trimmed);
        console.warn(`[graph-memory] OAUTH_ALLOWED_EMAILS: malformed entry (wildcard not at start): "${trimmed}"`);
      }
      continue;
    }
    validEntries.push(trimmed.toLowerCase());
  }

  if (validEntries.length === 0) {
    // All entries were malformed — fall back to allow-any.
    return true;
  }

  for (const entry of validEntries) {
    if (entry.startsWith("*@")) {
      const domain = entry.slice(2);
      if (normalized.endsWith("@" + domain)) {
        // Ensure there's a non-empty local-part and no subdomain.
        const atIdx = normalized.indexOf("@");
        if (atIdx > 0 && normalized.slice(atIdx + 1) === domain) return true;
      }
    } else {
      if (normalized === entry) return true;
    }
  }

  return false;
}
