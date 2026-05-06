"""
Sync the canonical dream prompt at prompts/dream-nightly.md to the live
scheduled-task SKILL.md, substituting absolute Windows paths for the
portable ~/ placeholders. Run after editing the canonical prompt.

Usage: python3 scripts/sync-dream-skill.py [--user-home <path>]
"""
import argparse
import os
import re
import sys
from pathlib import Path

DEFAULT_USER_HOME = os.path.expanduser("~")

FRONTMATTER = """---
name: nightly-graph-dream
description: Nightly graph memory dream process — ingest transcripts and documents, update knowledge graph, run decay maintenance. Hook errors (check-pending.js MODULE_NOT_FOUND) at session start are expected and harmless in remote sessions.
---

"""

# Path tokens we need to swap from portable ~/... to absolute paths.
PATH_RE = re.compile(r"~/(graph-memory|\.claude/projects)/[\w./<>*-]*")


def winify(home_dir: str):
    """Return a substitution callable that turns ~/<dir>/<rest> into
    <home>\\<dir>\\<rest> (Windows backslashes throughout)."""

    def _sub(match):
        s = match.group(0)
        if s.startswith("~/graph-memory/"):
            s = f"{home_dir}\\graph-memory\\" + s[len("~/graph-memory/"):]
        elif s.startswith("~/.claude/projects/"):
            s = f"{home_dir}\\.claude\\projects\\" + s[len("~/.claude/projects/"):]
        return s.replace("/", "\\")

    return _sub


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--user-home",
        default=DEFAULT_USER_HOME,
        help=f"User home directory to substitute. Default: {DEFAULT_USER_HOME}",
    )
    parser.add_argument(
        "--src",
        default="prompts/dream-nightly.md",
        help="Canonical prompt path (relative to repo root or absolute).",
    )
    parser.add_argument(
        "--dst",
        default=None,
        help="Output SKILL.md path. Default: <user-home>/.claude/scheduled-tasks/nightly-graph-dream/SKILL.md",
    )
    args = parser.parse_args()

    src = Path(args.src).resolve()
    dst = Path(
        args.dst
        or os.path.join(args.user_home, ".claude", "scheduled-tasks", "nightly-graph-dream", "SKILL.md")
    )

    if not src.exists():
        print(f"error: canonical prompt not found at {src}", file=sys.stderr)
        return 1

    content = src.read_text(encoding="utf-8")

    # Strip the canonical title heading (first line "# Graph Memory — Nightly Dream Process")
    lines = content.splitlines(keepends=True)
    body = "".join(lines[1:]).lstrip("\n")

    # Substitute portable paths with absolute ones
    body = PATH_RE.sub(winify(args.user_home), body)

    dst.parent.mkdir(parents=True, exist_ok=True)
    # IMPORTANT: write LF line endings even on Windows. Claude Desktop's
    # SKILL.md parser fails to recognize the YAML frontmatter when the file
    # uses CRLF, surfacing as "Task file not found or has unexpected format."
    with open(dst, "w", encoding="utf-8", newline="\n") as f:
        f.write(FRONTMATTER + body)
    print(f"wrote {dst}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
