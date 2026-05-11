# ---- Build stage: compile TypeScript ---------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /build

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

# ---- Runtime stage ---------------------------------------------------------
FROM node:22-bookworm-slim

# Debian-slim is required (not alpine) because onnxruntime-node — used by
# @huggingface/transformers for the embedding model — only ships glibc binaries.
# Image grows ~50MB vs alpine but local embeddings work out of the box.

WORKDIR /app

# wget for healthcheck, ca-certificates for HTTPS model download from huggingface.co,
# python3 for the prompt/skill path-substitution helper that the install script runs,
# openssl for self-signed TLS cert generation on first run (see docker/entrypoint.sh).
RUN apt-get update && apt-get install -y --no-install-recommends \
      wget ca-certificates python3 openssl \
    && rm -rf /var/lib/apt/lists/*

# Production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled JavaScript from the build stage
COPY --from=build /build/dist ./dist
COPY schema/ ./schema/

# Canonical prompts and helper scripts. The entrypoint copies prompts/ out to
# the host-mounted /root/graph-memory/prompts/ on first start so the user's
# scheduled tasks can read them from a stable host path.
COPY prompts/ ./prompts/
COPY scripts/sync-dream-skill.py ./scripts/sync-dream-skill.py

# Entrypoint shim: seeds the host data dir on first run, then exec's the
# server. Always runs (idempotent — no-op if the target already exists).
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV MCP_TRANSPORT=http
ENV MCP_PORT=3847

EXPOSE 3847

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD wget -qO- --no-check-certificate https://127.0.0.1:3847/health || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/mcp-server/index.js"]
