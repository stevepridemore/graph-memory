FROM node:22-bookworm-slim

# Debian-slim is required (not alpine) because onnxruntime-node — used by
# @huggingface/transformers for the embedding model — only ships glibc binaries.
# Image grows ~50MB vs alpine but local embeddings work out of the box.

WORKDIR /app

# wget for healthcheck, ca-certificates for HTTPS model download from huggingface.co
RUN apt-get update && apt-get install -y --no-install-recommends \
      wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Pre-built JavaScript (run `npm run build` before `docker compose build`)
COPY dist/ ./dist/
COPY schema/ ./schema/

ENV MCP_TRANSPORT=http
ENV MCP_PORT=3847

EXPOSE 3847

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD wget -qO- --no-check-certificate https://127.0.0.1:3847/health || exit 1

CMD ["node", "dist/mcp-server/index.js"]
