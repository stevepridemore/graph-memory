"""
Sync canonical scheduled-task prompts in prompts/ to live SKILL.md files
under ~/.claude/scheduled-tasks/<task-id>/SKILL.md, substituting absolute
Windows paths for the portable ~/ placeholders. Run after editing any
canonical prompt.

Currently syncs:
  - prompts/dream-nightly.md   → scheduled-tasks/nightly-graph-dream/SKILL.md
  - prompts/weekly-maintenance.md → scheduled-tasks/weekly-graph-maintenance/SKILL.md

Usage:
  python3 scripts/sync-dream-skill.py [--user-home <path>] [--task <id>]

Without --task, syncs all known tasks. With --task <id>, syncs only that one.
"""
import argparse
import os
import re
import sys
from pathlib import Path

DEFAULT_USER_HOME = os.path.expanduser("~")

# Path tokens we need to swap from portable ~/... to absolute paths.
PATH_RE = re.compile(r"~/(graph-memory|\.claude/projects)/[\w./<>*-]*")


# Each entry: (task_id, source_prompt_path, frontmatter_block)
# The frontmatter is what Claude Code's scheduled-task runner expects in SKILL.md.
TASKS = [
    (
        "nightly-graph-dream",
        "prompts/dream-nightly.md",
        """---
name: nightly-graph-dream
description: Nightly graph memory dream process — ingest transcripts and documents, update knowledge graph, run decay maintenance. Hook errors (check-pending.js MODULE_NOT_FOUND) at session start are expected and harmless in remote sessions.
---

""",
    ),
    (
        "weekly-graph-maintenance",
        "prompts/weekly-maintenance.md",
        """---
name: weekly-graph-maintenance
description: Weekly graph memory maintenance — backup, health analysis, and prune (gated on backup success and a sanity check on prune count).
---

""",
    ),
]


def winify(home_dir: str):
    """Return a substitution callable that turns ~/<dir>/<rest> into
    <home>\\<dir>\\<rest> (Windows backslashes throughout)."""

    def _sub(match):
        s = match.group(0)
        if s.startswith("~/graph-memory/"):
            s = f"{home_dir}\\graph-memory\\" + s[len("~/graph-memory/") :]
        elif s.startswith("~/.claude/projects/"):
            s = f"{home_dir}\\.claude\\projects\\" + s[len("~/.claude/projects/") :]
        return s.replace("/", "\\")

    return _sub


def sync_one(task_id: str, src_path: str, frontmatter: str, user_home: str) -> int:
    src = Path(src_path).resolve()
    dst = Path(
        os.path.join(user_home, ".claude", "scheduled-tasks", task_id, "SKILL.md")
    )

    if not src.exists():
        print(f"error: canonical prompt not found at {src}", file=sys.stderr)
        return 1

    content = src.read_text(encoding="utf-8")

    # Strip the canonical title heading (first line, e.g. "# Graph Memory — Nightly Dream Process")
    lines = content.splitlines(keepends=True)
    body = "".join(lines[1:]).lstrip("\n")

    # Substitute portable paths with absolute ones
    body = PATH_RE.sub(winify(user_home), body)

    dst.parent.mkdir(parents=True, exist_ok=True)
    # IMPORTANT: write LF line endings even on Windows. Claude Desktop's
    # SKILL.md parser fails to recognize the YAML frontmatter when the file
    # uses CRLF, surfacing as "Task file not found or has unexpected format."
    with open(dst, "w", encoding="utf-8", newline="\n") as f:
        f.write(frontmatter + body)
    print(f"wrote {dst}")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--user-home",
        default=DEFAULT_USER_HOME,
        help=f"User home directory to substitute. Default: {DEFAULT_USER_HOME}",
    )
    parser.add_argument(
        "--task",
        default=None,
        help="Sync only the named task (e.g. nightly-graph-dream, weekly-graph-maintenance). Default: all.",
    )
    args = parser.parse_args()

    targets = TASKS if args.task is None else [t for t in TASKS if t[0] == args.task]
    if args.task is not None and not targets:
        known = ", ".join(t[0] for t in TASKS)
        print(f"error: unknown task '{args.task}'. Known: {known}", file=sys.stderr)
        return 2

    rc = 0
    for task_id, src_path, frontmatter in targets:
        rc |= sync_one(task_id, src_path, frontmatter, args.user_home)
    return rc


if __name__ == "__main__":
    sys.exit(main())
