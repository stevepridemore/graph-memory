#!/usr/bin/env bash
set -euo pipefail

CONTAINER=graph-memory-test-neo4j
PORT=7689

# Idempotent: remove any leftover container from a previous run.
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "[test-with-neo4j] Removing existing container: ${CONTAINER}"
  docker rm -f "${CONTAINER}" >/dev/null
fi

# Spin up throwaway Neo4j.
echo "[test-with-neo4j] Starting Neo4j on port ${PORT}..."
docker run -d --name "${CONTAINER}" --rm \
  -p "${PORT}:7687" \
  -e NEO4J_AUTH=neo4j/test1234 \
  -e 'NEO4J_PLUGINS=["apoc"]' \
  neo4j:5.20-community >/dev/null

# Guarantee teardown on any exit (success, failure, Ctrl-C).
cleanup() {
  echo "[test-with-neo4j] Tearing down container: ${CONTAINER}"
  docker stop "${CONTAINER}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Wait for Neo4j to accept connections (max 60 s).
echo "[test-with-neo4j] Waiting for Neo4j to be ready..."
ELAPSED=0
until docker exec "${CONTAINER}" cypher-shell -u neo4j -p test1234 "RETURN 1;" >/dev/null 2>&1; do
  if [ "${ELAPSED}" -ge 60 ]; then
    echo "[test-with-neo4j] ERROR: Neo4j did not become ready within 60 s." >&2
    exit 1
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done
echo "[test-with-neo4j] Neo4j is ready."

# Export test credentials.
export NEO4J_URI="bolt://localhost:${PORT}"
export NEO4J_USER=neo4j
export NEO4J_PASSWORD=test1234

# Run vitest, forwarding all arguments (e.g. --coverage).
EXIT_CODE=0
npx vitest run "$@" || EXIT_CODE=$?

exit "${EXIT_CODE}"
