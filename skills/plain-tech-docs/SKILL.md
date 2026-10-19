---
name: plain-tech-docs
description: Check and rewrite runbooks, READMEs and other technical docs so they read like a person wrote them, not a chatbot. Use when writing or reviewing Markdown docs, or when the user asks to de-slop, plain-English, or tighten documentation.
argument-hint: [file-or-folder ...] [--ignore CATEGORY]
---

The user wants technical documentation that sounds like an experienced engineer
wrote it: plain words, short sentences, no marketing voice.

Arguments: $ARGUMENTS

## Steps

1. Run the checker on the paths given (default: every `*.md` in the current
   repo):

   ```bash
   python3 ~/.claude/skills/plain-tech-docs/scripts/check_docs.py <paths>
   ```

   It prints `file:line:col: [category] "match" -> suggestion` and a summary.
   It skips fenced and inline code, link targets, HTML comments and front
   matter. Exit status 1 means it found something.

2. Read each finding in context before changing anything. The list is a
   prompt, not a rule: "just" in "just one flag" is fine, "robust" can be the
   right word in a statistics doc, and a long sentence inside a numbered step
   may be clearer than two. Leave correct uses alone.

3. When you rewrite, follow the rules below. Change prose only; never touch
   commands, code, config keys, version numbers, or link targets.

4. Re-run the checker and report what changed and what you left on purpose.

## Rules for the prose

- Say what the thing does. Replace "robust", "powerful", "seamless" with the
  concrete behavior ("retries three times", "restarts on crash").
- Use the short word: use, help, start, many, to. See
  [`references/word-list.md`](references/word-list.md) for the full list.
- One idea per sentence. Aim for under 25 words; the checker flags over 35.
- Cut throat-clearing: "It's worth noting", "In today's", "Let's dive in",
  "In conclusion". Start with the point.
- No em-dashes. Use a comma, colon, parentheses, or a new sentence.
- No exclamation marks in technical prose.
- Don't hedge with "simply", "easily", "basically". If a step is easy the
  reader will notice.
- Runbooks: imperative steps ("Restart the service"), one action per step,
  expected output after the command, and what to do if it differs.
- Keep the author's facts, structure and headings. This is an edit, not a
  rewrite.

## Tuning

- Skip a category: `--ignore hedge` (repeatable). Categories are the `##`
  headings in the word list plus `long-sentence`.
- Change the sentence limit: `--max-words 40`, or `0` to turn it off.
- Machine-readable output: `--format json`.
- Add or remove patterns by editing `references/word-list.md`. A bullet that
  starts with `re:` is a regular expression.
