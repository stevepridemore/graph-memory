# Remote / claude.ai access

This guide walks through exposing graph-memory to the **claude.ai web interface** as a remote MCP connector. The architecture keeps the Docker container at home (no new hosting bill) and uses Cloudflare Tunnel + Cloudflare Access for a public hostname, real TLS, and OAuth/OIDC authentication.

```
claude.ai web UI
   │  OIDC handshake → access token
   ▼
Cloudflare Edge (your hostname)
   ├── Cloudflare Access (OIDC IdP "SaaS application")
   │      ↳ user authenticates via Google / GitHub / email OTP
   │      ↳ Access issues JWT in Cf-Access-Jwt-Assertion header
   ▼
Cloudflare Tunnel
   │  encrypted outbound from cloudflared on the home machine
   ▼
graph-memory-mcp Docker container, port 3847
   ├── verifies JWT signature against team JWKS
   ├── extracts user email → tenant_id
   └── all reads/writes filter / set by tenant_id
```

## Prerequisites

- A Cloudflare account (free tier is fine).
- A domain on Cloudflare (or use a free Cloudflare-provided `*.cfargotunnel.com` hostname for testing).
- The graph-memory Docker container already running at home.
- An identity provider for Cloudflare Access — Google, GitHub, or one-time PIN over email work for personal use.

## Phase 1 — Public reachability via Cloudflare Tunnel

1. **Install cloudflared** on the host machine running the graph-memory container.
   - Windows: `winget install --id Cloudflare.cloudflared`
   - macOS: `brew install cloudflared`
   - Linux: see [Cloudflare's downloads page](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).

2. **Authenticate cloudflared** with your Cloudflare account:
   ```
   cloudflared tunnel login
   ```

3. **Create the tunnel:**
   ```
   cloudflared tunnel create graph-memory
   ```
   This prints a tunnel UUID — note it.

4. **Configure DNS.** Pick a hostname (e.g. `graph-memory.your-domain.com`) and route it to the tunnel:
   ```
   cloudflared tunnel route dns graph-memory graph-memory.your-domain.com
   ```

5. **Configure the tunnel** in `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: <UUID from step 3>
   credentials-file: ~/.cloudflared/<UUID>.json

   ingress:
     - hostname: graph-memory.your-domain.com
       service: https://localhost:3847
       originRequest:
         noTLSVerify: true   # the container uses a self-signed cert
     - service: http_status:404
   ```

   Or, for simplicity, drop the self-signed cert and serve plain HTTP behind the tunnel — Cloudflare terminates TLS at the edge anyway:
   ```yaml
   ingress:
     - hostname: graph-memory.your-domain.com
       service: http://localhost:3847
     - service: http_status:404
   ```
   (To do this, comment out the `TLS_CERT` / `TLS_KEY` env vars in `docker-compose.yml`.)

6. **Run the tunnel:**
   ```
   cloudflared tunnel run graph-memory
   ```
   For production, register it as a Windows service / systemd unit so it restarts with the machine.

7. **Verify** from an external network (mobile data, VPN, etc.):
   ```
   curl https://graph-memory.your-domain.com/health
   ```
   Should return `{"status":"ok","transport":"https"}` with a real Cloudflare-issued cert.

## Phase 2 — Authentication via Cloudflare Access

### Configure Access

1. In the Cloudflare dashboard: **Zero Trust → Access → Applications → Add application → Self-hosted**.

2. Set up the application:
   - **Application name:** `graph-memory`
   - **Session duration:** 24 hours (or whatever you prefer)
   - **Application domain:** `graph-memory.your-domain.com`
   - **Identity providers:** add Google, GitHub, or "One-time PIN" (email).

3. Create an Access policy:
   - **Policy name:** `graph-memory-allowed-users`
   - **Action:** Allow
   - **Include:** Emails: list specific email addresses (e.g. `your.email@gmail.com`)

   This is your tenant allowlist — every email here becomes an isolated tenant in the graph.

4. **Save and test.** Visit `https://graph-memory.your-domain.com/health` in a browser. You should be redirected to a Cloudflare Access login page; after auth, you should see `{"status":"ok"}`.

### Find your audience claim

The Cloudflare-issued JWT carries an `aud` claim that the MCP server validates. Get it from:

**Zero Trust → Access → Applications → graph-memory → Application Audience tag**

It's a 64-char hex string. Copy it.

### Configure the MCP server to verify JWTs

Update your `.env` (or create one if missing):

```env
# Neo4j — local docker-compose service
NEO4J_URI=bolt://neo4j:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=<your-neo4j-password>

# Multi-tenant identity
BOOTSTRAP_TENANT_ID=your.email@gmail.com   # the tenant your existing graph belongs to
LOCAL_TENANT_ID=your.email@gmail.com       # tenant for stdio (Claude Code / Desktop)
TENANT_ID_SOURCE=oauth                     # production mode: bearer tokens issued by /oauth/token
CF_ACCESS_TEAM_DOMAIN=your-team.cloudflareaccess.com
CF_ACCESS_AUD=64charhexaudienceclaim...
```

**Important:** before flipping `TENANT_ID_SOURCE` from `static` to `cf-access`, set `BOOTSTRAP_TENANT_ID` to your email **and** restart the container. The startup migration uses this value to backfill the existing graph onto your tenant. After migration, your existing 300+ entities live under your email tenant.

Restart from your local clone:
```
cd <your-graph-memory-clone>
docker compose up -d
```

Two log files in `~/graph-memory/logs/` cover the production deployment:

```
tail -f ~/graph-memory/logs/mcp-access.jsonl     # one line per /mcp request
tail -f ~/graph-memory/logs/oauth-events.jsonl   # one line per OAuth event
```

`mcp-access.jsonl` records `tenant_id`, `method`, `path`, and `identity_source` for every authenticated `/mcp` call.

`oauth-events.jsonl` records every OAuth-relevant event: `register` / `register_fail`, `authorize_ok` / `authorize_fail`, `token_issue` / `token_refresh` / `token_consume_fail` / `token_pkce_fail` / `token_refresh_fail`, `client_deregistered`, `revoke_ok` / `revoke_noop`, and `bearer_verify_fail`. Each carries `client_id`, `email`, `jti`, `redirect_uri_host`, `reason`, and `source_ip` as applicable. Both logs are best-effort and never throw from the request path.

### Register the connector in claude.ai

1. In claude.ai: **Settings → Connectors → Add custom connector**.
2. **Name:** Graph Memory
3. **MCP server URL:** `https://graph-memory.your-domain.com/mcp`
4. **Authentication:** OAuth (claude.ai will discover the Cloudflare Access OIDC endpoints automatically when you click "Connect").
5. Complete the OAuth flow — claude.ai redirects to Cloudflare Access, you sign in with your IdP, Cloudflare issues a token, claude.ai stores it.
6. Test: in a new claude.ai conversation, ask Claude to call `graph_stats`. It should return your tenant's actual node/edge counts.

## Adding more users

1. **Cloudflare dashboard → Access → Applications → graph-memory → Policies → Edit allowlist** — add the new user's email.
2. The user goes to claude.ai, adds the same custom connector, completes OAuth.
3. On their first tool call, the MCP server creates entities under their email tenant. They start with an empty graph.
4. They cannot see your data; you cannot see theirs. See [`docs/MULTI_TENANT.md`](MULTI_TENANT.md) for the data model.

## Update 2026-05-06: OAuth 2.1 in the server, claude.ai web compatible

The original setup put Cloudflare Access in front of every path and let CF
Access handle OAuth-ish things. That works for browsers but **does not work
for claude.ai's web connector** — claude.ai expects RFC 9728 / RFC 8414
metadata and a `WWW-Authenticate: Bearer ...` challenge, not a 302 redirect
to a browser login page.

The fix: graph-memory now implements OAuth 2.1 itself. CF Access still does
the actual user authentication, but only on one path (`/oauth/authorize`).
Everything else uses bearer tokens that we sign.

### What changed in the code

| Path | Before | After |
|---|---|---|
| `/.well-known/oauth-authorization-server` | not implemented | public, returns metadata |
| `/.well-known/oauth-protected-resource` | not implemented | public, returns metadata (RFC 9728) |
| `/oauth/register` | not implemented | public, dynamic client registration (RFC 7591) |
| `/oauth/authorize` | not implemented | gated by CF Access; reads JWT, issues code, redirects |
| `/oauth/token` | not implemented | public, exchanges code (or refresh) for bearer JWT |
| `/oauth/jwks` | not implemented | public, serves our public key |
| `/oauth/revoke` | not implemented | public, RFC 7009 token revocation |
| `/mcp` | gated by CF Access (cookie or Cf-Access-Jwt-Assertion) | gated by Authorization: Bearer (our JWT) |
| 401 response | `Cf-Access-Jwt-Assertion` scheme (non-standard) | `Bearer realm="..." resource_metadata="..."` (RFC 9728) |

The `TENANT_ID_SOURCE` env var gains a new mode `oauth` (now default for the
HTTPS transport). Stdio transport (Claude Code, Claude Desktop on this
machine via `docker exec`) still uses `LOCAL_TENANT_ID` — unaffected.

### Cloudflare Access policy: required path-level bypass list

CF Access in its default config gates every path of the application. With
this update, only `/oauth/authorize` should still be gated. **Add these
bypass paths to the Application's policy** (Zero Trust → Access → Applications →
graph-memory → Edit → Policies):

Create a new policy named **"Public OAuth + MCP endpoints"** with:
- **Action:** Bypass
- **Include rule:** Everyone
- **Configure rules → Path-based bypass** (or use Application path settings):
  - `/.well-known/oauth-authorization-server`
  - `/.well-known/oauth-protected-resource`
  - `/.well-known/openid-configuration`
  - `/.well-known/jwks.json`
  - `/oauth/register`
  - `/oauth/token`
  - `/oauth/revoke`
  - `/oauth/jwks`
  - `/mcp`
  - `/health`

Keep the existing **"Allow `<your-email>`"** policy in place — it still
protects `/oauth/authorize`, which is the one URL the user's browser must
reach during the connect flow.

If your Access dashboard doesn't expose path-level bypass rules directly,
the alternative is to create **two separate Access Applications**:
1. `your-host.example/oauth/authorize` → policy: Allow your email
2. `your-host.example/*` (everything else) → no Access policy
   (or a Bypass-Everyone policy)

### Connecting claude.ai (web)

Once the bypass list is in place:

1. Open `claude.ai/settings/connectors`
2. Click **Add custom connector**
3. **Name:** Graph-Memory (or anything)
4. **URL:** `https://your-host.example/mcp`
5. Click **Add**
6. The connector enters the OAuth flow:
   - claude.ai POSTs to `/oauth/register` and stores the returned client_id
   - claude.ai opens a browser tab to `/oauth/authorize?...`
   - CF Access intercepts (the only gated path) → user sees CF login if not
     already logged in → CF passes the user through with Cf-Access-Jwt-Assertion
   - Our server reads the JWT, generates an auth code, redirects to claude.ai
   - claude.ai exchanges the code at `/oauth/token` and gets back a bearer JWT
7. Status flips from "Configure" to "Connected" — graph tools available in
   any conversation.

### Token signing keys

On first startup the server generates an RSA keypair under
`~/graph-memory/oauth/`:
- `private.pem` — used to sign tokens (mode 0600)
- `public.pem` — used to verify tokens, also exposed via `/oauth/jwks`

The keys persist across container rebuilds because they live in the
mounted data volume. If you rotate them, every existing claude.ai bearer
token becomes invalid and clients have to re-authorize. To rotate, delete
both files and restart; new keys are generated and the JWKS kid changes.

### Token lifetimes, revocation, and PKCE

- **Access tokens** live 1 hour. **Refresh tokens** live 30 days. Each
  carries a unique `jti` claim so individual tokens can be revoked
  without rotating the signing key.
- **`POST /oauth/revoke`** (RFC 7009) revokes a single access or refresh
  token. Pass the token in the `token` form field; per RFC 7009 the
  endpoint always responds 200 regardless of whether the token was known.
  The revocation deny-list lives at `~/graph-memory/oauth/revoked.json`
  and self-prunes entries past their original `exp`.
- **PKCE-S256 is required** for any client registered with
  `token_endpoint_auth_method: "none"` (i.e., public clients including
  the claude.ai connector). Discovery metadata advertises `["S256"]` only;
  `code_challenge_method=plain` is rejected. Existing claude.ai connector
  clients send S256 by default — no flow change.

## Dynamic client registration security

### Public clients only

Only public clients (`token_endpoint_auth_method: "none"`) are supported. Confidential clients (those that authenticate with a `client_secret`) are not — registration with `client_secret_basic` or `client_secret_post` is rejected with `400 invalid_client_metadata`. Discovery metadata advertises `["none"]` only.

All real clients (claude.ai web, Claude Desktop, Claude Code) use PKCE + `token_endpoint_auth_method: "none"`, which is the only supported mode.

### Future enhancements: server-to-server / machine-to-machine clients

**Server-to-server / machine-to-machine clients are intentionally out of scope.** To support them in the future, three coherent additions are needed together:

1. Implement `grant_type=client_credentials` at `/oauth/token`.
2. Reintroduce confidential clients with `client_secret` stored as a salted SHA-256 hash (per-client salt, `timingSafeEqual` verification).
3. Re-advertise `client_secret_basic`/`client_secret_post` in discovery metadata.

Doing these together keeps the implementation honest with the metadata. See git history for `oauth.ts` and the threat model finding I-1 for context.

### redirect_uri hostname allowlist

`POST /oauth/register` validates each `redirect_uri` against a hostname allowlist. Only URIs whose hostname matches the allowlist are accepted; everything else returns `400 invalid_client_metadata`. This prevents the OAuth phishing chain where an attacker registers `https://attacker.example/cb`, tricks the operator into visiting a crafted `/oauth/authorize` URL on the legitimate hostname, and receives the auth code.

The default allowlist covers the known legitimate connectors:

| Pattern | Matches |
|---|---|
| `claude.ai` | Exact hostname |
| `*.claude.ai` | One-level subdomains, e.g. `connector.claude.ai` |
| `claude.com` | Exact hostname |
| `*.claude.com` | One-level subdomains |
| `localhost` | Local dev (`http://localhost`) |
| `127.0.0.1` | Local dev (`http://127.0.0.1`) |

To extend the allowlist (e.g. to add an internal connector), set the `OAUTH_REDIRECT_URI_HOSTS` env var to a comma-separated list of exact hostnames and/or `*.domain` patterns in `.env`:

```env
OAUTH_REDIRECT_URI_HOSTS=claude.ai,*.claude.ai,claude.com,*.claude.com,localhost,127.0.0.1,connector.internal.example
```

When `OAUTH_REDIRECT_URI_HOSTS` is unset the production defaults above apply.

### Email allowlist (`OAUTH_ALLOWED_EMAILS`)

As a second-layer guard on top of Cloudflare Access, you can restrict which verified identities are allowed to complete the OAuth flow:

```env
OAUTH_ALLOWED_EMAILS=user@example.com,*@example.org
```

Each entry is either an **exact email** (`user@example.com`) or a **domain wildcard** (`*@example.org`). Wildcard matching is strict: `*@example.org` matches `foo@example.org` but not `foo@mail.example.org` (no subdomain expansion). Matching is case-insensitive.

When `OAUTH_ALLOWED_EMAILS` is **unset or empty**, any identity that passes Cloudflare Access is allowed through — the existing behaviour is preserved.

The allowlist is re-evaluated on **every refresh-token grant** as well. This means removing an email from the list invalidates their ability to refresh within seconds rather than waiting up to 30 days for the refresh token to expire naturally.

Rejections are recorded in `oauth-events.jsonl` with `event: "authorize_fail"` or `event: "token_refresh_fail"` and `reason: "email_not_allowed"`.

### Client registration cap

To limit denial-of-service via unbounded client registrations, the server rejects `POST /oauth/register` with `429 too_many_requests` once the number of registered clients reaches `OAUTH_MAX_CLIENTS` (default 100). Raise this if you have many legitimate users:

```env
OAUTH_MAX_CLIENTS=500
```

### Edge-layer rate limiting (recommended)

As a second layer of defence, configure a rate rule on `POST /oauth/register` at the Cloudflare edge: **Zero Trust → WAF → Rate limiting rules**, for example 10 requests per minute per IP. This limits attacker throughput before requests reach the server.

## Deployment values to record

When you stand up your own instance, keep a private note of these values — useful for re-creating Cloudflare Access policies, debugging tunnel issues, or restoring from backup:

| Field | Where to find it |
|---|---|
| Public hostname | The CNAME you pointed at the tunnel |
| Tunnel name & UUID | `cloudflared tunnel list` |
| Cloudflare team domain | Zero Trust dashboard → Settings → Custom Pages |
| Access app AUD | Zero Trust dashboard → Access → Applications → your app |
| Bootstrap / admin tenant | The email you set as `BOOTSTRAP_TENANT_ID` in `.env` |

The team domain and AUD are public identifiers (they appear in JWT claims clients verify), not secrets. But `.cloudflared/<UUID>.json` (tunnel credentials) and `.env` (Neo4j password) must stay out of any committed git history.

Files on the host (under your user's home):
- `~/.cloudflared/cert.pem` — Cloudflare origin cert (zone authorization)
- `~/.cloudflared/<UUID>.json` — tunnel credentials (treat as secret)
- `~/.cloudflared/config.yml` — ingress config

## Windows service: known gotcha

`cloudflared service install` on Windows creates the service but **doesn't pass `tunnel run <name>`** to the binary, so the service starts and immediately exits. The fix: after `service install`, override `binPath` via `sc.exe`. Substitute your own home directory for the config path — `sc.exe` does not expand `%USERPROFILE%` at runtime, so the absolute path must be literal:

```powershell
# Replace C:\Users\<you> with your actual home directory
sc.exe config cloudflared binPath= "\"C:\Program Files (x86)\cloudflared\cloudflared.exe\" --config \"C:\Users\<you>\.cloudflared\config.yml\" tunnel run graph-memory"
```

Run this from an elevated PowerShell or via `Start-Process -Verb RunAs`. The service will then launch cloudflared with the right arguments on every reboot.

A second gotcha: `Stop-Service cloudflared` hangs indefinitely with open QUIC connections. To restart cleanly, force-kill the process:
```powershell
taskkill /F /PID <cloudflared pid>   # requires admin
Start-Service cloudflared
```

## Operational notes

- **Embedding model concurrency:** the local embedding model is a singleton in the Node process. Concurrent semantic-search calls from multiple users serialize through it. ~10 ms per query — fine for personal scale; revisit if you ever have many simultaneous active users.
- **Rate limiting:** Cloudflare Access has built-in WAF / rate rules. Configure per-IP or per-policy in the dashboard if abuse becomes a concern.
- **Uptime:** the home machine must be awake for the tunnel to work. Cloudflare buffers some traffic but won't replay MCP requests. Enable Windows "Keep computer awake" or run on a small always-on machine.
- **Backups:** `graph_export` produces tenant-scoped JSONL backups via the `/graph-backup` skill. Each tenant gets their own export; admins (the bootstrap tenant) can also re-embed across all tenants via `graph_reembed`.
- **TLS_CERT / TLS_KEY:** kept in `docker-compose.yml` as a fallback for direct-access scenarios (e.g. you want to bypass the tunnel from inside your home network). Optional — when fronted by Cloudflare Tunnel, plain HTTP behind the tunnel is fine.

## Multi-PC transcript sharing

The OAuth setup above lets multiple devices reach one MCP server. There's a separate concern if you use **Claude Code** on more than one machine, and it's worth understanding why.

### Why this matters

The dream process is a Claude Code session that runs on a single machine and reads transcripts from that machine's local `~/.claude/projects/`. Claude Code on a *different* machine writes its transcripts to *that* machine's local `~/.claude/projects/` — completely invisible to the dream.

The MCP server stays consistent across machines (every client hits the same graph regardless of which PC it's running on), but transcript extraction only sees what's local to the dream-running machine. So queries you ran on the office PC, decisions you made on the laptop, conversations on the home PC — only the home PC's get extracted into the graph by the home PC's dream. The rest are lost to extraction unless you take action.

If you only ever use Claude Code on one machine, this doesn't apply — skip the rest of this section.

### The principle

If you use Claude Code on multiple PCs and want one consolidated graph, **share `~/.claude/projects/` between the machines**. The project doesn't prescribe a sync tool — OneDrive, Dropbox, Syncthing, Google Drive, iCloud, NFS, scheduled `rsync` over Tailscale all work. Two patterns:

1. Use a directory junction (`mklink /J` on Windows, `ln -s` on Linux/macOS) on each PC pointing `~/.claude/projects/` at a shared synced location.
2. Configure your sync tool to mirror `~/.claude/projects/` directly, so every PC has its own copy that the tool keeps in sync.

Each Claude Code session writes a uniquely-named UUID transcript file, so simultaneous writes from multiple machines never collide. Per-PC project subdirectories (named after each machine's absolute project path) sit side-by-side in the merged tree, and the dream walks them all.

### Two gotchas worth knowing

1. **Active-file sync lag.** Claude Code keeps the JSONL open while a session is in progress; most sync tools defer upload until the file is idle for several seconds. The most recent few minutes of a live session may not have synced to other PCs yet. The nightly dream isn't affected — sessions have been closed for hours by then. If you trigger an ad-hoc dream during active work on another PC, mind this.
2. **Online-only placeholders.** Cloud sync tools (OneDrive, Dropbox, Google Drive) often default to space-saving placeholder files that download on access. The dream's `Read` calls expect real file content; placeholders can block or fail. Mark the synced directory as "always keep on this device" (or your tool's equivalent) to materialize all transcript files locally.

If your sync tool doesn't follow directory junctions transparently, point your `~/.claude/projects/` junction *at* the sync-watched directory rather than the other way around.

## Reverting to local-only

To roll back:

1. Set `TENANT_ID_SOURCE=static` in `.env`, restart container.
2. Stop `cloudflared`.
3. Optionally remove the Access application from the Cloudflare dashboard.

Your data is unaffected; you keep using Claude Code and Claude Desktop locally as before.
