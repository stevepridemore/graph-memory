#!/usr/bin/env python3
"""Flag AI-sounding prose in Markdown docs and runbooks.

Usage:
    check_docs.py [options] PATH [PATH ...]

PATH can be a file or a directory (scanned recursively for *.md).
Patterns come from ../references/word-list.md. Fenced code blocks,
inline code, link targets, HTML comments and YAML front matter are
skipped, so commands and identifiers are never flagged. Text in double
quotes is skipped too, since docs quote phrases as examples.

Exit status is 1 when any finding is reported, 0 otherwise.
Stdlib only.
"""

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, asdict

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_WORD_LIST = os.path.join(HERE, "..", "references", "word-list.md")
SKIP_DIRS = {".git", "node_modules", "dist", "build", ".venv", "venv", "__pycache__"}


@dataclass
class Pattern:
    category: str
    label: str
    regex: re.Pattern
    fix: str


@dataclass
class Finding:
    path: str
    line: int
    col: int
    category: str
    match: str
    fix: str


def load_patterns(path):
    patterns = []
    category = None
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.rstrip("\n")
            if line.startswith("## "):
                category = line[3:].strip()
                continue
            if category is None or not line.startswith("- "):
                continue
            entry, _, fix = line[2:].partition(" -> ")
            entry = entry.strip()
            if entry.startswith("re:"):
                src = entry[3:]
                label = src
            else:
                # Literal phrase: word boundaries, flexible whitespace,
                # straight or curly apostrophe.
                src = r"\b" + r"\s+".join(re.escape(w) for w in entry.split()) + r"\b"
                src = src.replace("'", "['’]")
                label = entry
            patterns.append(Pattern(category, label, re.compile(src, re.IGNORECASE), fix.strip()))
    return patterns


INLINE_CODE = re.compile(r"(`+)(.+?)\1")
LINK_TARGET = re.compile(r"\]\([^)]*\)")
AUTOLINK = re.compile(r"<https?://[^>]+>|https?://\S+")
HTML_COMMENT = re.compile(r"<!--.*?-->")
# Quoted text is usually an example of what not to write, not prose.
QUOTED = re.compile(r"\"[^\"\n]{1,80}\"|\u201c[^\u201d\n]{1,80}\u201d")
TABLE_RULE = re.compile(r"^\s*\|?\s*:?-{3,}")


def blank(m):
    return " " * len(m.group(0))


def prose_lines(text):
    """Yield (line_number, line) with code and markup masked to spaces.

    Masking keeps column numbers accurate in the report.
    """
    in_fence = None
    in_comment = False
    lines = text.splitlines()
    start = 0
    if lines and lines[0].strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() in ("---", "..."):
                start = i + 1
                break
    for i in range(start, len(lines)):
        line = lines[i]
        stripped = line.lstrip()
        fence = re.match(r"(`{3,}|~{3,})", stripped)
        if in_fence:
            if fence and stripped.startswith(in_fence):
                in_fence = None
            continue
        if fence:
            in_fence = fence.group(1)
            continue
        if line.startswith("    ") or line.startswith("\t"):
            continue  # indented code block
        if in_comment:
            if "-->" in line:
                in_comment = False
                line = " " * (line.index("-->") + 3) + line[line.index("-->") + 3:]
            else:
                continue
        if "<!--" in line and "-->" not in line[line.index("<!--"):]:
            in_comment = True
            line = line[: line.index("<!--")]
        if TABLE_RULE.match(line):
            continue
        for rx in (HTML_COMMENT, INLINE_CODE, LINK_TARGET, AUTOLINK, QUOTED):
            line = rx.sub(blank, line)
        yield i + 1, line


SENTENCE_SPLIT = re.compile(r"(?<=[.?!])\s+(?=[A-Z])")


def long_sentences(lineno, line, limit):
    text = re.sub(r"^\s*(#+|[-*+]|\d+\.|>)\s*", "", line)
    if text.lstrip().startswith("|"):
        return []
    found = []
    for sentence in SENTENCE_SPLIT.split(text):
        words = sentence.split()
        if len(words) > limit:
            col = line.find(sentence[:20]) + 1 if sentence.strip() else 1
            found.append((col, f"{len(words)} words: {' '.join(words[:8])} ..."))
    return found


def scan_file(path, patterns, max_words, ignore):
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except (OSError, UnicodeDecodeError) as e:
        print(f"{path}: skipped ({e})", file=sys.stderr)
        return []
    findings = []
    for lineno, line in prose_lines(text):
        for p in patterns:
            if p.category in ignore:
                continue
            for m in p.regex.finditer(line):
                findings.append(Finding(path, lineno, m.start() + 1, p.category, m.group(0), p.fix))
        if max_words and "long-sentence" not in ignore:
            for col, desc in long_sentences(lineno, line, max_words):
                findings.append(Finding(path, lineno, col, "long-sentence", desc,
                                        f"split into sentences under {max_words} words"))
    return findings


def iter_files(paths):
    for p in paths:
        if os.path.isdir(p):
            for root, dirs, files in os.walk(p):
                dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
                for name in sorted(files):
                    if name.lower().endswith((".md", ".markdown")):
                        yield os.path.join(root, name)
        else:
            yield p


def main(argv=None):
    ap = argparse.ArgumentParser(description="Flag AI-sounding prose in Markdown docs.")
    ap.add_argument("paths", nargs="+", help="files or directories to scan")
    ap.add_argument("--word-list", default=DEFAULT_WORD_LIST, help="pattern file (default: bundled list)")
    ap.add_argument("--ignore", action="append", default=[], metavar="CATEGORY",
                    help="skip a category (repeatable), e.g. --ignore hedge")
    ap.add_argument("--max-words", type=int, default=35,
                    help="flag sentences longer than this; 0 disables (default 35)")
    ap.add_argument("--format", choices=("text", "json"), default="text")
    args = ap.parse_args(argv)

    patterns = load_patterns(args.word_list)
    ignore = set(args.ignore)
    findings = []
    files = 0
    own_list = os.path.realpath(args.word_list)
    for path in iter_files(args.paths):
        if os.path.realpath(path) == own_list:
            continue  # the word list would flag every entry in itself
        files += 1
        findings.extend(sorted(scan_file(path, patterns, args.max_words, ignore),
                               key=lambda f: (f.line, f.col)))

    if args.format == "json":
        json.dump([asdict(f) for f in findings], sys.stdout, indent=2)
        print()
    else:
        for f in findings:
            print(f"{f.path}:{f.line}:{f.col}: [{f.category}] \"{f.match}\" -> {f.fix}")
        counts = {}
        for f in findings:
            counts[f.category] = counts.get(f.category, 0) + 1
        summary = ", ".join(f"{k} {v}" for k, v in sorted(counts.items())) or "clean"
        print(f"\n{len(findings)} finding(s) in {files} file(s): {summary}")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
