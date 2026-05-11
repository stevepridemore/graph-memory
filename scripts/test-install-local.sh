#!/usr/bin/env bash
# Tier-1 local test: runs install-primary.sh against the working tree without
# touching GitHub. Patches the install script's URLs to file:// and uses a
# sandboxed $HOME so it cannot disturb your real ~/.claude or ~/graph-memory.
#
# Run this INSIDE the test environment (WSL clone, Linux VM, etc.). The repo
# must be reachable via REPO_DIR (default: $PWD if it looks like the repo,
# else /mnt/c/Users/<you>/Documents/Projects/graph-memory).
#
# Usage:
#   bash scripts/test-install-local.sh [REPO_DIR]

set -euo pipefail

REPO_DIR="${1:-${REPO_DIR:-$PWD}}"
if [ ! -f "$REPO_DIR/scripts/install-primary.sh" ]; then
  echo "ERROR: scripts/install-primary.sh not found under $REPO_DIR" >&2
  echo "Pass the repo path: bash test-install-local.sh /path/to/graph-memory" >&2
  exit 2
fi

SANDBOX="$(mktemp -d -t gm-install-test.XXXXXX)"
FAKE_HOME="$SANDBOX/home"
TARBALL="$SANDBOX/release.tar.gz"
PATCHED="$SANDBOX/install-primary-patched.sh"
mkdir -p "$FAKE_HOME"

echo "[test] repo dir : $REPO_DIR"
echo "[test] sandbox  : $SANDBOX"
echo "[test] fake HOME: $FAKE_HOME"

# 1. Build a release tarball from the working tree. Uses `tar` (not
#    `git archive`) so we capture uncommitted files too — that's how we test
#    new things before they're committed. Excludes .git, node_modules, dist,
#    and coverage to match what GitHub's release tarball would actually ship.
TARBALL_PREFIX="graph-memory-0.3.0-test"
echo "[debug] before tar: ls $(dirname "$REPO_DIR")/$(basename "$REPO_DIR")/skills:"
ls "$(dirname "$REPO_DIR")/$(basename "$REPO_DIR")/skills" 2>&1 | head -5
echo "[debug] direct: ls $REPO_DIR/skills:"
ls "$REPO_DIR/skills" 2>&1 | head -5
( cd "$(dirname "$REPO_DIR")" && tar -czf "$TARBALL" \
    --transform "s|^$(basename "$REPO_DIR")|${TARBALL_PREFIX}|" \
    --exclude="$(basename "$REPO_DIR")/.git" \
    --exclude="$(basename "$REPO_DIR")/node_modules" \
    --exclude="$(basename "$REPO_DIR")/dist" \
    --exclude="$(basename "$REPO_DIR")/coverage" \
    --exclude="$(basename "$REPO_DIR")/docs/internal" \
    "$(basename "$REPO_DIR")" )
echo "[test] tarball  : $(du -h "$TARBALL" | cut -f1) at $TARBALL"
# Sanity: skills/ must be in the tarball or the verification will fail spuriously.
# Note: avoid `tar -tzf | grep -q` here. With `set -o pipefail`, grep -q's early
# exit triggers SIGPIPE on tar, the pipeline returns non-zero, and the check
# fires a false negative. Materialize the listing first, then grep on the file.
TARBALL_LIST="$SANDBOX/tarball.txt"
tar -tzf "$TARBALL" > "$TARBALL_LIST"
if ! grep -q "^${TARBALL_PREFIX}/skills/graph/SKILL.md$" "$TARBALL_LIST"; then
  echo "ERROR: skills/ not in tarball — fix the build" >&2
  echo "[debug] looked for: ${TARBALL_PREFIX}/skills/graph/SKILL.md" >&2
  echo "[debug] skills entries actually present:" >&2
  grep "/skills/" "$TARBALL_LIST" | head -10 >&2 || echo "[debug]   (none)" >&2
  exit 1
fi

# 2. Patch the install script to use file:// URLs for everything.
#    - $RAW points at a directory served by file:// (curl supports that)
#    - $TARBALL points at the local tar file
cp "$REPO_DIR/scripts/install-primary.sh" "$PATCHED"
sed -i \
  -e 's|https://raw.githubusercontent.com/$REPO/$VERSION|file://'"$REPO_DIR"'|g' \
  -e 's|https://github.com/$REPO/archive/refs/tags/$VERSION.tar.gz|file://'"$TARBALL"'|g' \
  -e 's|https://github.com/$REPO/archive/refs/heads/main.tar.gz|file://'"$TARBALL"'|g' \
  -e 's|graph-memory-${VERSION#v}|'"$TARBALL_PREFIX"'|g' \
  "$PATCHED"

# 3. Drop the Docker pre-flight check for this test — we're only validating
#    the file-layout half of the installer here, not docker compose up.
#    (To do an end-to-end docker test, run without this neutering on a host
#    that has Docker installed.)
if [ "${SKIP_DOCKER_CHECK:-1}" = "1" ]; then
  sed -i 's|^if ! command -v docker.*|if false; \&\&|' "$PATCHED"
  # The previous sed leaves the file syntactically broken; use a more careful
  # patch instead — comment out the entire pre-flight block.
  cp "$REPO_DIR/scripts/install-primary.sh" "$PATCHED"
  sed -i \
    -e 's|https://raw.githubusercontent.com/$REPO/$VERSION|file://'"$REPO_DIR"'|g' \
    -e 's|https://github.com/$REPO/archive/refs/tags/$VERSION.tar.gz|file://'"$TARBALL"'|g' \
    -e 's|https://github.com/$REPO/archive/refs/heads/main.tar.gz|file://'"$TARBALL"'|g' \
    -e 's|graph-memory-${VERSION#v}|'"$TARBALL_PREFIX"'|g' \
    "$PATCHED"
  # Now neutralize the docker block by replacing the conditional with a true:
  python3 - "$PATCHED" <<'PYEOF'
import re, sys, pathlib
p = pathlib.Path(sys.argv[1])
t = p.read_text()
# Replace the whole pre-flight Docker block from `# 0. Pre-flight` up to the
# `echo "[install-primary] docker: OK"` line with a stubbed-out echo.
t = re.sub(
    r"# 0\. Pre-flight.*?echo \"\[install-primary\] docker: OK\"\n",
    'echo "[install-primary] docker: SKIPPED (test mode)"\n',
    t,
    count=1,
    flags=re.S,
)
p.write_text(t)
PYEOF
fi
chmod +x "$PATCHED"

# 4. Run the patched installer with HOME redirected to the sandbox
echo
echo "[test] === running patched installer ==="
HOME="$FAKE_HOME" bash "$PATCHED" v0.3.0-test
INSTALL_RC=$?

echo
echo "[test] === verification ==="

# Expected files
PASS=0
FAIL=0
check() {
  if [ -e "$1" ]; then
    echo "  ✓ $1"
    PASS=$((PASS+1))
  else
    echo "  ✗ MISSING: $1"
    FAIL=$((FAIL+1))
  fi
}

check "$FAKE_HOME/graph-memory/docker-compose.yml"
check "$FAKE_HOME/graph-memory/.env"
check "$FAKE_HOME/.claude/.mcp.json"
check "$FAKE_HOME/.claude/skills/graph/SKILL.md"
check "$FAKE_HOME/.claude/skills/graph-stats/SKILL.md"
check "$FAKE_HOME/.claude/skills/ingest/SKILL.md"

# Skill content sanity — none of the personal-data leaks should be present
LEAKS=$(grep -rilE 'doublec|\bsprid\b|AppData' "$FAKE_HOME/.claude/skills/" 2>/dev/null || true)
if [ -z "$LEAKS" ]; then
  echo "  ✓ skills are clean of personal-data / AppData refs"
  PASS=$((PASS+1))
else
  echo "  ✗ skills contain leaks:"
  echo "$LEAKS" | sed 's/^/      /'
  FAIL=$((FAIL+1))
fi

# .env should be the template (still has placeholder values)
if grep -q "replace-with-a-strong-password" "$FAKE_HOME/graph-memory/.env"; then
  echo "  ✓ .env is template (user must edit before docker compose up)"
  PASS=$((PASS+1))
else
  echo "  ✗ .env doesn't look like the template"
  FAIL=$((FAIL+1))
fi

echo
echo "[test] PASS=$PASS  FAIL=$FAIL  installer_rc=$INSTALL_RC"
echo "[test] sandbox kept for inspection at: $SANDBOX"
echo "[test] cleanup:  rm -rf $SANDBOX"

[ "$FAIL" -eq 0 ] && [ "$INSTALL_RC" -eq 0 ]
