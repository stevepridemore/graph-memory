#!/usr/bin/env bash
# Container entrypoint. Two first-run setup tasks, then exec's the MCP server:
#
#  1. Seed the host-mounted data dir with canonical prompts (idempotent —
#     skipped if ~/graph-memory/prompts/ already exists).
#  2. Generate a self-signed TLS cert at ~/graph-memory/certs/ if the server
#     was configured to use TLS (env TLS_CERT + TLS_KEY) but the files
#     aren't there yet. The MCP server reads these synchronously and crashes
#     hard if they're missing, so a fresh install otherwise fails to boot.
#
# To pick up updated prompts after upgrading the image, delete or move
# ~/graph-memory/prompts/ on the host before restarting. To rotate the
# self-signed cert, delete ~/graph-memory/certs/.

set -euo pipefail

DATA_PROMPTS=/root/graph-memory/prompts
BAKED_PROMPTS=/app/prompts

if [ -d "$BAKED_PROMPTS" ] && [ ! -d "$DATA_PROMPTS" ]; then
  echo "[entrypoint] seeding $DATA_PROMPTS from $BAKED_PROMPTS"
  mkdir -p "$(dirname "$DATA_PROMPTS")"
  cp -r "$BAKED_PROMPTS" "$DATA_PROMPTS"
fi

# Self-signed TLS cert for the HTTP/MCP transport. Only generate if TLS_CERT
# is set (the server is asking for TLS) and the file doesn't exist yet. For
# Cloudflare Tunnel deployments the tunnel terminates TLS — but the upstream
# (this server) still listens on HTTPS, so the cert is required either way.
if [ -n "${TLS_CERT:-}" ] && [ ! -f "$TLS_CERT" ]; then
  CERT_DIR="$(dirname "$TLS_CERT")"
  KEY_FILE="${TLS_KEY:-${CERT_DIR}/server.key}"
  echo "[entrypoint] generating self-signed TLS cert at $TLS_CERT"
  mkdir -p "$CERT_DIR"
  # 10-year self-signed cert with SAN for localhost — Cloudflare Tunnel
  # doesn't validate the upstream cert, so SAN coverage doesn't matter
  # operationally, but localhost is the smallest reasonable default.
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$KEY_FILE" \
    -out "$TLS_CERT" \
    -days 3650 \
    -subj "/CN=graph-memory-mcp" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
    >/dev/null 2>&1
  chmod 600 "$KEY_FILE" "$TLS_CERT"
  echo "[entrypoint] cert generated ($(openssl x509 -in "$TLS_CERT" -noout -enddate))"
fi

exec "$@"
