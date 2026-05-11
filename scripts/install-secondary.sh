#!/usr/bin/env bash
# graph-memory secondary-device installer.
#
# Sets up this device as a "secondary" — uses the graph remotely through the
# primary device's Cloudflare Tunnel. No Docker, no Neo4j, no source clone.
# Just installs the slash commands and writes an MCP client config pointed at
# the tunnel URL.
#
# The primary device must already have:
#   - graph-memory running (see install-primary.sh)
#   - Cloudflare Tunnel + OAuth set up per docs/REMOTE.md
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/stevepridemore/graph-memory/<version>/scripts/install-secondary.sh \
#     | bash -s <version> <tunnel-host>
#
# Example:
#   curl -fsSL https://raw.githubusercontent.com/stevepridemore/graph-memory/v0.3.0/scripts/install-secondary.sh \
#     | bash -s v0.3.0 graph.example.com

set -euo pipefail

VERSION="${1:-}"
HOST="${2:-}"
if [ -z "$VERSION" ] || [ -z "$HOST" ]; then
  echo "usage: install-secondary.sh <version> <tunnel-host>" >&2
  echo "  e.g.: install-secondary.sh v0.3.0 graph.example.com" >&2
  exit 2
fi

REPO="stevepridemore/graph-memory"
RAW="https://raw.githubusercontent.com/$REPO/$VERSION"
TARBALL="https://github.com/$REPO/archive/refs/tags/$VERSION.tar.gz"
if [ "$VERSION" = "latest" ]; then
  TARBALL="https://github.com/$REPO/archive/refs/heads/main.tar.gz"
  TARBALL_PREFIX="graph-memory-main"
else
  TARBALL_PREFIX="graph-memory-${VERSION#v}"
fi

echo "[install-secondary] graph-memory $VERSION → $HOST"

# 1. Slash commands
mkdir -p "$HOME/.claude/skills"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$TARBALL" -o "$TMP/repo.tar.gz"
tar -xzf "$TMP/repo.tar.gz" -C "$TMP"
SRC_SKILLS="$TMP/$TARBALL_PREFIX/skills"
if [ -d "$SRC_SKILLS" ]; then
  cp -r "$SRC_SKILLS"/* "$HOME/.claude/skills/"
  echo "[install-secondary] installed slash commands to ~/.claude/skills/ ($(ls "$SRC_SKILLS" | wc -l) skills)"
else
  echo "[install-secondary] WARNING: skills/ not found in tarball" >&2
fi

# 2. MCP client config — point at the primary's tunnel host
mkdir -p "$HOME/.claude"
if [ -f "$HOME/.claude/.mcp.json" ]; then
  BACKUP="$HOME/.claude/.mcp.json.bak-$(date +%s)"
  cp "$HOME/.claude/.mcp.json" "$BACKUP"
  echo "[install-secondary] existing .mcp.json backed up to $BACKUP"
fi
curl -fsSL "$RAW/.mcp.json.remote.example" \
  | sed "s|your-host.example|$HOST|g" \
  > "$HOME/.claude/.mcp.json"
echo "[install-secondary] wrote ~/.claude/.mcp.json (HTTP+OAuth → https://$HOST/mcp)"

cat <<EOF

[install-secondary] done.

  In any Claude Code session, run /graph-stats. The first call will open
  your browser to complete the OAuth flow with Cloudflare Access. After
  that, the bearer token is cached and subsequent calls are silent.

  Troubleshooting:
    - If the OAuth flow fails, check that the primary device's tunnel is
      up and that your account is in OAUTH_ALLOWED_EMAILS (if set) on the
      primary's .env.
    - If /graph-stats returns "no MCP server registered", confirm
      ~/.claude/.mcp.json was written and Claude Code has reloaded.
EOF
