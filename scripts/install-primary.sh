#!/usr/bin/env bash
# graph-memory primary-device installer.
#
# Sets up graph-memory on this machine as the "primary device" — the one that
# runs the Neo4j + MCP Docker containers and (optionally) the nightly dream
# and weekly maintenance scheduled tasks. No git clone, no Node.js, no build
# step needed — pulls pre-built artifacts from the GitHub release.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/stevepridemore/graph-memory/<version>/scripts/install-primary.sh \
#     | bash -s <version>
#
# Example:
#   curl -fsSL https://raw.githubusercontent.com/stevepridemore/graph-memory/v0.3.0/scripts/install-primary.sh \
#     | bash -s v0.3.0
#
# Then: edit ~/graph-memory/.env, cd ~/graph-memory, docker compose up -d.

set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "usage: install-primary.sh <version>   (e.g. v0.3.0 or 'latest' for main)" >&2
  exit 2
fi

REPO="stevepridemore/graph-memory"
RAW="https://raw.githubusercontent.com/$REPO/$VERSION"

# Resolve $VERSION to the right tarball URL. Tags (v*) come from refs/tags;
# 'latest' resolves to refs/heads/main; anything else is assumed to be a
# branch name. This makes pre-release dogfooding on a branch work without
# any further config.
case "$VERSION" in
  v*)
    TARBALL="https://github.com/$REPO/archive/refs/tags/$VERSION.tar.gz"
    TARBALL_PREFIX="graph-memory-${VERSION#v}"
    ;;
  latest)
    TARBALL="https://github.com/$REPO/archive/refs/heads/main.tar.gz"
    TARBALL_PREFIX="graph-memory-main"
    ;;
  *)
    TARBALL="https://github.com/$REPO/archive/refs/heads/$VERSION.tar.gz"
    TARBALL_PREFIX="graph-memory-$VERSION"
    ;;
esac

echo "[install-primary] graph-memory $VERSION"

# 0. Pre-flight: Docker must be installed and the daemon must be running.
#    Without it, `docker compose up` later will fail with a less helpful error.
if ! command -v docker >/dev/null 2>&1; then
  cat >&2 <<EOF

[install-primary] ERROR: docker is not installed on this device.

  graph-memory runs Neo4j + the MCP server as Docker containers. Install
  Docker for your platform first:

    Linux:   https://docs.docker.com/engine/install/ (Docker Engine)
    macOS:   https://www.docker.com/products/docker-desktop/ (Docker Desktop)
    Windows: https://www.docker.com/products/docker-desktop/ (Docker Desktop)
             (or run the PowerShell installer: scripts/install-primary.ps1)

  Then re-run this installer.
EOF
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  cat >&2 <<EOF

[install-primary] ERROR: Docker is installed but the daemon is not running.

  - macOS / Windows: start Docker Desktop and wait for the green indicator.
  - Linux:           sudo systemctl start docker
                     (and consider sudo systemctl enable docker)

  Then re-run this installer.
EOF
  exit 1
fi
echo "[install-primary] docker: OK"

# 1. Data directory + compose + env template
DATA_DIR="$HOME/graph-memory"
mkdir -p "$DATA_DIR"
echo "[install-primary] data dir: $DATA_DIR"

curl -fsSL "$RAW/docker-compose.yml" -o "$DATA_DIR/docker-compose.yml"
echo "[install-primary] wrote $DATA_DIR/docker-compose.yml"

if [ ! -f "$DATA_DIR/.env" ]; then
  curl -fsSL "$RAW/.env.example" -o "$DATA_DIR/.env"
  echo "[install-primary] wrote $DATA_DIR/.env (TEMPLATE — edit before starting)"
else
  echo "[install-primary] kept existing $DATA_DIR/.env"
fi

# 2. Slash commands (vendored under skills/ in the repo, extracted into ~/.claude/skills/)
mkdir -p "$HOME/.claude/skills"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$TARBALL" -o "$TMP/repo.tar.gz"
tar -xzf "$TMP/repo.tar.gz" -C "$TMP"
SRC_SKILLS="$TMP/$TARBALL_PREFIX/skills"
if [ -d "$SRC_SKILLS" ]; then
  cp -r "$SRC_SKILLS"/* "$HOME/.claude/skills/"
  echo "[install-primary] installed slash commands to ~/.claude/skills/ ($(ls "$SRC_SKILLS" | wc -l) skills)"
else
  echo "[install-primary] WARNING: skills/ not found in tarball; skipping slash commands" >&2
fi

# 3. MCP client config (stdio mode talking to the local docker container)
mkdir -p "$HOME/.claude"
if [ ! -f "$HOME/.claude/.mcp.json" ]; then
  curl -fsSL "$RAW/.mcp.json.example" -o "$HOME/.claude/.mcp.json"
  echo "[install-primary] wrote ~/.claude/.mcp.json (stdio to graph-memory-mcp container)"
else
  echo "[install-primary] kept existing ~/.claude/.mcp.json"
fi

cat <<EOF

[install-primary] next steps:

  1. Edit $DATA_DIR/.env:
       - NEO4J_PASSWORD (≥8 chars)
       - GRAPH_MEMORY_HOME (absolute path; use $DATA_DIR on Linux/macOS, or
         C:\\Users\\you\\graph-memory on Windows)
       - CLAUDE_PROJECTS_DIR (absolute path to your ~/.claude/projects)

  2. Start the containers:
       cd $DATA_DIR && docker compose up -d

  3. (Optional) Install scheduled tasks for nightly dream + weekly maintenance.
     Run this AFTER the containers are up:
       docker exec graph-memory-mcp python3 /app/scripts/sync-dream-skill.py \\
         --user-home /root --prompts-dir /root/graph-memory/prompts
     Then on the host, point the resulting SKILL.md files at your home dir
     (the docker exec writes inside the container; you'll need to re-run with
     --user-home set to your actual host home to get the right substitutions).

  4. In any Claude Code session, run /graph-stats to verify.

  For multi-device access (claude.ai web, secondary laptops): see docs/REMOTE.md
  for the optional Cloudflare Tunnel setup. Without it, this install is
  local-only — accessible only from this device.
EOF
