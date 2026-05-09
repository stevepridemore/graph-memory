$ErrorActionPreference = 'Stop'

$Container = 'graph-memory-test-neo4j'
$Port = 7689

# Idempotent: remove any leftover container from a previous run.
$existing = docker ps -a --format '{{.Names}}' 2>$null | Where-Object { $_ -eq $Container }
if ($existing) {
    Write-Host "[test-with-neo4j] Removing existing container: $Container"
    docker rm -f $Container | Out-Null
}

# Spin up throwaway Neo4j.
Write-Host "[test-with-neo4j] Starting Neo4j on port ${Port}..."
docker run -d --name $Container --rm `
    -p "${Port}:7687" `
    -e NEO4J_AUTH=neo4j/test1234 `
    -e 'NEO4J_PLUGINS=["apoc"]' `
    neo4j:5.20-community | Out-Null

# Wait for Neo4j to accept connections (max 60 s).
Write-Host "[test-with-neo4j] Waiting for Neo4j to be ready..."
$elapsed = 0
$ready = $false
while (-not $ready) {
    $result = docker exec $Container cypher-shell -u neo4j -p test1234 "RETURN 1;" 2>$null
    if ($LASTEXITCODE -eq 0) {
        $ready = $true
    } elseif ($elapsed -ge 60) {
        Write-Error "[test-with-neo4j] ERROR: Neo4j did not become ready within 60 s."
        docker rm -f $Container | Out-Null
        exit 1
    } else {
        Start-Sleep -Seconds 2
        $elapsed += 2
    }
}
Write-Host "[test-with-neo4j] Neo4j is ready."

# Export test credentials.
$env:NEO4J_URI = "bolt://localhost:${Port}"
$env:NEO4J_USER = 'neo4j'
$env:NEO4J_PASSWORD = 'test1234'

# Run vitest, forwarding all arguments (e.g. --coverage).
$exitCode = 0
try {
    npx vitest run @args
    $exitCode = $LASTEXITCODE
} catch {
    $exitCode = 1
} finally {
    Write-Host "[test-with-neo4j] Tearing down container: $Container"
    docker stop $Container 2>$null | Out-Null
    Remove-Item Env:\NEO4J_URI, Env:\NEO4J_USER, Env:\NEO4J_PASSWORD -ErrorAction SilentlyContinue
}

exit $exitCode
