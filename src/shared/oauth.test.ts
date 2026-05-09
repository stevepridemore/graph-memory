import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decodeJwt } from "jose";

// Point GRAPH_MEMORY_HOME at a temp directory so the revocation store and
// keypair are isolated per test run and don't touch the real deployment.
const testHome = mkdtempSync(join(tmpdir(), "graph-memory-oauth-test-"));
process.env.GRAPH_MEMORY_HOME = testHome;
process.env.OAUTH_ISSUER = "https://test.example";

// Import after setting env so config.ts picks up GRAPH_MEMORY_HOME.
const {
  issueAccessToken,
  issueRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  revokeToken,
  addRevocation,
  isRevoked,
  registerClient,
  isRedirectUriHostAllowed,
  RegistrationLimitError,
  InvalidClientMetadataError,
  verifyPkce,
  authorizationServerMetadata,
  isEmailAllowed,
} = await import("./oauth.js");

// Clean up temp dir after all tests (best-effort).
// Vitest doesn't guarantee afterAll ordering across files; rmSync with
// force:true is safe to call even if something holds a handle.
import { afterAll } from "vitest";
afterAll(() => {
  try { rmSync(testHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

const SAMPLE = { email: "alice@example.com", client_id: "client_abc", scope: "mcp" };

describe("jti on issued tokens", () => {
  it("access token carries a unique jti", async () => {
    const t1 = await issueAccessToken(SAMPLE);
    const t2 = await issueAccessToken(SAMPLE);
    const p1 = decodeJwt(t1);
    const p2 = decodeJwt(t2);
    expect(typeof p1.jti).toBe("string");
    expect(p1.jti!.length).toBeGreaterThan(0);
    expect(p1.jti).not.toBe(p2.jti);
  });

  it("refresh token carries a unique jti", async () => {
    const t1 = await issueRefreshToken(SAMPLE);
    const t2 = await issueRefreshToken(SAMPLE);
    const p1 = decodeJwt(t1);
    const p2 = decodeJwt(t2);
    expect(typeof p1.jti).toBe("string");
    expect(p1.jti).not.toBe(p2.jti);
  });
});

describe("access token revocation", () => {
  it("verifyAccessToken succeeds before revocation", async () => {
    const token = await issueAccessToken(SAMPLE);
    await expect(verifyAccessToken(token)).resolves.toBeDefined();
  });

  it("revokeToken then verifyAccessToken throws", async () => {
    const token = await issueAccessToken(SAMPLE);
    await revokeToken(token);
    await expect(verifyAccessToken(token)).rejects.toThrow("token revoked");
  });

  it("revokeToken returns { revoked: true, jti } for a valid unrevoked token", async () => {
    const token = await issueAccessToken(SAMPLE);
    const expectedJti = decodeJwt(token).jti;
    const result = await revokeToken(token);
    expect(result.revoked).toBe(true);
    expect(result.jti).toBe(expectedJti);
  });

  it("revokeToken returns { revoked: false } with no jti for a garbage string", async () => {
    const result = await revokeToken("not.a.jwt");
    expect(result.revoked).toBe(false);
    expect(result.jti).toBeUndefined();
  });

  it("revokeToken returns { revoked: false } for an already-revoked token", async () => {
    const token = await issueAccessToken(SAMPLE);
    await revokeToken(token);
    const second = await revokeToken(token);
    expect(second.revoked).toBe(false);
    expect(second.jti).toBeUndefined();
  });
});

describe("refresh token revocation", () => {
  it("verifyRefreshToken succeeds before revocation", async () => {
    const token = await issueRefreshToken(SAMPLE);
    await expect(verifyRefreshToken(token)).resolves.toBeDefined();
  });

  it("revokeToken then verifyRefreshToken throws", async () => {
    const token = await issueRefreshToken(SAMPLE);
    await revokeToken(token);
    await expect(verifyRefreshToken(token)).rejects.toThrow("token revoked");
  });
});

describe("deny-list pruning", () => {
  it("isRevoked returns true right after addRevocation", () => {
    const jti = "pruning-test-jti-live";
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    addRevocation(jti, futureExp);
    expect(isRevoked(jti)).toBe(true);
  });

  it("addRevocation with past exp is pruned on next load", () => {
    const jti = "pruning-test-jti-expired";
    const pastExp = Math.floor(Date.now() / 1000) - 1; // already expired
    addRevocation(jti, pastExp);
    // loadRevoked() prunes on load — isRevoked calls loadRevoked internally.
    expect(isRevoked(jti)).toBe(false);
  });
});

// ─── redirect_uri hostname allowlist ─────────────────────────────────────────

describe("isRedirectUriHostAllowed — default allowlist", () => {
  it("accepts claude.ai", () => {
    expect(isRedirectUriHostAllowed("claude.ai")).toBe(true);
  });

  it("accepts a one-level subdomain connector.claude.ai", () => {
    expect(isRedirectUriHostAllowed("connector.claude.ai")).toBe(true);
  });

  it("accepts claude.com", () => {
    expect(isRedirectUriHostAllowed("claude.com")).toBe(true);
  });

  it("accepts a one-level subdomain connector.claude.com", () => {
    expect(isRedirectUriHostAllowed("connector.claude.com")).toBe(true);
  });

  it("accepts localhost", () => {
    expect(isRedirectUriHostAllowed("localhost")).toBe(true);
  });

  it("accepts 127.0.0.1", () => {
    expect(isRedirectUriHostAllowed("127.0.0.1")).toBe(true);
  });

  it("rejects attacker.example", () => {
    expect(isRedirectUriHostAllowed("attacker.example")).toBe(false);
  });

  it("rejects claude.ai.attacker.example (suffix-match attack)", () => {
    expect(isRedirectUriHostAllowed("claude.ai.attacker.example")).toBe(false);
  });

  it("rejects evilclaude.ai (prefix-only match, not a real subdomain)", () => {
    expect(isRedirectUriHostAllowed("evilclaude.ai")).toBe(false);
  });

  it("rejects two-level subdomain evil.connector.claude.ai", () => {
    expect(isRedirectUriHostAllowed("evil.connector.claude.ai")).toBe(false);
  });
});

describe("isRedirectUriHostAllowed — custom allowlist", () => {
  it("accepts a host explicitly listed", () => {
    expect(isRedirectUriHostAllowed("connector.internal.example", ["connector.internal.example"])).toBe(true);
  });

  it("rejects a host not in the custom list", () => {
    expect(isRedirectUriHostAllowed("claude.ai", ["connector.internal.example"])).toBe(false);
  });

  it("accepts a wildcard pattern match in the custom list", () => {
    expect(isRedirectUriHostAllowed("sub.internal.example", ["*.internal.example"])).toBe(true);
  });
});

// ─── registerClient redirect_uri validation ───────────────────────────────────
//
// config.ts honors GRAPH_MEMORY_HOME via env, so registerClient writes to the
// per-test-suite temp dir we set above. Each test cleans up clients.json so
// tests don't leak state to one another.

const clientsPath = join(testHome, "oauth", "clients.json");

function resetClients() {
  if (existsSync(clientsPath)) unlinkSync(clientsPath);
}

describe("registerClient redirect_uri hostname validation", () => {
  beforeEach(resetClients);
  afterEach(resetClients);

  it("accepts https://claude.ai/callback", () => {
    expect(() => registerClient({ redirect_uris: ["https://claude.ai/callback"] })).not.toThrow();
  });

  it("accepts https://connector.claude.ai/cb", () => {
    expect(() => registerClient({ redirect_uris: ["https://connector.claude.ai/cb"] })).not.toThrow();
  });

  it("accepts http://localhost:1234/cb", () => {
    expect(() => registerClient({ redirect_uris: ["http://localhost:1234/cb"] })).not.toThrow();
  });

  it("rejects https://attacker.example/cb with a descriptive error", () => {
    expect(() => registerClient({ redirect_uris: ["https://attacker.example/cb"] }))
      .toThrow("redirect_uri hostname not allowed");
  });

  it("rejects https://claude.ai.attacker.example/cb (suffix-match attack)", () => {
    expect(() => registerClient({ redirect_uris: ["https://claude.ai.attacker.example/cb"] }))
      .toThrow("redirect_uri hostname not allowed");
  });

  it("rejects https://evilclaude.ai/cb", () => {
    expect(() => registerClient({ redirect_uris: ["https://evilclaude.ai/cb"] }))
      .toThrow("redirect_uri hostname not allowed");
  });
});

describe("registerClient OAUTH_REDIRECT_URI_HOSTS env var", () => {
  const origEnv = process.env.OAUTH_REDIRECT_URI_HOSTS;

  beforeEach(() => {
    resetClients();
    process.env.OAUTH_REDIRECT_URI_HOSTS = "custom.example,*.custom.example";
  });

  afterEach(() => {
    resetClients();
    if (origEnv === undefined) {
      delete process.env.OAUTH_REDIRECT_URI_HOSTS;
    } else {
      process.env.OAUTH_REDIRECT_URI_HOSTS = origEnv;
    }
  });

  it("accepts a URI matching the custom list", () => {
    expect(() => registerClient({ redirect_uris: ["https://custom.example/cb"] })).not.toThrow();
  });

  it("accepts a wildcard subdomain matching the custom list", () => {
    expect(() => registerClient({ redirect_uris: ["https://sub.custom.example/cb"] })).not.toThrow();
  });

  it("falls back to default allowlist when env is empty string (docker-compose ${VAR:-} regression)", () => {
    process.env.OAUTH_REDIRECT_URI_HOSTS = "";
    expect(() => registerClient({ redirect_uris: ["https://claude.ai/cb"] })).not.toThrow();
  });

  it("falls back to default allowlist when env is whitespace only", () => {
    process.env.OAUTH_REDIRECT_URI_HOSTS = "   ";
    expect(() => registerClient({ redirect_uris: ["https://claude.ai/cb"] })).not.toThrow();
  });

  it("rejects claude.ai when not in the custom list", () => {
    expect(() => registerClient({ redirect_uris: ["https://claude.ai/callback"] }))
      .toThrow("redirect_uri hostname not allowed");
  });
});

// ─── Registration limit ────────────────────────────────────────────────────────

describe("registerClient registration cap", () => {
  const origMax = process.env.OAUTH_MAX_CLIENTS;

  beforeEach(() => {
    resetClients();
    process.env.OAUTH_MAX_CLIENTS = "2";
  });

  afterEach(() => {
    resetClients();
    if (origMax === undefined) {
      delete process.env.OAUTH_MAX_CLIENTS;
    } else {
      process.env.OAUTH_MAX_CLIENTS = origMax;
    }
  });

  it("registers clients up to the cap without error", () => {
    registerClient({ redirect_uris: ["https://claude.ai/cb1"] });
    registerClient({ redirect_uris: ["https://claude.ai/cb2"] });
  });

  it("throws RegistrationLimitError when cap is exceeded", () => {
    registerClient({ redirect_uris: ["https://claude.ai/cb1"] });
    registerClient({ redirect_uris: ["https://claude.ai/cb2"] });
    expect(() => registerClient({ redirect_uris: ["https://claude.ai/cb3"] }))
      .toThrow(RegistrationLimitError);
  });

  it("RegistrationLimitError message mentions the limit", () => {
    registerClient({ redirect_uris: ["https://claude.ai/cb1"] });
    registerClient({ redirect_uris: ["https://claude.ai/cb2"] });
    expect(() => registerClient({ redirect_uris: ["https://claude.ai/cb3"] }))
      .toThrow("max 2 clients");
  });
});

// ─── PKCE / OAuth 2.1 conformance ────────────────────────────────────────────

import { createHash } from "node:crypto";
describe("verifyPkce", () => {
  // Known-good S256 pair: verifier = "test-verifier-32chars-long-xyz123",
  // challenge = base64url(sha256(verifier)).
  const verifier = "test-verifier-32chars-long-xyz123";
  const challengeS256 = createHash("sha256").update(verifier).digest("base64url");

  it("accepts a matching S256 pair", () => {
    expect(verifyPkce(verifier, challengeS256, "S256")).toBe(true);
  });

  it("rejects a non-matching S256 pair", () => {
    expect(verifyPkce(verifier, "wrong-challenge", "S256")).toBe(false);
  });

  it("rejects `plain` even when verifier === challenge (defense-in-depth)", () => {
    expect(verifyPkce("same", "same", "plain")).toBe(false);
  });

  it("rejects an unknown method", () => {
    // @ts-expect-error — testing runtime defense for invalid method
    expect(verifyPkce(verifier, challengeS256, "MD5")).toBe(false);
  });
});

describe("authorizationServerMetadata PKCE conformance", () => {
  it("advertises only S256 in code_challenge_methods_supported", () => {
    const meta = authorizationServerMetadata("https://test.example");
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.code_challenge_methods_supported).not.toContain("plain");
  });
});

// ─── Confidential clients no longer supported ────────────────────────────────

describe("confidential clients no longer supported", () => {
  beforeEach(resetClients);
  afterEach(resetClients);

  it("registering with token_endpoint_auth_method=none succeeds and returns no client_secret", () => {
    const client = registerClient({
      redirect_uris: ["https://claude.ai/cb"],
      token_endpoint_auth_method: "none",
    });
    expect(client.client_id).toMatch(/^client_/);
    expect(client.token_endpoint_auth_method).toBe("none");
    expect((client as Record<string, unknown>).client_secret).toBeUndefined();
  });

  it("registering with no token_endpoint_auth_method defaults to none and succeeds", () => {
    const client = registerClient({ redirect_uris: ["https://claude.ai/cb"] });
    expect(client.token_endpoint_auth_method).toBe("none");
    expect((client as Record<string, unknown>).client_secret).toBeUndefined();
  });

  it("registering with token_endpoint_auth_method=client_secret_basic throws InvalidClientMetadataError", () => {
    expect(() =>
      registerClient({
        redirect_uris: ["https://claude.ai/cb"],
        token_endpoint_auth_method: "client_secret_basic",
      }),
    ).toThrow(InvalidClientMetadataError);
  });

  it("registering with client_secret_basic error message mentions only public clients", () => {
    expect(() =>
      registerClient({
        redirect_uris: ["https://claude.ai/cb"],
        token_endpoint_auth_method: "client_secret_basic",
      }),
    ).toThrow("only public clients");
  });

  it("registering with token_endpoint_auth_method=client_secret_post throws InvalidClientMetadataError", () => {
    expect(() =>
      registerClient({
        redirect_uris: ["https://claude.ai/cb"],
        token_endpoint_auth_method: "client_secret_post",
      }),
    ).toThrow(InvalidClientMetadataError);
  });

  it("authorizationServerMetadata advertises only none in token_endpoint_auth_methods_supported", () => {
    const meta = authorizationServerMetadata("https://test.example");
    expect(meta.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(meta.token_endpoint_auth_methods_supported).not.toContain("client_secret_basic");
    expect(meta.token_endpoint_auth_methods_supported).not.toContain("client_secret_post");
  });
});

// ─── isEmailAllowed ───────────────────────────────────────────────────────────

describe("isEmailAllowed", () => {
  const origEnv = process.env.OAUTH_ALLOWED_EMAILS;

  beforeEach(() => {
    delete process.env.OAUTH_ALLOWED_EMAILS;
  });

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.OAUTH_ALLOWED_EMAILS;
    } else {
      process.env.OAUTH_ALLOWED_EMAILS = origEnv;
    }
  });

  it("allows any email when env is unset", () => {
    expect(isEmailAllowed("anyone@example.com")).toBe(true);
  });

  it("allows any email when env is empty string (docker-compose ${VAR:-} regression)", () => {
    process.env.OAUTH_ALLOWED_EMAILS = "";
    expect(isEmailAllowed("anyone@example.com")).toBe(true);
  });

  it("allows any email when env is all whitespace", () => {
    process.env.OAUTH_ALLOWED_EMAILS = "   ";
    expect(isEmailAllowed("anyone@example.com")).toBe(true);
  });

  it("allows a matching literal email (case-insensitive stored)", () => {
    process.env.OAUTH_ALLOWED_EMAILS = "User@Example.Com";
    expect(isEmailAllowed("user@example.com")).toBe(true);
  });

  it("allows a matching literal email (case-insensitive compared)", () => {
    process.env.OAUTH_ALLOWED_EMAILS = "user@example.com";
    expect(isEmailAllowed("User@Example.Com")).toBe(true);
  });

  it("rejects a non-matching literal email", () => {
    process.env.OAUTH_ALLOWED_EMAILS = "user@example.com";
    expect(isEmailAllowed("other@example.com")).toBe(false);
  });

  it("wildcard *@example.com matches user@example.com", () => {
    process.env.OAUTH_ALLOWED_EMAILS = "*@example.com";
    expect(isEmailAllowed("user@example.com")).toBe(true);
  });

  it("wildcard *@example.com matches anything@example.com", () => {
    process.env.OAUTH_ALLOWED_EMAILS = "*@example.com";
    expect(isEmailAllowed("anything@example.com")).toBe(true);
  });

  it("wildcard *@example.com rejects steve@otherdomain.com", () => {
    process.env.OAUTH_ALLOWED_EMAILS = "*@example.com";
    expect(isEmailAllowed("steve@otherdomain.com")).toBe(false);
  });

  it("wildcard *@example.com does NOT match subdomain steve@mail.example.com", () => {
    process.env.OAUTH_ALLOWED_EMAILS = "*@example.com";
    expect(isEmailAllowed("steve@mail.example.com")).toBe(false);
  });

  it("mixed list works for a literal email", () => {
    process.env.OAUTH_ALLOWED_EMAILS = "user@example.com, *@example.com";
    expect(isEmailAllowed("user@example.com")).toBe(true);
  });

  it("mixed list works for a wildcard match", () => {
    process.env.OAUTH_ALLOWED_EMAILS = "user@example.com, *@example.com";
    expect(isEmailAllowed("anyone@example.com")).toBe(true);
  });

  it("mixed list rejects an email matching neither entry", () => {
    process.env.OAUTH_ALLOWED_EMAILS = "user@example.com, *@example.com";
    expect(isEmailAllowed("other@other.com")).toBe(false);
  });

  it("tolerates surrounding whitespace on entries", () => {
    process.env.OAUTH_ALLOWED_EMAILS = "  user@example.com ,  *@example.com  ";
    expect(isEmailAllowed("user@example.com")).toBe(true);
    expect(isEmailAllowed("foo@example.com")).toBe(true);
  });

  it("skips malformed entry with no @ but still matches valid entries", () => {
    process.env.OAUTH_ALLOWED_EMAILS = "not-an-email, user@example.com";
    expect(isEmailAllowed("user@example.com")).toBe(true);
    expect(isEmailAllowed("other@example.com")).toBe(false);
  });

  it("falls back to allow-any when all entries are malformed", () => {
    process.env.OAUTH_ALLOWED_EMAILS = "not-an-email, also-bad";
    expect(isEmailAllowed("anyone@anywhere.com")).toBe(true);
  });

  it("console.warn fires exactly once per unique malformed entry (dedupe)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // First unique malformed entry — should warn once across two calls.
      process.env.OAUTH_ALLOWED_EMAILS = "dedupe-test-malformed-1";
      isEmailAllowed("foo@bar.com");
      isEmailAllowed("foo@bar.com");
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // Second unique malformed entry — dedupe is per-entry, so one more warn.
      process.env.OAUTH_ALLOWED_EMAILS = "dedupe-test-malformed-2@@bad";
      isEmailAllowed("foo@bar.com");
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
