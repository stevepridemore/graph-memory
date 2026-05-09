# Testing

Test suites live in `src/`:

| File | What it covers | Needs Neo4j? |
|---|---|---|
| `src/shared/oauth.test.ts` | Pure-logic unit tests for OAuth provider — token issuance/verification, revocation deny-list, redirect_uri host allowlist, registration cap, PKCE, email allowlist, public-clients-only enforcement | No |
| `src/shared/oauth-events.test.ts` | Structured-event log shape, IP-extraction precedence chain, throw-resilience | No |
| `src/mcp-server/read-body.test.ts` | Body-size cap (64 KB OAuth / 4 MB MCP), fast reject via `Content-Length`, streaming reject | No |
| `src/shared/neo4j-client.test.ts` | Integration tests for the Neo4j client — schema init, multi-tenant data ops, decay/bi-temporal/contradiction queries, `graph_merge`/`graph_unmerge` | **Yes** |

The full suite runs in ~10 seconds end-to-end against a fresh Neo4j. Test counts grow as new functionality lands; check the run output for the current totals.

## Running OAuth-only tests

No setup required:

```sh
npx vitest run src/shared/oauth.test.ts
```

These are pure unit tests, but a few exercise disk I/O against `~/graph-memory/oauth/clients.json` (because `src/shared/config.ts` hardcodes `GRAPH_MEMORY_HOME = homedir()/graph-memory`). Each disk-touching test cleans up via `beforeEach`/`afterEach`. If you've never run the production server on this machine, the directory will be created fresh.

## Running the full suite (with Neo4j)

The integration tests require a real Neo4j instance. **Don't point them at your live deployment** — they create and delete data inside a per-run `test-*` tenant, and a startup guard refuses to run if it sees any data outside that tenant. The recommended pattern is a throwaway Docker container on a non-production port.

### One-shot procedure (verified 2026-05-08)

#### POSIX shells (bash, zsh)

```sh
# 1. Spin up throwaway Neo4j on :7689 with APOC and test credentials.
docker run -d --name graph-memory-test-neo4j --rm \
  -p 7689:7687 \
  -e NEO4J_AUTH=neo4j/test1234 \
  -e NEO4J_PLUGINS='["apoc"]' \
  neo4j:5.20-community

# 2. Wait for it to accept connections.
until docker exec graph-memory-test-neo4j cypher-shell -u neo4j -p test1234 "RETURN 1;" >/dev/null 2>&1; do sleep 2; done

# 3. Run the full suite against it.
NEO4J_URI=bolt://localhost:7689 NEO4J_USER=neo4j NEO4J_PASSWORD=test1234 npx vitest run

# 4. Tear down. The --rm flag auto-cleans the container.
docker stop graph-memory-test-neo4j
```

#### Windows PowerShell

```powershell
# 1. Spin up throwaway Neo4j.
docker run -d --name graph-memory-test-neo4j --rm `
  -p 7689:7687 `
  -e NEO4J_AUTH=neo4j/test1234 `
  -e NEO4J_PLUGINS='["apoc"]' `
  neo4j:5.20-community

# 2. Wait for readiness.
do { Start-Sleep -Seconds 2 } until (docker exec graph-memory-test-neo4j cypher-shell -u neo4j -p test1234 "RETURN 1;" 2>$null)

# 3. Run with env set inline.
$env:NEO4J_URI="bolt://localhost:7689"; $env:NEO4J_USER="neo4j"; $env:NEO4J_PASSWORD="test1234"
npx vitest run
Remove-Item Env:\NEO4J_URI, Env:\NEO4J_USER, Env:\NEO4J_PASSWORD

# 4. Tear down.
docker stop graph-memory-test-neo4j
```

Expected output: `Test Files  N passed (N)` / `Tests  M passed (M)` with N matching the count of files in the table above and M growing as new tests are added; the full suite finishes in ~10 seconds.

## Why aren't env vars loaded from `.env` automatically?

Vitest does **not** read `.env`. The env vars in `.env` belong to the production `docker-compose.yml`; running tests against those credentials would aim them at your live Neo4j (the password in `.env` is the live one). The integration test's startup guard catches that case (`Refusing to run tests: the connected Neo4j has N node(s) outside the test-* tenant namespace`), but the cleaner habit is to provide test-only env on the command line.

If you find yourself running this often, set up a shell function or wrap it in an npm script — but don't add `.env` loading to the test setup; the explicit-env discipline is the data-safety layer.

## Common failure modes

### `Neo4jError: client is unauthorized due to authentication failure`

Tests connected to a real Neo4j but with the wrong password. Two causes:

- You forgot the `NEO4J_PASSWORD=...` prefix and the test fell back to the in-source default (`graph-memory-local`), which doesn't match your live deployment's password.
- You ran tests repeatedly with a wrong password and tripped Neo4j's auth-rate-limit lockout (the `client has provided incorrect authentication details too many times in a row` variant). The lockout outlasts even a corrected password — restart the Neo4j container to clear it.

Fix: stop the throwaway, restart it (`--rm` cleans state), and re-run with the correct env.

### `Refusing to run tests: the connected Neo4j has N node(s) outside the test-* tenant namespace`

The guard detected real data in the connected database. You probably forgot the `NEO4J_URI=...` prefix and connected to your live Neo4j on `:7687`. Fix: use the `:7689` throwaway. Or, if you really do want to run tests against a non-throwaway, set `ALLOW_DESTRUCTIVE_TESTS=1` — but only when you're sure.

### Tests hang on `beforeAll`

The throwaway container is still booting. Neo4j's bolt port comes up before auth is initialized, so the test can connect but get an auth error. The wait-for-ready loop in step 2 prevents this; if you skipped it, give it ~10–20 seconds and re-run.

## CI

`.github/workflows/ci.yml` defines a `Test` job that:

- Spins up a `neo4j:5.20-community` service container with `NEO4J_AUTH=neo4j/test1234` on `localhost:7687` (CI port can be the standard one because there's nothing else competing for it).
- Runs `npm ci && npm run build && npx vitest run` with `NEO4J_URI=bolt://localhost:7687`, `NEO4J_USER=neo4j`, `NEO4J_PASSWORD=test1234`.
- Required as a status check on `main` (branch ruleset 16067964).

If a PR fails CI but passes locally, the most common cause is a test that depends on undeclared env or filesystem state — re-run locally with **only** `NEO4J_*` env set (no `.env` sourced, no other graph-memory env) to mirror CI.

## Coverage

Coverage is measured with Vitest's [v8 provider](https://vitest.dev/guide/coverage.html) — no source instrumentation, just native V8 counters.

### Commands

| Command | What it does |
|---|---|
| `npm run test:coverage` | Run the full suite with coverage. Requires `NEO4J_*` env to be set (CI uses this). |
| `npm run test:local` | Spin up throwaway Neo4j, run the full suite, tear down. No coverage output. |
| `npm run test:coverage:local` | Spin up throwaway Neo4j, run the full suite **with coverage**, tear down. |

`npm run test:coverage:local` is the primary local command — it handles the Docker container dance automatically and prints coverage numbers at the end.

### Reporters

- **text** — console summary table printed at the end of every coverage run; visible in local output and in CI logs.
- **html** — browseable report written to `coverage/index.html`. Open it in a browser for line-by-line breakdown. The `coverage/` directory is gitignored.

### Local requirements

- Docker must be running. The scripts start a `neo4j:5.20-community` container on port `7689` and tear it down on exit (including Ctrl-C).
- The wrapper scripts use `bash`. On Windows, `bash` resolves to Git Bash, which ships with Git for Windows and is on PATH in any repo that uses git tooling. If `bash` is not on your PATH, invoke the PowerShell wrapper directly instead:
  ```powershell
  pwsh scripts/test-with-neo4j.ps1 --coverage
  ```

### CI

CI runs `npm run test:coverage` on every push and PR. The `NEO4J_*` env vars are already set on the `Test` job via the service container. Coverage numbers appear in the `Test` job log — no artifact upload, no threshold gate (measure first, decide later).
