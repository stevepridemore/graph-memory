---
name: graph-capture
description: End-of-session catch-up for the memory graph. Reviews the current conversation and writes any new entities, edges, decisions, or facts that weren't already captured in flight. Use before closing a long claude.ai or Desktop conversation, or any time you want to commit recent context to long-term memory.
argument-hint: [--dry-run] [--topic <focus>] [--since-message <uuid>]
---

The user wants to capture the current conversation to the memory graph. Many conversations contribute knowledge that the dream process can't see (claude.ai web and Desktop chats live server-side, not in the local transcript store the dream walks). This command is the manual catch-up: review what we just talked about, find what hasn't already been written to the graph, and write it.

Arguments: $ARGUMENTS

Parse:
- `--dry-run` — describe what you would write without calling write tools. Useful to review before committing.
- `--topic <focus>` — focus capture on entities/relationships related to a specific topic mentioned in the conversation. Skip unrelated material. Default: capture everything substantive.
- `--since-message <uuid>` — only consider messages from that point onward. Default: whole conversation.

## Steps

### 1. Inventory candidate entities and relationships

Walk the conversation (or the slice indicated by `--since-message` / `--topic`) and list every distinct candidate that meets the "worth writing" bar:

- **People** named with role, organization, or relationship context — not just casual references
- **Projects** worked on, evaluated, or referenced with meaningful context
- **Technologies / Concepts** the user used, evaluated, decided about, or expressed a preference toward
- **Preferences** explicitly stated ("I prefer X", "always use Y") or strongly implied through repeated choice
- **Decisions** made with reasoning ("we decided X because Y") — both explicit and clear inferred decisions
- **Facts** about infrastructure, processes, configuration, or the user's environment
- **Events** — meetings, deployments, incidents, milestones with dates or outcomes
- **Objects** — specific repos, servers, databases, tools, containers
- **Reasoning traces** — *how* a problem was solved, especially if there were dead ends or alternatives considered. Capture the trace, not just the outcome.

Skip:
- Conversation mechanics ("let me read that file", "running the test now")
- Trivial mentions without significance
- API keys, passwords, tokens, connection strings, or any secret value (note existence only, never the value)

### 2. Check what's already in the graph (search-first, three-way branch)

For every candidate, run **both** lookups before deciding what to do — a single exact-name check misses near-duplicates:

1. **`graph_search`** with the candidate's name + a brief paraphrase as the query. Semantic similarity will find entities under different names ("Cloudflare Tunnel for graph-memory" vs "Cloudflare Tunnel (graph-memory)" vs "graph-memory tunnel" all hit each other at high similarity)
2. **`graph_entities`** with the candidate's exact name string for the strict match

Combine the results and classify the candidate into one of **three** states (not two):

| State | Trigger | Action |
|---|---|---|
| **A. Not in graph** | Both lookups empty (or top hits are clearly different concepts) | Queue for creation |
| **B. In graph, conversation aligns or extends** | Existing entity matches, conversation reinforces or adds new edges to it | Reuse the existing entity. Queue any new edges. If nothing new beyond a re-mention, `graph_boost` (+0.05) on the strongest existing edge |
| **C. In graph, conversation contradicts** | Existing entity matches, but the conversation says the existing facts are now wrong (e.g. user corrected something, or talked about a deprecated state) | **Invalidate first, then create.** See "Handling corrections" below |

When `graph_search` returns a top hit at score ≥ 0.85 with a name that's a near-paraphrase (different word order, parenthesization, prepositions, hyphenation), **always treat as state B or C — never create a duplicate.** If you're unsure, surface the candidate to the user: *"This looks like the existing entity 'X' — should I merge or create new?"*

### 2b. Handling corrections (state C)

If the conversation contradicts an existing fact, **do not** just write a new contradicting edge alongside the old one — that strengthens the old edge by bumping its `last_confirmed`, and queries will return both. The right pattern:

1. Identify the specific old edges that are now wrong (use `graph_query` on the entity to enumerate)
2. **Invalidate** each wrong edge by calling `graph_relate` with the SAME from/to/relation but adding `valid_at` set to the time the old fact stopped being true (the migration date, the moment of correction, etc.) — `graph_relate` then sets `invalid_at` on the predecessor and creates the new "version" — see the supersession behaviour described in `dream-nightly.md`
3. If the entity should be entirely retired (the concept no longer applies), `graph_delete` it and skip step 2
4. Only after invalidation, create the new entities and edges representing the corrected reality

For Decision-vs-Decision succession, use `SUPERSEDES` **in one direction only**: `(new_decision)-[SUPERSEDES]->(old_decision)`. Never write the reverse. SUPERSEDES is read as "the new decision replaces the old one."

For entity-level rename or re-categorization (same thing, different name), use `ALIAS_OF` — link the redundant entity to the canonical one rather than maintaining two parallel records.

### 3. Plan the relationships

Connect the captured entities to each other and to existing graph entities the conversation touched on. Don't create islands — if the user mentioned that Project X depends on Library Y, write the `DEPENDS_ON` edge even if both already existed individually.

Use canonical relationship types (`WORKS_ON`, `WORKS_AT`, `REPORTS_TO`, `STAKEHOLDER_IN`, `PREFERS`, `KNOWS_ABOUT`, `DEPENDS_ON`, `USES_TECH`, `USES`, `DECIDED_FOR`, `CONTRADICTS`, `RELATED_TO`, `ALIAS_OF`, `PARTICIPATED_IN`, `OCCURRED_DURING`, `LED_TO`, `INVOLVED_IN`, etc.) over inventing new types. For `RELATED_TO`, pick a `relationship_type` subtype: `similar_to`, `part_of`, `enables`, `impacts`, `depends_on`, `alternative_to`, `derived_from`, `implements`, `extends`, `configured_by`.

If a genuinely new pattern emerges that doesn't fit anything in the canonical set, surface it to the user and ask before inventing — don't accumulate ad-hoc synonyms.

### 4. Apply weight guidelines

| Origin | Starting weight |
|---|---|
| User explicitly stated | 0.7 |
| Strongly inferred from conversation context | 0.5 |
| Loosely inferred / single passing mention | 0.3 |
| User confirmed something already in the graph | use `graph_boost` (+0.15) instead |
| User corrected something the graph had wrong | use `graph_weaken` (-0.3) on the wrong edge, then `graph_relate` for the corrected fact |

Capture aliases and identifying details inline in the edge `evidence` string when the source mentioned them. Examples: "Andrew McElroy (nickname Tripp, initials AHM)", "Domino 14.5.1 (the version that introduced DominoIQ)". This makes future fuzzy matching much better.

### 5. Write to the graph (unless --dry-run)

Use `graph_relate` in **batch mode** for efficiency. Always include provenance:

- `source_type`: `"conversation"`
- `source_session`: a stable identifier — Claude Code session id if you have it, otherwise something like `"claude-ai-capture-<ISO-date>"` so audit log entries can be grouped

**Critical: don't accidentally re-confirm wrong edges.** Calling `graph_relate` with the same `(from, to, relation)` triple as an existing edge will MERGE — it bumps the existing edge's `last_confirmed` to "now", which on the decay curve treats it as freshly reinforced. If your goal is to mark a fact as no-longer-true, use the supersession pattern from step 2b (set `valid_at` on the new replacement so the old one gets `invalid_at`), or call `graph_weaken` to drop weight, or `graph_delete` to remove the entity entirely. Never update a wrong edge by writing a contradicting one alongside.

For `--dry-run`, instead of calling write tools, print a human-readable summary of what would be written:
```
Would create:
  - Andrew McElroy (Person) — Assistant General Counsel at FBBE
  - DominoIQ POC October Timeline (Decision) — confidence 0.7
Would link:
  - Andrew McElroy -[STAKEHOLDER_IN, weight 0.6]-> DominoIQ POC
  - ...
Would boost (already in graph):
  - Tara Newman: confirmed mentioned in DominoIQ context — +0.05
```

### 6. Validate after writing

After the batch, call `graph_validate` with the `source_session` you used. For high-severity issues:
- **Generic or reference-language names** (e.g. "the server", "this project"): delete with `graph_delete` and re-extract more carefully
- **Near-duplicates that are clearly the same**: link with `graph_relate ALIAS_OF`

For medium/low severity issues: report them to the user as "flagged for review."

### 7. Report back

Tell the user what was captured:

```
Captured to graph:
  - 4 new entities (2 Person, 1 Decision, 1 Project)
  - 7 new edges
  - 3 existing entities boosted
  - 1 flagged for review: "the deployment" — too generic, suggest a more specific name
```

If `--dry-run` was used, end with: "Run `/graph-capture` (no flags) to commit."

## Rules

1. **Capture, don't speculate.** Only write what the conversation actually established. If you're guessing what the user meant, don't write it.
2. **Search before creating — use semantic similarity, not just exact match.** `graph_search` is the primary lookup; `graph_entities` is the strict-match secondary. Names that differ only in word order, parens, or prepositions ("Cloudflare Tunnel for graph-memory" vs "Cloudflare Tunnel (graph-memory)") are duplicates. If unsure, ask the user to confirm before creating.
3. **Corrections require invalidation, not just contradiction.** If the conversation says the graph has something wrong, identify the specific old edges and invalidate them via the supersession pattern (or `graph_weaken` / `graph_delete`). Writing a new contradicting edge while leaving the wrong one intact is worse than not capturing — it leaves the graph in a state where queries return both versions, with the wrong one freshly reinforced via `last_confirmed`.
4. **SUPERSEDES is one-directional.** `(new)-[SUPERSEDES]->(old)`, never the reverse, never both.
5. **Never extract secrets.** API keys, passwords, tokens, connection strings, private keys, signed URLs — none of these go into entity properties or edge evidence. Note that a credential exists ("Project X uses an API key for service Y") but never the value.
6. **Stay silent if there's nothing new.** If after reviewing the conversation you find nothing worth capturing (because everything was already written in flight, or because the conversation was purely mechanical), just say "Nothing new to capture — the conversation's facts are already in the graph."
7. **Dry-run for long conversations.** If the conversation is large (50+ messages) and you're about to write 20+ entities, run the dry-run path internally and present the plan to the user for confirmation before committing the batch — saves them from a runaway capture they didn't expect.

## Why this exists

The nightly dream process extracts knowledge from Claude Code transcripts (`~/.claude/projects/*/*.jsonl`) but cannot see claude.ai web conversations or Claude Desktop chats — those live server-side or in Electron app data, not in the local file store the dream walks. This skill closes that loop: explicit, on-demand capture before a conversation is lost or scrolled away. Run it at the end of any substantive conversation in claude.ai or Desktop where you spent real thought and want it preserved.
