"""
Sync canonical scheduled-task prompts to live SKILL.md files under
~/.claude/scheduled-tasks/<task-id>/SKILL.md, substituting absolute
Windows paths for the portable ~/ placeholders. Run after editing any
canonical prompt.

Source prompt files are resolved relative to --prompts-dir (default
"prompts" — i.e. the repo's prompts/ when run from the repo root). The
installer for non-developer users passes --prompts-dir ~/graph-memory/prompts
so the substitution reads from the entrypoint-seeded copy on the host.

Currently syncs:
  - <prompts-dir>/dream-nightly.md   → scheduled-tasks/nightly-graph-dream/SKILL.md
  - <prompts-dir>/weekly-maintenance.md → scheduled-tasks/weekly-graph-maintenance/SKILL.md

Usage:
  python3 scripts/sync-dream-skill.py [--user-home <path>] [--task <id>]
                                       [--prompts-dir <path>]

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


# Each entry: (task_id, source_prompt_filename, frontmatter_block)
# Filenames are resolved against --prompts-dir at runtime.
# The frontmatter is what Claude Code's scheduled-task runner expects in SKILL.md.
TASKS = [
    (
        "nightly-graph-dream",
        "dream-nightly.md",
        """---
name: nightly-graph-dream
description: Nightly graph memory dream process — ingest transcripts and documents, update knowledge graph, run decay maintenance. Hook errors (check-pending.js MODULE_NOT_FOUND) at session start are expected and harmless in remote sessions.
---

""",
    ),
    (
        "weekly-graph-maintenance",
        "weekly-maintenance.md",
        """---
name: weekly-graph-maintenance
description: Weekly graph memory maintenance — backup, health analysis, and prune (gated on backup success and a sanity check on prune count).
---

""",
    ),
]


def make_substituter(home_dir: str, use_backslashes: bool):
    """Return a substitution callable that expands ~/<dir>/<rest> to an
    absolute path under home_dir, using the OS-appropriate separator.

    - On Windows, use_backslashes=True produces e.g. C:\\Users\\you\\graph-memory\\...
    - On macOS/Linux, use_backslashes=False keeps forward slashes throughout
      and produces e.g. /Users/you/graph-memory/... or /home/you/graph-memory/...
    """

    sep = "\\" if use_backslashes else "/"

    def _sub(match):
        s = match.group(0)
        if s.startswith("~/graph-memory/"):
            rest = s[len("~/graph-memory/") :]
            s = f"{home_dir}{sep}graph-memory{sep}" + rest
        elif s.startswith("~/.claude/projects/"):
            rest = s[len("~/.claude/projects/") :]
            s = f"{home_dir}{sep}.claude{sep}projects{sep}" + rest
        # Normalize internal separators
        if use_backslashes:
            return s.replace("/", "\\")
        return s.replace("\\", "/")

    return _sub


def sync_one(
    task_id: str,
    src_filename: str,
    frontmatter: str,
    user_home: str,
    prompts_dir: Path,
    use_backslashes: bool,
) -> int:
    src = (prompts_dir / src_filename).resolve()
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

    # Substitute portable paths with absolute ones (OS-specific separators)
    body = PATH_RE.sub(make_substituter(user_home, use_backslashes), body)

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
    parser.add_argument(
        "--prompts-dir",
        default="prompts",
        help="Directory containing canonical prompt .md files. Default: 'prompts' (repo-relative). The installer passes '~/graph-memory/prompts' for end-user installs.",
    )
    parser.add_argument(
        "--os",
        choices=["auto", "windows", "unix"],
        default="auto",
        help="Path separator style. 'auto' (default) detects from the runtime platform. Use 'windows' to force backslashes (e.g. when running this script inside Linux Docker on behalf of a Windows host) or 'unix' to force forward slashes.",
    )
    args = parser.parse_args()
    prompts_dir = Path(os.path.expanduser(args.prompts_dir)).resolve()
    if args.os == "auto":
        use_backslashes = os.name == "nt"
    else:
        use_backslashes = args.os == "windows"

    targets = TASKS if args.task is None else [t for t in TASKS if t[0] == args.task]
    if args.task is not None and not targets:
        known = ", ".join(t[0] for t in TASKS)
        print(f"error: unknown task '{args.task}'. Known: {known}", file=sys.stderr)
        return 2

    rc = 0
    for task_id, src_filename, frontmatter in targets:
        rc |= sync_one(
            task_id,
            src_filename,
            frontmatter,
            args.user_home,
            prompts_dir,
            use_backslashes,
        )
    return rc


if __name__ == "__main__":
    sys.exit(main())
